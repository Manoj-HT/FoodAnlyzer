import uuid
import json
import os
import io
import tempfile
import time
import re
import urllib.request
import urllib.parse
from typing import Dict, Optional
from fastapi import FastAPI, HTTPException, status, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr

try:
    import torch
    from transformers import pipeline
    from PIL import Image
    HAS_ML = True
except ImportError:
    HAS_ML = False

# ========================================================
# LLM CONFIGURATION FLAGS
# ========================================================
# Choose preferred provider: "gemini", "ollama", or "fallback"
LLM_PROVIDER = "ollama"  # Set to "gemini" or "ollama" to use LLMs
OLLAMA_MODEL = "gemma3:4b"
OLLAMA_API_URL = "http://localhost:11434/api/generate"

app = FastAPI(title="FoodAnalyzer API")

# Enable CORS for Angular Frontend running on http://localhost:4200
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-Memory DB Models
class UserInDB:
    def __init__(self, name: str, email: str, password: str):
        self.id = str(uuid.uuid4())
        self.name = name
        self.email = email
        self.password = password
        self.confirmed = False
        self.token = f"tok_{uuid.uuid4().hex[:16]}"
        self.report_cache = {}
        self.insights = []
        self.last_insight_generated_time = ""
        self.insight_version = 0
        self.structured_details = {}



# Global in-memory user database
# Keys: email (for lookup), values: UserInDB
USERS_BY_EMAIL: Dict[str, UserInDB] = {}
# Keys: user_id (for lookup), values: UserInDB
USERS_BY_ID: Dict[str, UserInDB] = {}

DB_FILE = os.path.join(os.path.dirname(__file__), "users.json")

def save_to_json():
    data = {}
    for uid, user in USERS_BY_ID.items():
        data[uid] = {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "password": user.password,
            "confirmed": user.confirmed,
            "token": user.token,
            "report_cache": getattr(user, 'report_cache', {}),
            "insights": getattr(user, 'insights', []),
            "last_insight_generated_time": getattr(user, 'last_insight_generated_time', ""),
            "insight_version": getattr(user, 'insight_version', 0),
            "structured_details": getattr(user, 'structured_details', {})
        }
    with open(DB_FILE, "w") as f:
        json.dump(data, f, indent=4)

def load_from_json():
    global USERS_BY_EMAIL, USERS_BY_ID
    if not os.path.exists(DB_FILE):
        # Seed initial mock data for login testing if needed
        mock_user = UserInDB(
            name="Jane Doe",
            email="jane@example.com",
            password="password123"
        )
        mock_user.structured_details = run_fallback_user_analysis(
            "I am a 30-year-old nurse. I love running, high protein meals, and want to lose weight.", []
        )["structured_details"]
        USERS_BY_EMAIL[mock_user.email] = mock_user
        USERS_BY_ID[mock_user.id] = mock_user
        save_to_json()
        return

    try:
        with open(DB_FILE, "r") as f:
            data = json.load(f)
        needs_resave = False
        for uid, udata in data.items():
            user = UserInDB(
                name=udata["name"],
                email=udata["email"],
                password=udata["password"]
            )
            user.id = udata["id"]
            user.confirmed = udata.get("confirmed", False)
            user.token = udata.get("token", user.token)
            user.report_cache = udata.get("report_cache", {})
            user.insights = udata.get("insights", [])
            user.last_insight_generated_time = udata.get("last_insight_generated_time", "")
            user.insight_version = udata.get("insight_version", 0)
            
            # Migration of legacy details
            if "structured_details" in udata and udata["structured_details"]:
                user.structured_details = udata["structured_details"]
            else:
                legacy_bio = udata.get("bio", "")
                legacy_mods = udata.get("modifications", [])
                if legacy_bio or legacy_mods:
                    # Run fallback parsing to reconstruct structured_details
                    fallback_res = run_fallback_user_analysis(legacy_bio, legacy_mods)
                    user.structured_details = fallback_res["structured_details"]
                    needs_resave = True
                else:
                    user.structured_details = {}
            
            USERS_BY_EMAIL[user.email] = user
            USERS_BY_ID[user.id] = user
        if needs_resave:
            save_to_json()
    except Exception as e:
        print(f"Error loading database: {e}")

# Pydantic Schemas for Requests & Responses
class CheckEmailRequest(BaseModel):
    email: EmailStr

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    bio: str

class UpdateDetailsRequest(BaseModel):
    modifications: str


# Helper: Unified LLM Client
def call_llm_api(prompt: str, response_json: bool = True) -> Optional[str]:
    print(f"Calling LLM ({LLM_PROVIDER}) with prompt...")
    if LLM_PROVIDER == "gemini":
        api_key = os.environ.get("GEMINI_API_KEY")
        if api_key:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
                payload = {
                    "contents": [{"parts": [{"text": prompt}]}],
                }
                if response_json:
                    payload["generationConfig"] = {
                        "responseMimeType": "application/json"
                    }
                req_data = json.dumps(payload).encode('utf-8')
                req = urllib.request.Request(
                    url, 
                    data=req_data, 
                    headers={'Content-Type': 'application/json'}
                )
                with urllib.request.urlopen(req, timeout=15) as response:
                    res = json.loads(response.read().decode('utf-8'))
                    text_response = res["candidates"][0]["content"]["parts"][0]["text"]
                    return text_response
            except Exception as e:
                print(f"Error calling Gemini API: {e}")
        else:
            print("Gemini provider selected, but GEMINI_API_KEY environment variable is not set.")
            
    elif LLM_PROVIDER == "ollama":
        try:
            payload = {
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
            }
            if response_json:
                payload["format"] = "json"
            req_data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(
                OLLAMA_API_URL,
                data=req_data,
                headers={'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(req, timeout=15) as response:
                res = json.loads(response.read().decode('utf-8'))
                text_response = res.get("response", "")
                return text_response
        except Exception as e:
            print(f"Error calling Ollama API: {e}")
            
    return None

def run_fallback_user_analysis(bio: Optional[str], modifications: list, existing_details: Optional[dict] = None) -> dict:
    existing = existing_details or {}
    curr = existing.get("current_details", {})
    age = curr.get("age")
    height = curr.get("height")
    weight = curr.get("weight")
    
    ailments = existing.get("health_history_and_ailments")
    if not ailments or ailments == "None" or ailments == "Unknown":
        ailments = []
    elif isinstance(ailments, str):
        if ailments == "None":
            ailments = []
        else:
            ailments = [ailments]
    else:
        ailments = list(ailments)
        
    goals = existing.get("goals")
    if not goals or goals == "None" or goals == "Unknown":
        goals = []
    elif isinstance(goals, str):
        if goals == "None":
            goals = []
        else:
            goals = [goals]
    else:
        goals = list(goals)
        
    texts = []
    if bio:
        texts.append(bio.lower())
    for m in modifications:
        texts.append(m.lower())
    full_text = " ".join(texts)
    
    explicit_no_ailments = False
    explicit_no_goals = False
    
    if full_text:
        # Check for explicit "no ailments" statements using robust regex
        no_ailments_patterns = [
            r'\bno\s+(?:previous\s+)?(?:ailments?|illnesses?|allerg(?:y|ies)|medical|health\s+history|health\s+issues?|sickness(?:es)?|issues?|problems?)\b',
            r'\b(?:dont|don\'t|do\s+not)\s+have\s+(?:any\s+)?(?:ailments?|illnesses?|allerg(?:y|ies)|medical|health|sickness(?:es)?|issues?|problems?|history)\b',
            r'\bfree\s+of\s+(?:ailments?|illnesses?|allerg(?:y|ies)|medical|health|sickness(?:es)?|issues?|problems?)\b',
            r'\bhealthy\b'
        ]
        for p in no_ailments_patterns:
            if re.search(p, full_text):
                explicit_no_ailments = True
                ailments = []
                break
            
        # Check for explicit "no goals" statements using robust regex
        no_goals_patterns = [
            r'\bno\s+(?:specific\s+|fitness\s+|particular\s+)?goals?\b',
            r'\b(?:dont|don\'t|do\s+not)\s+have\s+(?:any\s+)?(?:specific\s+|fitness\s+|particular\s+)?goals?\b',
        ]
        for p in no_goals_patterns:
            if re.search(p, full_text):
                explicit_no_goals = True
                goals = []
                break
            
        # 1. Age extraction
        age_match = re.search(r'\b(?:i am|i\'m|age of|age:?\s*)\s*(\d{1,2})\b', full_text)
        if age_match:
            age = int(age_match.group(1))
        else:
            age_match_2 = re.search(r'\b(\d{1,2})\s*(?:years?\s*old|yo)\b', full_text)
            if age_match_2:
                age = int(age_match_2.group(1))
                 
        # 2. Height extraction
        height_match = re.search(r'\b(\d{3})\s*(?:cm|centimeters?)\b', full_text)
        if height_match:
            height = f"{height_match.group(1)} cm"
        else:
            height_match_2 = re.search(r'\b(\d{1}\.?\d{0,2})\s*(?:meters?|m)\b', full_text)
            if height_match_2 and float(height_match_2.group(1)) < 2.5:
                height = f"{height_match_2.group(1)} m"
            else:
                height_match_3 = re.search(r'\b(\d{1})\s*(?:feet|foot|ft)\s*(?:(\d{1,2})\s*(?:inches?|in))?\b', full_text)
                if height_match_3:
                    ft = height_match_3.group(1)
                    inch = height_match_3.group(2) or "0"
                    height = f"{ft}'{inch}\""
                     
        # 3. Weight extraction
        weight_match = re.search(r'\b(\d{2,3})\s*(?:kg|kilograms?)\b', full_text)
        if weight_match:
            weight = f"{weight_match.group(1)} kg"
        else:
            weight_match_2 = re.search(r'\b(\d{2,3})\s*(?:lbs|pounds?)\b', full_text)
            if weight_match_2:
                weight = f"{weight_match_2.group(1)} lbs"
                 
        # 4. Ailments / health history detection
        if not explicit_no_ailments:
            if "diabet" in full_text or "insulin" in full_text or "glycemic" in full_text:
                ailments.append("Blood glucose management / Diabetes considerations")
            if "pressure" in full_text or "hypertension" in full_text or "sodium" in full_text or "salt" in full_text:
                ailments.append("Cardiovascular care & low-sodium diet focus")
            if "cholesterol" in full_text or "lipid" in full_text or "fatty liver" in full_text:
                ailments.append("Cholesterol management")
            if "thyroid" in full_text:
                ailments.append("Thyroid regulation / Metabolic rate support")
            if "stomach" in full_text or "digest" in full_text or "ibs" in full_text or "reflux" in full_text or "gerd" in full_text or "bloat" in full_text:
                ailments.append("Sensitive digestion & gut health optimization")
            if "joint" in full_text or "arthritis" in full_text or "bone" in full_text or "knee" in full_text:
                ailments.append("Joint mobility & inflammation considerations")
            if "fatigue" in full_text or "energy" in full_text or "tired" in full_text or "exhausted" in full_text:
                ailments.append("Boosting metabolic energy / Fatigue management")
            if "gluten" in full_text or "celiac" in full_text:
                ailments.append("Gluten-free sensitivity / Celiac precautions")
            if "lactose" in full_text or "dairy" in full_text or "milk" in full_text:
                ailments.append("Lactose sensitivity / Dairy-free preferences")
            if "allergy" in full_text or "allergies" in full_text or "nuts" in full_text or "peanut" in full_text:
                ailments.append("Food allergen precautions")
             
        # 5. Goals detection
        if not explicit_no_goals:
            if "protein" in full_text:
                goals.append("Focus on high-protein intake")
            if "muscle" in full_text or "gain" in full_text:
                goals.append("Muscle building & hypertrophy")
            if "weight" in full_text or "lose" in full_text or "diet" in full_text or "deficit" in full_text:
                goals.append("Calorie deficit and weight management")
            if "run" in full_text or "cardio" in full_text or "walk" in full_text or "active" in full_text:
                goals.append("Physically active routine")
            if "veg" in full_text or "vegan" in full_text or "plant" in full_text:
                goals.append("Plant-based or vegetarian diet")
            if "keto" in full_text or "low carb" in full_text:
                goals.append("Ketogenic / Low-carbohydrate diet")
            if "dessert" in full_text or "sweet" in full_text or "sugar" in full_text:
                goals.append("Moderate sweet/sugar intake")
            if "water" in full_text or "hydrate" in full_text:
                goals.append("Monitoring daily water intake")
            if "stress" in full_text or "sleep" in full_text:
                goals.append("Optimizing sleep and stress recovery")

    # Deduplicate lists
    ailments = sorted(list(set(ailments)))
    goals = sorted(list(set(goals)))
    
    # Calculate state flags
    has_age_height_weight = (age is not None) and (height is not None) and (weight is not None)
    has_ailments = (len(ailments) > 0) or (existing.get("health_history_and_ailments") == "None") or explicit_no_ailments
    has_goals = (len(goals) > 0) or (existing.get("goals") == "None") or explicit_no_goals
    
    # Determine what to store
    if explicit_no_ailments or (existing.get("health_history_and_ailments") == "None" and not ailments):
        stored_ailments = "None"
    elif ailments:
        stored_ailments = ailments
    else:
        stored_ailments = None
        
    if explicit_no_goals or (existing.get("goals") == "None" and not goals):
        stored_goals = "None"
    elif goals:
        stored_goals = goals
    else:
        stored_goals = None

    userdetails_list = []
    if age: userdetails_list.append(f"Age: {age}")
    if height: userdetails_list.append(f"Height: {height}")
    if weight: userdetails_list.append(f"Weight: {weight}")
    
    if ailments:
        userdetails_list.append(f"Health History: {', '.join(ailments)}")
    elif stored_ailments == "None":
        userdetails_list.append("Health History: None")
        
    if goals:
        userdetails_list.append(f"Goals: {', '.join(goals)}")
    elif stored_goals == "None":
        userdetails_list.append("Goals: None")
        
    if not userdetails_list:
        userdetails_list.append("Bio Summary: General health tracking enthusiast")
        
    if has_age_height_weight and has_ailments and has_goals:
        placeholder = "Any other details you want to share?"
    elif not has_age_height_weight:
        placeholder = "Could you share your age, height, or weight?"
    elif not has_ailments:
        placeholder = "Any ailments or health history you want to share?"
    else:
        placeholder = "What are your fitness or health goals?"
        
    return {
        "structured_details": {
            "current_details": {
                "age": age,
                "height": height,
                "weight": weight
            },
            "health_history_and_ailments": stored_ailments,
            "goals": stored_goals
        },
        "userdetails_list": userdetails_list,
        "placeholder": placeholder
    }

def analyze_user_bio_and_modifications(bio: Optional[str], modifications: list, existing_details: Optional[dict] = None) -> dict:
    existing_details_str = json.dumps(existing_details, indent=2) if existing_details else "None"
    modifications_str = "\n".join(f"- {m}" for m in modifications) if modifications else "None"
    bio_str = f'"{bio}"' if bio else "None"
    
    prompt = f"""You are an AI assistant designed to extract and maintain structured health profile information from a user's self-description and modifications.
The three main categories we need to identify are:
1. Current details: age, height, and weight.
2. Health history and ailments: illnesses, allergies, food sensitivities, medical history, etc.
3. Goals: fitness, diet, or wellness goals (e.g. lose weight, build muscle, track protein, eat vegetarian).

Existing structured details (if any):
{existing_details_str}

User's initial description (if registering):
{bio_str}

Subsequent updates/modifications from the user (if any):
{modifications_str}

Analyze the input carefully. Update or initialize the structured details based on the new updates/modifications.
Perform the following steps:
1. Extract or update the user's age, height, and weight (if mentioned or in existing details).
2. Extract or update the user's health history, allergies, illnesses, sensitivities, and ailments (if mentioned or in existing details). If the user explicitly states they have no health history, no ailments, or no allergies (e.g. "I don't have any health issues", "no allergies", "healthy"), set "health_history_and_ailments" to exactly "None".
3. Extract or update the user's goals (if mentioned or in existing details). If the user explicitly states they have no specific goals or fitness plans (e.g. "I don't have any goals", "no goals"), set "goals" to exactly "None".
4. Build a list of concise user details bullet points to display to the user (e.g. "Age: 29", "Height: 180 cm", "Weight: 75 kg", "Goals: Muscle building", "Health History: Lactose intolerance"). If a category is set to "None", write "Health History: None" or "Goals: None".
5. Generate a dynamic placeholder question for the follow-up text box based on what is missing:
   - Check if all three categories are present/filled. A category is considered filled if it has extracted details OR if its value is exactly "None".
   - If ALL three categories are filled (i.e. physical stats are present AND health history is present/None AND goals are present/None), the placeholder must be exactly: "Any other details you want to share?"
   - Otherwise, identify which category is missing (not filled and not "None") and ask a specific, friendly question about it. For example, if health history/ailments is missing: "Any ailments or health history you want to share?" If goals are missing: "What are your fitness or health goals?" If physical details are missing: "Could you share your age, height, or weight?" If multiple are missing, ask about one of the missing ones.

Provide your response strictly as a JSON object with these exact keys:
{{
  "structured_details": {{
    "current_details": {{
      "age": <int or string or null>,
      "height": <string or null>,
      "weight": <string or null>
    }},
    "health_history_and_ailments": <string or list of strings or null (use "None" if explicitly no ailments)>,
    "goals": <string or list of strings or null (use "None" if explicitly no goals)>
  }},
  "userdetails_list": [<list of strings for display>],
  "placeholder": <string>
}}
"""
    
    response_text = call_llm_api(prompt, response_json=True)
    
    if response_text:
        try:
            clean_text = response_text.strip()
            if clean_text.startswith("```"):
                lines = clean_text.split("\n")
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines[-1].startswith("```"):
                    lines = lines[:-1]
                clean_text = "\n".join(lines).strip()
                
            data = json.loads(clean_text)
            if "structured_details" in data and "userdetails_list" in data and "placeholder" in data:
                return data
        except Exception as e:
            print(f"Error parsing LLM response for user analysis: {e}. Raw response: {response_text}")
            
    print("Using Python fallback for user bio analysis.")
    return run_fallback_user_analysis(bio, modifications, existing_details)

# Helper: Smart User Details facts generator
def extract_user_details(user: UserInDB) -> str:
    points = [
        f"Name: {user.name}",
        f"Email: {user.email}",
    ]
    structured = getattr(user, 'structured_details', {})
    if structured:
        curr = structured.get("current_details", {})
        if curr:
            age = curr.get("age")
            height = curr.get("height")
            weight = curr.get("weight")
            if age and age != "Unknown" and age != "None" and age != "null" and str(age).lower() != "unknown":
                points.append(f"Age: {age}")
            if height and height != "Unknown" and height != "None" and height != "null" and str(height).lower() != "unknown":
                points.append(f"Height: {height}")
            if weight and weight != "Unknown" and weight != "None" and weight != "null" and str(weight).lower() != "unknown":
                points.append(f"Weight: {weight}")
        
        hist = structured.get("health_history_and_ailments")
        if hist:
            if isinstance(hist, list):
                hist_str = ", ".join(hist)
            else:
                hist_str = str(hist)
            if hist_str and hist_str.lower() != "none" and hist_str.lower() != "unknown" and hist_str.lower() != "null":
                points.append(f"Health History & Ailments: {hist_str}")
                
        goals = structured.get("goals")
        if goals:
            if isinstance(goals, list):
                goals_str = ", ".join(goals)
            else:
                goals_str = str(goals)
            if goals_str and goals_str.lower() != "none" and goals_str.lower() != "unknown" and goals_str.lower() != "null":
                points.append(f"Goals: {goals_str}")
    
    if len(points) == 2:
        analysis = run_fallback_user_analysis(None, [])
        for item in analysis["userdetails_list"]:
            points.append(item)
            
    return "\n".join(f"• {p}" for p in points)



# Endpoints

@app.post("/api/users/check")
def check_email(payload: CheckEmailRequest):
    email = payload.email.strip().lower()
    user = USERS_BY_EMAIL.get(email)
    if user:
        return {
            "exists": True,
            "user": {
                "id": user.id,
                "email": user.email
            }
        }
    return {"exists": False}


@app.get("/api/users/{userid}")
def get_user_details(userid: str):
    user = USERS_BY_ID.get(userid)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found."
        )
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "userdetails": extract_user_details(user)
    }


@app.post("/api/users/login")
def login(payload: LoginRequest):
    email = payload.email.strip().lower()
    user = USERS_BY_EMAIL.get(email)
    if not user or user.password != payload.password:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect password or email."
        )
    return {
        "userid": user.id,
        "token": user.token
    }


@app.post("/api/users/register")
def register(payload: RegisterRequest):
    email = payload.email.strip().lower()
    if email in USERS_BY_EMAIL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered."
        )
    
    user = UserInDB(
        name=payload.name.strip(),
        email=email,
        password=payload.password
    )
    
    # Analyze user details using LLM or Fallback
    analysis = analyze_user_bio_and_modifications(payload.bio.strip(), [])
    user.structured_details = analysis["structured_details"]
    
    # Store in memory databases
    USERS_BY_EMAIL[email] = user
    USERS_BY_ID[user.id] = user
    save_to_json()
    
    userdetails_text = "\n".join(f"• {item}" for item in analysis["userdetails_list"])
    
    return {
        "userid": user.id,
        "token": user.token,
        "userdetails": userdetails_text,
        "placeholder": analysis["placeholder"]
    }


@app.post("/api/users/{userid}/confirm")
def confirm_details(userid: str):
    user = USERS_BY_ID.get(userid)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found."
        )
    user.confirmed = True
    save_to_json()
    return {"status": "success"}


@app.post("/api/users/{userid}/update")
def update_details(userid: str, payload: UpdateDetailsRequest):
    user = USERS_BY_ID.get(userid)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found."
        )
    
    # Re-analyze details based on the existing structured details and new modifications
    mods = payload.modifications.strip()
    analysis = analyze_user_bio_and_modifications(None, [mods], user.structured_details)
    user.structured_details = analysis["structured_details"]
    save_to_json()
    
    userdetails_text = "\n".join(f"• {item}" for item in analysis["userdetails_list"])
    
    return {
        "userdetails": userdetails_text,
        "placeholder": analysis["placeholder"]
    }


# Image Classifier Helper & Endpoints

general_classifier = None
specialized_classifier = None

def get_general_classifier():
    global general_classifier
    if general_classifier is None:
        # Load a highly efficient tiny image classification model (ImageNet)
        general_classifier = pipeline("image-classification", model="microsoft/swin-tiny-patch4-window7-224")
    return general_classifier

def get_specialized_classifier():
    global specialized_classifier
    if specialized_classifier is None:
        # Load a specialized classifier for Indian and Western food categories
        specialized_classifier = pipeline("image-classification", model="prithivMLmods/Indian-Western-Food-34")
    return specialized_classifier

def call_gemini_multimodal_api(image_bytes: bytes, mime_type: str, prompt: str) -> Optional[str]:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("Gemini API key not found in environment.")
        return None
    try:
        import base64
        encoded_image = base64.b64encode(image_bytes).decode('utf-8')
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
        payload = {
            "contents": [{
                "parts": [
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": encoded_image
                        }
                    },
                    {
                        "text": prompt
                    }
                ]
            }],
            "generationConfig": {
                "responseMimeType": "application/json"
            }
        }
        req_data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            url, 
            data=req_data, 
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=20) as response:
            res = json.loads(response.read().decode('utf-8'))
            text_response = res["candidates"][0]["content"]["parts"][0]["text"]
            return text_response
    except Exception as e:
        print(f"Error calling Gemini Multimodal API: {e}")
        return None

def call_ollama_multimodal_api(image_bytes: bytes, prompt: str) -> Optional[str]:
    try:
        import base64
        encoded_image = base64.b64encode(image_bytes).decode('utf-8')
        payload = {
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "images": [encoded_image],
            "stream": False,
            "format": "json"
        }
        req_data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            OLLAMA_API_URL,
            data=req_data,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=25) as response:
            res = json.loads(response.read().decode('utf-8'))
            text_response = res.get("response", "")
            return text_response
    except Exception as e:
        print(f"Error calling Ollama Multimodal API: {e}")
        return None

def clean_json_response(raw_response: str) -> str:
    clean_text = raw_response.strip()
    if clean_text.startswith("```"):
        lines = clean_text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines[-1].startswith("```"):
            lines = lines[:-1]
        clean_text = "\n".join(lines).strip()
    return clean_text

def classify_image_fallback(image_bytes: bytes, filename: str):
    filename_lower = filename.lower()
    if "dosa" in filename_lower:
        return True, "masala dosa", 0.98, "Looks like an appetizing golden dosa."
    if "pizza" in filename_lower:
        return True, "pizza", 0.95, "Looks like an appetizing pizza."
    if "burger" in filename_lower or "hamburger" in filename_lower:
        return True, "cheeseburger", 0.92, "Looks like a juicy cheeseburger."
    if "salad" in filename_lower:
        return True, "salad", 0.89, "Looks like a fresh mixed salad."
    if "apple" in filename_lower or "fruit" in filename_lower:
        return True, "apple", 0.94, "Looks like a fresh apple."
    if "dog" in filename_lower or "cat" in filename_lower:
        return False, "dog/cat", 0.91, "We detected an animal, which doesn't seem to be a food item."
    
    return True, "grilled chicken breast with vegetables", 0.85, "Looks like a healthy grilled chicken dish."

@app.post("/api/users/analyze-image")
async def analyze_image(file: UploadFile = File(...)):
    contents = await file.read()
    
    is_food = True
    food_name = "pizza"
    confidence = 0.92
    details = "Looks like a delicious pizza."
    
    llm_classification_success = False
    
    # 1. Attempt Multimodal LLM classification if provider is configured and available
    mime_type = "image/jpeg"
    if file.filename:
        ext = file.filename.split(".")[-1].lower()
        if ext in ["png", "webp", "gif"]:
            mime_type = f"image/{ext}"

    llm_prompt = """You are an expert food classifier. Analyze the provided food image and return a JSON object with these exact keys:
{
  "is_food": <bool, true if it is a food item, false otherwise>,
  "food_name": <string, the specific name of the food item, e.g. "masala dosa" or "pepperoni pizza" or "caesar salad">,
  "confidence": <float, confidence score between 0.0 and 1.0>,
  "details": <string, a brief description of the food item like "Looks like a freshly prepared golden dosa.">
}
Return ONLY the raw JSON object, without markdown formatting or code blocks.
"""

    if LLM_PROVIDER == "gemini" and os.environ.get("GEMINI_API_KEY"):
        print("Using Gemini Multimodal API for image classification...")
        response_text = call_gemini_multimodal_api(contents, mime_type, llm_prompt)
        if response_text:
            try:
                data = json.loads(clean_json_response(response_text))
                if "is_food" in data and "food_name" in data and "confidence" in data:
                    is_food = bool(data["is_food"])
                    food_name = str(data["food_name"])
                    confidence = float(data["confidence"])
                    details = str(data.get("details", f"Detected {food_name}."))
                    llm_classification_success = True
            except Exception as e:
                print(f"Error parsing Gemini response: {e}. Raw: {response_text}")

    elif LLM_PROVIDER == "ollama":
        print("Using Ollama Multimodal API for image classification...")
        response_text = call_ollama_multimodal_api(contents, llm_prompt)
        if response_text:
            try:
                data = json.loads(clean_json_response(response_text))
                if "is_food" in data and "food_name" in data and "confidence" in data:
                    is_food = bool(data["is_food"])
                    food_name = str(data["food_name"])
                    confidence = float(data["confidence"])
                    details = str(data.get("details", f"Detected {food_name}."))
                    llm_classification_success = True
            except Exception as e:
                print(f"Error parsing Ollama response: {e}. Raw: {response_text}")

    # 2. Local ML Pipeline Fallback (or if LLM failed/disabled)
    if not llm_classification_success:
        try:
            if HAS_ML:
                image = Image.open(io.BytesIO(contents))
                
                # Run specialized Indian/Western model
                spec_pipe = get_specialized_classifier()
                spec_results = spec_pipe(image)
                top_spec = spec_results[0]
                spec_label = top_spec["label"].lower()
                spec_score = top_spec["score"]
                
                # Run general model
                gen_pipe = get_general_classifier()
                results = gen_pipe(image)
                
                # Common container/vessel labels in ImageNet to ignore/skip
                container_keywords = [
                    "plate", "cup", "mug", "bowl", "saucer", "tray", "platter", 
                    "pot", "glass", "table", "dining table", "dishwasher", "refrigerator",
                    "tray", "shelf", "counter", "kitchen"
                ]
                
                # Common food keywords to check if prediction matches food
                food_keywords = [
                    "pizza", "burger", "dog", "spaghetti", "salad", "fruit", "bread", 
                    "soup", "pie", "cake", "ice cream", "vegetable", "egg", "cheese", 
                    "chocolate", "sandwich", "pasta", "chicken", "fish", "rice", 
                    "curry", "banana", "apple", "orange", "lemon", "strawberry", 
                    "carbonara", "potage", "consomme", "espresso", "guacamole", 
                    "burrito", "taco", "bagel", "pretzel", "bakery", "meat", "dish", "food",
                    "custard", "pudding", "sweet", "pastry", "cookie", "doughnut", "muffin",
                    "tart", "croissant", "bun", "roll", "torte", "confectionery", "chocolate",
                    "fudge", "caramel", "honey", "syrup", "jelly", "jam", "marmalade", "sauce",
                    "gravy", "dressing", "condiment", "dip", "salsa", "hummus", "guacamole"
                ]

                detected_label = None
                detected_score = None
                is_food_detected = False
                
                # Loop through results to find the first food label that is NOT just a generic container
                for pred in results:
                    label_lower = pred["label"].lower()
                    score_val = pred["score"]
                    
                    is_container = any(ck in label_lower for ck in container_keywords)
                    is_food_item = any(fk in label_lower for fk in food_keywords)
                    
                    if is_food_item and not is_container:
                        detected_label = pred["label"]
                        detected_score = score_val
                        is_food_detected = True
                        break
                
                # Fallback to the first non-container prediction if no specific food keywords matched
                if not is_food_detected:
                    for pred in results:
                        label_lower = pred["label"].lower()
                        if not any(ck in label_lower for ck in container_keywords):
                            detected_label = pred["label"]
                            detected_score = pred["score"]
                            is_food_detected = any(fk in label_lower for fk in food_keywords)
                            break
                            
                # absolute fallback to top prediction if all labels are containers
                if detected_label is None:
                    detected_label = results[0]["label"]
                    detected_score = results[0]["score"]
                    is_food_detected = any(fk in detected_label.lower() for fk in food_keywords)
                
                # Check if the general model confidently detects non-food
                top_gen_is_food = any(fk in results[0]["label"].lower() for fk in food_keywords)
                top_gen_is_container = any(ck in results[0]["label"].lower() for ck in container_keywords)
                
                if not top_gen_is_food and not top_gen_is_container and results[0]["score"] > 0.60:
                    is_food = False
                    food_name = results[0]["label"].split(",")[0].strip()
                    confidence = float(results[0]["score"])
                    details = f"We detected {results[0]['label']}, which doesn't seem to be a food item."
                elif spec_score >= 0.70:
                    is_food = True
                    food_name = spec_label
                    confidence = spec_score
                    details = f"Detected {top_spec['label']}."
                else:
                    # Choose general model if it has higher confidence
                    if is_food_detected and detected_score > spec_score:
                        is_food = True
                        food_name = detected_label.split(",")[0].strip()
                        confidence = float(detected_score)
                        details = f"Detected {detected_label}."
                    else:
                        is_food = True
                        food_name = spec_label
                        confidence = spec_score
                        details = f"Detected {top_spec['label']}."
            else:
                is_food, food_name, confidence, details = classify_image_fallback(contents, file.filename)
        except Exception as e:
            print("ML classification error:", e)
            is_food, food_name, confidence, details = classify_image_fallback(contents, file.filename)
        
    return {
        "is_food": is_food,
        "food_name": food_name,
        "confidence": confidence,
        "details": details
    }

ASR_PIPELINE = None

def get_asr_pipeline():
    global ASR_PIPELINE
    if ASR_PIPELINE is None:
        if HAS_ML:
            try:
                ASR_PIPELINE = pipeline("automatic-speech-recognition", model="openai/whisper-tiny")
            except Exception as e:
                print(f"Error loading ASR pipeline: {e}")
        else:
            print("ML dependencies not loaded. ASR pipeline disabled.")
    return ASR_PIPELINE

@app.post("/api/users/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    asr = get_asr_pipeline()
    if not asr:
        # Fallback transcription: return text based on filename or dummy string
        filename_lower = file.filename.lower()
        if "apple" in filename_lower:
            return {"text": "I had a fresh red apple for my evening snack."}
        if "oatmeal" in filename_lower:
            return {"text": "I had a bowl of hot oatmeal with sliced bananas and a drizzle of honey."}
        return {"text": "I ate two slices of cheese pizza and drank a glass of water for lunch."}

    # Save uploaded file to a temporary file
    suffix = os.path.splitext(file.filename)[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        result = asr(tmp_path)
        text = result.get("text", "").strip()
        return {"text": text}
    except Exception as e:
        print(f"Transcription error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to transcribe audio: {str(e)}"
        )
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


# Dynamic Nutrition Analysis helpers & endpoints

class AnalyzeFoodRequest(BaseModel):
    food_name: str

def fetch_usda_nutrients(query: str) -> Optional[dict]:
    api_key = os.environ.get("USDA_API_KEY", "DEMO_KEY")
    query_encoded = urllib.parse.quote(query)
    url = f"https://api.nal.usda.gov/fdc/v1/foods/search?query={query_encoded}&api_key={api_key}&pageSize=1"
    
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode())
            if "foods" in data and len(data["foods"]) > 0:
                food = data["foods"][0]
                nutrients = food.get("foodNutrients", [])
                
                calories = 0
                protein = 0
                carbs = 0
                fat = 0
                
                for n in nutrients:
                    name = n.get("nutrientName", "").lower()
                    val = n.get("value", 0.0)
                    if "energy" in name or "kcal" in name:
                        calories = int(val)
                    elif "protein" in name:
                        protein = int(val)
                    elif "carbohydrate" in name:
                        carbs = int(val)
                    elif "total lipid" in name or "fat" in name:
                        if "saturated" not in name and "trans" not in name:
                            fat = int(val)
                            
                return {
                    "calories": calories,
                    "protein": protein,
                    "carbs": carbs,
                    "fat": fat,
                    "description": food.get("description", query)
                }
    except Exception as e:
        print("USDA API Error:", e)
    return None

def calculate_grade_and_tips(calories: int, protein: int, carbs: int, fat: int, food_name: str):
    score = 75
    
    # Calculate protein bonus
    if calories > 0:
        protein_ratio = (protein * 4) / calories
        score += int(protein_ratio * 40)
    else:
        score += 10
        
    # Calculate fat penalty
    if calories > 0:
        fat_ratio = (fat * 9) / calories
        if fat_ratio > 0.4:
            score -= int((fat_ratio - 0.4) * 50)
            
    # Calorie penalties
    if calories > 500:
        score -= 5
    if calories > 800:
        score -= 10
        
    score = max(10, min(100, score))
    
    if score >= 90:
        grade = "A+"
    elif score >= 80:
        grade = "A"
    elif score >= 70:
        grade = "B"
    elif score >= 60:
        grade = "C+"
    elif score >= 50:
        grade = "C-"
    else:
        grade = "D"
        
    tips = []
    food_lower = food_name.lower()
    
    # Contextual tips based on food keywords
    if "pizza" in food_lower or "burger" in food_lower or "fries" in food_lower:
        tips.append("Fast food detected. Highly advise tracking sodium intake today.")
    elif "salad" in food_lower or "chicken" in food_lower or "fish" in food_lower:
        tips.append("Excellent lean and nutrient-rich choice.")
    elif "apple" in food_lower or "banana" in food_lower or "fruit" in food_lower or "orange" in food_lower:
        tips.append("Fruit base: rich in organic vitamins and healthy fibers.")
        
    # Standard macro tips
    if protein > 15:
        tips.append("High protein density supports lean muscle tissue growth.")
    else:
        tips.append("Lower in protein. Consider pairing with a secondary lean protein source.")
        
    if carbs > 50:
        tips.append("High energy carbs. Great for active workloads; watch glycemic response.")
    if fat > 20:
        tips.append("Higher lipid profile. Keep saturated fats in check.")
        
    tips.append("Drink plenty of water and add leafy greens to optimize absorption!")
    
    return grade, tips

def split_food_items(query: str) -> list:
    # Split food entries by common separators like and, with, comma, or plus
    delimiters = [" and ", " with ", ",", "+"]
    items = [query]
    
    for delim in delimiters:
        new_items = []
        for item in items:
            parts = item.split(delim)
            new_items.extend(parts)
        items = new_items
        
    cleaned_items = []
    for item in items:
        cleaned = item.strip()
        # Skip empty items or simple filler leftover noise
        if cleaned and cleaned not in ["and", "with", "a", "an", "the", "for", "of"]:
            cleaned_items.append(cleaned)
            
    return cleaned_items

@app.post("/api/users/analyze-food")
def analyze_food(payload: AnalyzeFoodRequest):
    query = payload.food_name.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Food name query cannot be empty.")
        
    NUMBER_MAP = {
        "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
        "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
        "a": 1, "an": 1
    }
    
    # 1. Split query into distinct food items
    raw_items = split_food_items(query)
    
    total_calories = 0
    total_protein = 0
    total_carbs = 0
    total_fat = 0
    item_breakdowns = []
    
    for raw_item in raw_items:
        query_lower = raw_item.lower()
        multiplier = 1.0
        
        # 1.1 Extract multiplier digits
        digit_match = re.search(r'\b(\d+(?:\.\d+)?)\b', query_lower)
        if digit_match:
            try:
                multiplier = float(digit_match.group(1))
            except ValueError:
                multiplier = 1.0
        else:
            # Check for number words
            for word, val in NUMBER_MAP.items():
                if re.search(r'\b' + word + r'\b', query_lower):
                    multiplier = float(val)
                    break
                    
        # 1.2 Extract core food item name
        core_food = query_lower
        fillers = [
            "i ate", "i had", "i have had", "today", "for breakfast", "for lunch", 
            "for dinner", "for snack", "yesterday", "tonight", "ate", "had", "eating",
            "pieces of", "piece of", "slice of", "slices of", "bowl of", "bowls of", 
            "plate of", "cups of", "cup of", "glass of", "glasses of", "some", "few"
        ]
        for filler in fillers:
            core_food = core_food.replace(filler, " ")
            
        # Scrub quantity numbers
        core_food = re.sub(r'\b\d+(?:\.\d+)?\b', ' ', core_food)
        for word in NUMBER_MAP.keys():
            core_food = re.sub(r'\b' + word + r'\b', ' ', core_food)
            
        core_food = re.sub(r'\s+', ' ', core_food).strip()
        
        # Strip trailing plural 's'
        if core_food.endswith("s") and not core_food.endswith("ss") and not core_food.endswith("ce") and not core_food.endswith("us"):
            core_food = core_food[:-1]
            
        if not core_food:
            core_food = raw_item.strip()
            
        # 1.3 Fetch nutrients for this portion
        usda_data = fetch_usda_nutrients(core_food)
        
        item_calories = 0
        item_protein = 0
        item_carbs = 0
        item_fat = 0
        item_desc = core_food
        
        if usda_data:
            item_calories = int(usda_data["calories"] * multiplier)
            item_protein = int(usda_data["protein"] * multiplier)
            item_carbs = int(usda_data["carbs"] * multiplier)
            item_fat = int(usda_data["fat"] * multiplier)
            item_desc = usda_data["description"]
        else:
            # Offline Fallback estimations scaled by multiplier
            f_lower = core_food.lower()
            if "pizza" in f_lower:
                base_cal, base_prot, base_carb, base_fat = 680, 24, 72, 32
            elif "burger" in f_lower or "cheeseburger" in f_lower:
                base_cal, base_prot, base_carb, base_fat = 550, 28, 40, 28
            elif "salad" in f_lower or "chicken breast" in f_lower or "fish" in f_lower:
                base_cal, base_prot, base_carb, base_fat = 290, 34, 10, 8
            elif "apple" in f_lower or "banana" in f_lower or "fruit" in f_lower:
                base_cal, base_prot, base_carb, base_fat = 95, 1, 23, 0
            elif "rice" in f_lower:
                base_cal, base_prot, base_carb, base_fat = 130, 3, 28, 0
            elif "sambhar" in f_lower or "sambar" in f_lower or "curry" in f_lower:
                base_cal, base_prot, base_carb, base_fat = 120, 4, 15, 5
            else:
                base_cal, base_prot, base_carb, base_fat = 200, 8, 25, 6
                
            item_calories = int(base_cal * multiplier)
            item_protein = int(base_prot * multiplier)
            item_carbs = int(base_carb * multiplier)
            item_fat = int(base_fat * multiplier)
            item_desc = core_food
            
        # Accumulate
        total_calories += item_calories
        total_protein += item_protein
        total_carbs += item_carbs
        total_fat += item_fat
        
        # Record item name and calories for breakdown feedback
        qty_label = f"{multiplier}x " if multiplier != 1.0 else ""
        item_breakdowns.append(f"{qty_label}{item_desc.split(',')[0].strip()} ({item_calories} kcal)")

    # 2. Score and Grade the aggregated values
    unified_desc = " + ".join(item_breakdowns)
    grade, tips = calculate_grade_and_tips(total_calories, total_protein, total_carbs, total_fat, unified_desc)
    
    # 3. Insert detailed breakdown lists into the tips for the user
    breakdown_msg = "Breakdown: " + " + ".join(item_breakdowns)
    tips.insert(0, breakdown_msg)
    
    if len(raw_items) > 1:
        tips.insert(1, f"Aggregated and analyzed {len(raw_items)} distinct food items dynamically.")
        
    return {
        "calories": total_calories,
        "protein": total_protein,
        "carbs": total_carbs,
        "fat": total_fat,
        "grade": grade,
        "tips": tips
    }


# ==========================================
# MEAL LOGGING PERSISTENCE & API ENDPOINTS
# ==========================================

import time
from datetime import datetime, timedelta

MEAL_LOGS_FILE = os.path.join(os.path.dirname(__file__), "meal_logs.json")

# In-memory database of logs keyed by user_id
MEAL_LOGS: Dict[str, list] = {}

def load_meal_logs():
    global MEAL_LOGS
    if not os.path.exists(MEAL_LOGS_FILE):
        MEAL_LOGS = {}
        return
    try:
        with open(MEAL_LOGS_FILE, "r") as f:
            MEAL_LOGS = json.load(f)
    except Exception as e:
        print(f"Error loading meal logs: {e}")
        MEAL_LOGS = {}

def save_meal_logs():
    try:
        with open(MEAL_LOGS_FILE, "w") as f:
            json.dump(MEAL_LOGS, f, indent=4)
    except Exception as e:
        print(f"Error saving meal logs: {e}")

# Load logs on startup
load_meal_logs()

def fallback_parse_description(description: str) -> dict:
    now = datetime.now()
    log_date = now.date()
    log_time = now.time().replace(second=0, microsecond=0)
    
    desc_lower = description.lower()
    
    # 1. Date extraction
    if "yesterday" in desc_lower:
        log_date = (now - timedelta(days=1)).date()
    elif "today" in desc_lower:
        log_date = now.date()
    # Check days of the week
    days = {
        "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
        "friday": 4, "saturday": 5, "sunday": 6
    }
    for day, day_num in days.items():
        if day in desc_lower:
            current_weekday = now.weekday()
            days_ago = (current_weekday - day_num) % 7
            if days_ago == 0:
                days_ago = 7
            log_date = (now - timedelta(days=days_ago)).date()
            break

    # 2. Robust Time extraction
    time_extracted = False
    hour = log_time.hour
    minute = log_time.minute
    
    # Try pattern 1: HH:MM with optional am/pm (e.g. 8:30 pm, 13:00)
    match = re.search(r'\b(\d{1,2}):(\d{2})\s*(am|pm)?\b', desc_lower)
    if match:
        hour = int(match.group(1))
        minute = int(match.group(2))
        ampm = match.group(3)
        if ampm:
            if ampm == "pm" and hour < 12:
                hour += 12
            elif ampm == "am" and hour == 12:
                hour = 0
        time_extracted = True
        
    # Try pattern 2: HH am/pm (e.g. 9am, 9 pm)
    if not time_extracted:
        match = re.search(r'\b(\d{1,2})\s*(am|pm)\b', desc_lower)
        if match:
            hour = int(match.group(1))
            minute = 0
            ampm = match.group(2)
            if ampm == "pm" and hour < 12:
                hour += 12
            elif ampm == "am" and hour == 12:
                hour = 0
            time_extracted = True
            
    # Try pattern 3: at HH (e.g. at 9, at 14)
    if not time_extracted:
        match = re.search(r'\bat\s+(\d{1,2})\b', desc_lower)
        if match:
            hour = int(match.group(1))
            minute = 0
            time_extracted = True
            
    if time_extracted:
        if 0 <= hour < 24 and 0 <= minute < 60:
            log_time = log_time.replace(hour=hour, minute=minute)
    else:
        # Keyword-based time fallback
        if "morning" in desc_lower:
            log_time = log_time.replace(hour=8, minute=0)
        elif "noon" in desc_lower or "lunch" in desc_lower:
            log_time = log_time.replace(hour=12, minute=30)
        elif "afternoon" in desc_lower:
            log_time = log_time.replace(hour=15, minute=0)
        elif "evening" in desc_lower:
            log_time = log_time.replace(hour=18, minute=30)
        elif "night" in desc_lower or "dinner" in desc_lower:
            log_time = log_time.replace(hour=20, minute=0)

    # 3. Clean food query by scrubbing known date/time/filler phrases
    scrub_phrases = [
        "yesterday", "today", "tomorrow", "this morning", "this afternoon", "this evening",
        "morning", "noon", "afternoon", "evening", "night", "lunch", "dinner", "breakfast",
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
        "i ate", "i had", "i have had", "ate", "had", "eating",
        "pieces of", "piece of", "slice of", "slices of", "bowl of", "bowls of", 
        "plate of", "cups of", "cup of", "glass of", "glasses of",
        "last monday", "last tuesday", "last wednesday", "last thursday", "last friday", "last saturday", "last sunday",
        "last", "this", "some", "few", "at", "pm", "am", "o'clock", "for"
    ]
    
    clean_query = description
    if time_extracted:
        clean_query = re.sub(r'\b\d{1,2}:\d{2}\s*(?:am|pm)?\b', '', clean_query, flags=re.IGNORECASE)
        clean_query = re.sub(r'\b\d{1,2}\s*(?:am|pm)\b', '', clean_query, flags=re.IGNORECASE)
        clean_query = re.sub(r'\bat\s+\d{1,2}\b', '', clean_query, flags=re.IGNORECASE)

    # Scrub phrases
    for phrase in scrub_phrases:
        clean_query = re.sub(r'\b' + phrase + r'\b', '', clean_query, flags=re.IGNORECASE)
        
    clean_query = re.sub(r'\s+', ' ', clean_query).strip()
    clean_query = re.sub(r'^[,\s]+|[,\s]+$', '', clean_query)
    
    if not clean_query:
        clean_query = description
        
    iso_datetime = datetime.combine(log_date, log_time).strftime("%Y-%m-%dT%H:%M")
    
    return {
        "food_query": clean_query,
        "datetime": iso_datetime
    }

def parse_food_and_time(description: str) -> dict:
    prompt = f"""You are an expert assistant that extracts food items and the date/time they were eaten from a user's sentence.
Current local time is: {datetime.now().strftime("%Y-%m-%dT%H:%M")}

User sentence: "{description}"

Extract:
1. The food items eaten, cleaned of any quantity words, time words, or filler phrases (e.g. "i ate", "at 9am", "today").
2. The date and time when the food was eaten, formatted as an ISO datetime string: YYYY-MM-DDTHH:MM.
   - If a relative day like "today", "yesterday", "tomorrow", or a day of the week is mentioned, calculate the correct date relative to the current local time.
   - If a specific time is mentioned (e.g., "9am", "8:30 pm", "14:00"), set that time.
   - If no date is mentioned, assume today's date.
   - If no time is mentioned, assume the current time.

Return your response strictly as a JSON object with this format:
{{
  "food_query": "extracted food description",
  "datetime": "YYYY-MM-DDTHH:MM"
}}
"""
    response_text = call_llm_api(prompt, response_json=True)
    if response_text:
        try:
            clean_text = response_text.strip()
            if clean_text.startswith("```"):
                lines = clean_text.split("\n")
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines[-1].startswith("```"):
                    lines = lines[:-1]
                clean_text = "\n".join(lines).strip()
            data = json.loads(clean_text)
            if "food_query" in data and "datetime" in data:
                return data
        except Exception as e:
            print(f"Error parsing LLM response for food and time: {e}")
            
    print("Using Python fallback for food and time parsing.")
    return fallback_parse_description(description)

# Pydantic Schemas for Meal Logs
class MealLogReport(BaseModel):
    calories: int
    protein: int
    carbs: int
    fat: int
    grade: str

class MealLogRequest(BaseModel):
    description: str
    time: Optional[str] = None  # User-selected ISO datetime string, format: YYYY-MM-DDTHH:MM
    report: Optional[MealLogReport] = None

@app.post("/api/users/{userid}/logs")
def add_meal_log(userid: str, payload: MealLogRequest):
    if userid not in USERS_BY_ID:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found."
        )
    
    description = payload.description.strip()
    log_time = payload.time
    report = payload.report
    
    if not log_time or not report:
        # We need to parse the description to extract food query & time
        parsed = parse_food_and_time(description)
        food_query = parsed["food_query"]
        extracted_time = parsed["datetime"]
        
        if not log_time:
            log_time = extracted_time
            
        if not report:
            try:
                # Call analyze_food logic internally
                analysis = analyze_food(AnalyzeFoodRequest(food_name=food_query))
                report = MealLogReport(
                    calories=analysis["calories"],
                    protein=analysis["protein"],
                    carbs=analysis["carbs"],
                    fat=analysis["fat"],
                    grade=analysis["grade"]
                )
            except Exception as e:
                print(f"Error analyzing food inside add_meal_log: {e}")
                report = MealLogReport(
                    calories=200,
                    protein=8,
                    carbs=25,
                    fat=6,
                    grade="C"
                )
        # Use the cleaned food query as description for the log entry
        description = food_query

    # Generate timestamp as ID (milliseconds since epoch to guarantee uniqueness)
    timestamp_id = str(int(time.time() * 1000))
    
    log_entry = {
        "id": timestamp_id,
        "description": description,
        "time": log_time.strip(),
        "report": report.dict()
    }
    
    if userid not in MEAL_LOGS:
        MEAL_LOGS[userid] = []
        
    MEAL_LOGS[userid].append(log_entry)
    
    # Store them in chronological order of the date/time the user mentioned (oldest to newest)
    MEAL_LOGS[userid].sort(key=lambda x: x["time"])
    
    save_meal_logs()
    
    return {"status": "success", "log": log_entry}

@app.get("/api/users/{userid}/logs")
def get_meal_logs(userid: str, week_offset: int = 0):
    if userid not in USERS_BY_ID:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found."
        )
        
    user_logs = MEAL_LOGS.get(userid, [])
    
    # Filter logs relative to the current local date/time and week_offset
    now = datetime.now()
    end_of_today = now.replace(hour=23, minute=59, second=59, microsecond=999999)
    
    start_date = end_of_today - timedelta(days=(week_offset + 1) * 7)
    end_date = end_of_today - timedelta(days=week_offset * 7)
    
    filtered_logs = []
    for log in user_logs:
        try:
            log_dt = datetime.fromisoformat(log["time"])
            if start_date < log_dt <= end_date:
                filtered_logs.append(log)
        except Exception:
            # If date format is somehow invalid, only include on the current week (week_offset=0)
            if week_offset == 0:
                filtered_logs.append(log)
            
    # Sort descending: newest user mentioned date first, past as last
    filtered_logs.sort(key=lambda x: x["time"], reverse=True)
    
    return filtered_logs


# ========================================================
# MONTHLY/WEEKLY AGGREGATION & INSIGHT GENERATION ENGINE
# ========================================================

def format_min_to_time(avg_min: float) -> str:
    avg_min = int(round(avg_min))
    h = (avg_min // 60) % 24
    m = avg_min % 60
    period = "AM" if h < 12 else "PM"
    h_12 = h if 1 <= h <= 12 else (12 if h == 0 or h == 12 else h - 12)
    return f"{h_12:02d}:{m:02d} {period}"


def get_user_recommendations_data(userid: str):
    user = USERS_BY_ID.get(userid)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    logs = MEAL_LOGS.get(userid, [])
    now = datetime.now()
    
    # Normalize now to include all logs from today
    now = now.replace(hour=23, minute=59, second=59, microsecond=999999)
    
    # Define 4 weeks (28 days) relative to now
    week_ranges = []
    for i in range(4):
        end_w = now - timedelta(days=i*7)
        start_w = now - timedelta(days=(i+1)*7)
        week_ranges.append((start_w, end_w))
        
    # Group logs by week (Week 1 = days 0-6 ago, Week 2 = days 7-13 ago, etc.)
    weekly_logs = [[] for _ in range(4)]
    for log in logs:
        try:
            log_dt = datetime.fromisoformat(log["time"])
            for idx, (start_w, end_w) in enumerate(week_ranges):
                if start_w < log_dt <= end_w:
                    weekly_logs[idx].append(log)
                    break
        except Exception:
            pass
            
    GRADE_MAP = {"A+": 95, "A": 85, "B": 75, "C+": 65, "C-": 55, "D": 45}
    
    weekly_reports = []
    weekly_confidences = []
    
    for idx, w_logs in enumerate(weekly_logs):
        total_w_meals = len(w_logs)
        # Expected meals per week is 21 (3 meals * 7 days)
        w_confidence = min(100.0, (total_w_meals / 21.0) * 100.0)
        weekly_confidences.append(w_confidence)
        
        if total_w_meals == 0:
            continue
            
        total_w_cal = sum(log["report"]["calories"] for log in w_logs)
        avg_w_cal_per_meal = total_w_cal / total_w_meals
        w_avg_cal = total_w_cal / 7.0
        
        total_w_prot = sum(log["report"]["protein"] for log in w_logs)
        total_w_carbs = sum(log["report"]["carbs"] for log in w_logs)
        total_w_fat = sum(log["report"]["fat"] for log in w_logs)
        
        w_avg_prot = total_w_prot / 7.0
        w_avg_carbs = total_w_carbs / 7.0
        w_avg_fat = total_w_fat / 7.0
        
        avg_w_score = sum(GRADE_MAP.get(log["report"]["grade"], 75) for log in w_logs) / total_w_meals
        if avg_w_score >= 90: w_grade = "A+"
        elif avg_w_score >= 80: w_grade = "A"
        elif avg_w_score >= 70: w_grade = "B"
        elif avg_w_score >= 60: w_grade = "C+"
        elif avg_w_score >= 50: w_grade = "C-"
        else: w_grade = "D"
        
        distinct_w_foods = list(set(log["description"].strip().lower() for log in w_logs))
        w_food_freqs = {}
        for log in w_logs:
            food = log["description"].strip().lower()
            w_food_freqs[food] = w_food_freqs.get(food, 0) + 1
            
        # Group time distribution
        m_times, a_times, e_times, n_times = [], [], [], []
        for log in w_logs:
            try:
                log_dt = datetime.fromisoformat(log["time"])
                minutes = log_dt.hour * 60 + log_dt.minute
                h = log_dt.hour
                if 5 <= h < 12:
                    m_times.append(minutes)
                elif 12 <= h < 17:
                    a_times.append(minutes)
                elif 17 <= h < 21:
                    e_times.append(minutes)
                else:
                    n_times.append(minutes)
            except Exception:
                pass
                
        def get_avg_time_str(mins):
            if not mins: return "N/A"
            avg = sum(mins) / len(mins)
            return format_min_to_time(avg)
            
        w_time_consumption = {
            "morning": {"count": len(m_times), "avg_time": get_avg_time_str(m_times)},
            "afternoon": {"count": len(a_times), "avg_time": get_avg_time_str(a_times)},
            "evening": {"count": len(e_times), "avg_time": get_avg_time_str(e_times)},
            "night": {"count": len(n_times), "avg_time": get_avg_time_str(n_times)}
        }
        
        weekly_reports.append({
            "week_index": idx + 1,
            "average_calorie_per_meal": round(avg_w_cal_per_meal, 1),
            "total_meals_logged": total_w_meals,
            "weekly_average_calories": round(w_avg_cal, 1),
            "weekly_average_nutrition": {
                "average_protein": round(w_avg_prot, 1),
                "average_carbs": round(w_avg_carbs, 1),
                "average_fat": round(w_avg_fat, 1),
                "average_grade": w_grade
            },
            "distinct_foods": distinct_w_foods,
            "food_frequencies": w_food_freqs,
            "time_of_consumption": w_time_consumption,
            "confidence_score": round(w_confidence, 1)
        })
        
    all_month_logs = []
    for w_logs in weekly_logs:
        all_month_logs.extend(w_logs)
        
    total_meals_month = len(all_month_logs)
    monthly_confidence = sum(weekly_confidences) / 4.0
    
    if total_meals_month == 0:
        current_report_data = {
            "average_calories_per_meal": 0.0,
            "total_meals_logged": 0,
            "monthly_average_calories": 0.0,
            "monthly_average_nutrition": {
                "average_protein": 0.0,
                "average_carbs": 0.0,
                "average_fat": 0.0,
                "average_grade": "N/A"
            },
            "distinct_foods": [],
            "food_frequencies": {},
            "time_of_consumption": {
                "morning": {"count": 0, "avg_time": "N/A"},
                "afternoon": {"count": 0, "avg_time": "N/A"},
                "evening": {"count": 0, "avg_time": "N/A"},
                "night": {"count": 0, "avg_time": "N/A"}
            },
            "confidence_score": 0.0
        }
    else:
        total_cal_month = sum(log["report"]["calories"] for log in all_month_logs)
        avg_cal_per_meal_month = total_cal_month / total_meals_month
        monthly_avg_cal = total_cal_month / 28.0
        
        total_prot_month = sum(log["report"]["protein"] for log in all_month_logs)
        total_carbs_month = sum(log["report"]["carbs"] for log in all_month_logs)
        total_fat_month = sum(log["report"]["fat"] for log in all_month_logs)
        
        monthly_avg_prot = total_prot_month / 28.0
        monthly_avg_carbs = total_carbs_month / 28.0
        monthly_avg_fat = total_fat_month / 28.0
        
        avg_score_month = sum(GRADE_MAP.get(log["report"]["grade"], 75) for log in all_month_logs) / total_meals_month
        if avg_score_month >= 90: avg_grade_month = "A+"
        elif avg_score_month >= 80: avg_grade_month = "A"
        elif avg_score_month >= 70: avg_grade_month = "B"
        elif avg_score_month >= 60: avg_grade_month = "C+"
        elif avg_score_month >= 50: avg_grade_month = "C-"
        else: avg_grade_month = "D"
        
        food_freqs_month = {}
        for log in all_month_logs:
            food = log["description"].strip().lower()
            food_freqs_month[food] = food_freqs_month.get(food, 0) + 1
            
        distinct_foods_month = sorted(food_freqs_month.keys(), key=lambda x: food_freqs_month[x], reverse=True)
        
        m_times, a_times, e_times, n_times = [], [], [], []
        for log in all_month_logs:
            try:
                log_dt = datetime.fromisoformat(log["time"])
                minutes = log_dt.hour * 60 + log_dt.minute
                h = log_dt.hour
                if 5 <= h < 12:
                    m_times.append(minutes)
                elif 12 <= h < 17:
                    a_times.append(minutes)
                elif 17 <= h < 21:
                    e_times.append(minutes)
                else:
                    n_times.append(minutes)
            except Exception:
                pass
                
        def get_avg_time_str(mins):
            if not mins: return "N/A"
            avg = sum(mins) / len(mins)
            return format_min_to_time(avg)
            
        time_consumption_month = {
            "morning": {"count": len(m_times), "avg_time": get_avg_time_str(m_times)},
            "afternoon": {"count": len(a_times), "avg_time": get_avg_time_str(a_times)},
            "evening": {"count": len(e_times), "avg_time": get_avg_time_str(e_times)},
            "night": {"count": len(n_times), "avg_time": get_avg_time_str(n_times)}
        }
        
        current_report_data = {
            "average_calories_per_meal": round(avg_cal_per_meal_month, 1),
            "total_meals_logged": total_meals_month,
            "monthly_average_calories": round(monthly_avg_cal, 1),
            "monthly_average_nutrition": {
                "average_protein": round(monthly_avg_prot, 1),
                "average_carbs": round(monthly_avg_carbs, 1),
                "average_fat": round(monthly_avg_fat, 1),
                "average_grade": avg_grade_month
            },
            "distinct_foods": distinct_foods_month,
            "food_frequencies": food_freqs_month,
            "time_of_consumption": time_consumption_month,
            "confidence_score": round(monthly_confidence, 1)
        }
        
    return current_report_data, weekly_reports


def generate_insights_via_ollama(prompt: str) -> Optional[list]:
    try:
        payload = {
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "format": "json"
        }
        print(payload)
        req_data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            OLLAMA_API_URL,
            data=req_data,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as response:
            res = json.loads(response.read().decode('utf-8'))
            text_response = res.get("response", "")
            print(text_response)
            data = json.loads(text_response)
            print(data)
            if "insights" in data and isinstance(data["insights"], list):
                return [str(pt) for pt in data["insights"]]
    except Exception as e:
        print(f"Error calling Ollama API: {e}")
    return None


def generate_insights_via_llm(user: UserInDB, report_data: dict) -> list:
    user_details_text = extract_user_details(user)
    previous_insights = getattr(user, 'insights', [])
    previous_insights_str = "\n".join(f"- {pt}" for pt in previous_insights) if previous_insights else "None"
    print("executing api", LLM_PROVIDER)
    distinct_foods = report_data.get("distinct_foods", [])
    food_freqs = report_data.get("food_frequencies", {})
    distinct_foods_list_str = ", ".join(f"{food} ({food_freqs[food]}x)" for food in distinct_foods) if distinct_foods else "None"
    
    prompt = f"""You are an expert AI nutritionist and health advisor.
The user has the following profile and health goals:
{user_details_text}

Here is the monthly aggregated nutrition report for the user:
- Average calories per meal: {report_data['average_calories_per_meal']} kcal
- Total meals logged: {report_data['total_meals_logged']}
- Monthly average daily calories: {report_data['monthly_average_calories']} kcal
- Monthly average daily nutrition:
  * Protein: {report_data['monthly_average_nutrition']['average_protein']}g
  * Carbs: {report_data['monthly_average_nutrition']['average_carbs']}g
  * Fat: {report_data['monthly_average_nutrition']['average_fat']}g
  * Grade: {report_data['monthly_average_nutrition']['average_grade']}
- Distinct foods consumed (sorted by frequency): {distinct_foods_list_str}
- Average time of consumption:
  * Morning: {report_data['time_of_consumption']['morning']['avg_time']} ({report_data['time_of_consumption']['morning']['count']} meals)
  * Afternoon: {report_data['time_of_consumption']['afternoon']['avg_time']} ({report_data['time_of_consumption']['afternoon']['count']} meals)
  * Evening: {report_data['time_of_consumption']['evening']['avg_time']} ({report_data['time_of_consumption']['evening']['count']} meals)
  * Night: {report_data['time_of_consumption']['night']['avg_time']} ({report_data['time_of_consumption']['night']['count']} meals)
- Confidence score of report (0-100%): {report_data['confidence_score']}%
  (A lower score means fewer meals were logged than expected, so the report might be incomplete.)

Previous insights:
{previous_insights_str}

Please generate a list of 4-6 personalized, actionable dietary and wellness insights.
Consider the user's goals (e.g., protein targets, weight management, glycemic care), food frequencies, and timing of meals.
If the confidence score is low, suggest logging meals more consistently.
Provide your response as a JSON object with a single key "insights" containing a list of strings.
Example output format:
{{
  "insights": [
    "Your protein intake is average, but you can increase it by adding eggs or Greek yogurt to your morning meals.",
    "You consume pizza frequently (5 times this month). Consider replacing some of these meals with fresh salads."
  ]
}}
"""
    if LLM_PROVIDER == "gemini":
        api_key = os.environ.get("GEMINI_API_KEY")
        if api_key:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
                payload = {
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "responseMimeType": "application/json"
                    }
                }
                req_data = json.dumps(payload).encode('utf-8')
                req = urllib.request.Request(
                    url, 
                    data=req_data, 
                    headers={'Content-Type': 'application/json'}
                )
                with urllib.request.urlopen(req, timeout=10) as response:
                    res = json.loads(response.read().decode('utf-8'))
                    text_response = res["candidates"][0]["content"]["parts"][0]["text"]
                    data = json.loads(text_response)
                    if "insights" in data and isinstance(data["insights"], list):
                        return [str(pt) for pt in data["insights"]]
            except Exception as e:
                print(f"Error calling Gemini API: {e}")
        else:
            print("Gemini provider selected, but GEMINI_API_KEY environment variable is not set.")
            
    elif LLM_PROVIDER == "ollama":
        insights = generate_insights_via_ollama(prompt)
        if insights is not None:
            return insights

    return generate_fallback_insights(user, report_data)


def generate_fallback_insights(user: UserInDB, report_data: dict) -> list:
    insights = []
    bio_text = extract_user_details(user).lower()
    
    conf = report_data.get("confidence_score", 0.0)
    if conf < 30:
        insights.append(f"Your logging consistency is low ({conf}%). Try to log at least 3 meals a day to improve recommendation accuracy.")
    elif conf < 70:
        insights.append(f"Your logging confidence is moderate ({conf}%). Consistency is key to unlocking deep nutritional insights.")
    else:
        insights.append(f"Excellent tracking! With a confidence score of {conf}%, these recommendations are highly customized to your actual patterns.")
        
    avg_prot = report_data["monthly_average_nutrition"]["average_protein"]
    if "protein" in bio_text or "muscle" in bio_text or "gain" in bio_text:
        if avg_prot < 70:
            insights.append(f"Your daily average protein is {avg_prot}g. To support muscle growth, aim to raise this to 100g+ by adding lean meats, tofu, or protein supplements.")
        else:
            insights.append(f"Great job meeting your protein targets! You're averaging {avg_prot}g/day, which is excellent for recovery and hypertrophy.")
            
    avg_cal = report_data["monthly_average_calories"]
    if "weight" in bio_text or "lose" in bio_text or "deficit" in bio_text:
        if avg_cal > 2000:
            insights.append(f"Your daily calorie average is {avg_cal} kcal. To support weight loss, consider lowering this to 1500-1800 kcal/day through portion control.")
        else:
            insights.append(f"Nice job managing your energy intake. You are averaging {avg_cal} kcal/day, which aligns well with a fat loss deficit.")
            
    food_freqs = report_data.get("food_frequencies", {})
    fast_foods = [f for f in food_freqs if any(k in f for k in ["pizza", "burger", "fries", "shake", "fries", "nuggets"])]
    if fast_foods:
        top_fast = sorted(fast_foods, key=lambda x: food_freqs[x], reverse=True)[0]
        count = food_freqs[top_fast]
        if count >= 3:
            insights.append(f"You logged {top_fast} {count} times this month. High-sodium processed meals can hinder cardiovascular goals; try swapping for home-cooked versions.")
            
    night_meals = report_data["time_of_consumption"]["night"]["count"]
    if night_meals > 0:
        pct = (night_meals / report_data["total_meals_logged"]) * 100 if report_data["total_meals_logged"] > 0 else 0
        if pct > 20:
            insights.append(f"Over {round(pct)}% of your meals are logged late at night. Late-night digestion can disrupt sleep quality and metabolic health. Try eating heavier meals earlier.")
            
    if len(insights) < 4:
        avg_grade = report_data["monthly_average_nutrition"]["average_grade"]
        if avg_grade in ["A+", "A", "B"]:
            insights.append(f"Your average monthly meal grade is '{avg_grade}'. Keep making high-quality whole food selections!")
        else:
            insights.append(f"Your average monthly meal grade is '{avg_grade}'. Try incorporating more vegetables, fruits, and lean protein to boost your score.")
            
    if len(insights) < 4:
        distinct_count = len(report_data.get("distinct_foods", []))
        if distinct_count < 5:
            insights.append("Your diet is very concentrated on a few foods. Try to eat a wider variety of colorful vegetables and whole foods to improve micronutrient coverage.")
        else:
            insights.append(f"Good dietary variety! You consumed {distinct_count} distinct food items this month, keeping your gut microbiome diverse.")

    return insights[:6]


@app.get("/api/users/{userid}/recommendations")
def get_user_recommendations(userid: str):
    print("get_user_recommendations called for user:", userid)
    if userid not in USERS_BY_ID:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found."
        )
        
    user = USERS_BY_ID[userid]
    
    # 1. Compute weekly and monthly aggregations
    current_report_data, weekly_reports = get_user_recommendations_data(userid)
    
    # 2. Check report cache and insights cache
    if not hasattr(user, 'report_cache') or user.report_cache is None:
        user.report_cache = {}
    if not hasattr(user, 'insights') or user.insights is None:
        user.insights = []
    if not hasattr(user, 'last_insight_generated_time'):
        user.last_insight_generated_time = ""
    if not hasattr(user, 'insight_version'):
        user.insight_version = 0
        
    if user.report_cache == current_report_data and user.insights:
        insights = user.insights
        last_gen_time = user.last_insight_generated_time
        version = user.insight_version
    else:
        insights = generate_insights_via_llm(user, current_report_data)
        
        user.report_cache = current_report_data
        user.insights = insights
        user.last_insight_generated_time = datetime.now().isoformat()
        user.insight_version += 1
        
        save_to_json()
        
        last_gen_time = user.last_insight_generated_time
        version = user.insight_version
        
    return {
        "monthly_data": {
            **current_report_data,
            "snapshot_version": "1.0.0",
            "last_insight_generated_time": last_gen_time,
            "insight_version": version,
            "insights": insights,
            "report_cache": user.report_cache
        },
        "weekly_reports": weekly_reports
    }


def stream_recommendations_generator(userid: str):
    user = USERS_BY_ID.get(userid)
    if not user:
        yield json.dumps({"type": "error", "detail": "User not found"}) + "\n"
        return

    # Initialize cache fields if they are missing
    if not hasattr(user, 'report_cache') or user.report_cache is None:
        user.report_cache = {}
    if not hasattr(user, 'insights') or user.insights is None:
        user.insights = []
    if not hasattr(user, 'last_insight_generated_time'):
        user.last_insight_generated_time = ""
    if not hasattr(user, 'insight_version'):
        user.insight_version = 0

    # 1. Compute aggregations
    current_report_data, weekly_reports = get_user_recommendations_data(userid)

    # 2. Check if cached
    is_cached = (user.report_cache == current_report_data and len(user.insights) > 0)

    if is_cached:
        meta = {
            "type": "meta",
            "cached": True,
            "monthly_data": {
                **current_report_data,
                "snapshot_version": "1.0.0",
                "last_insight_generated_time": user.last_insight_generated_time,
                "insight_version": user.insight_version,
                "insights": user.insights,
                "report_cache": user.report_cache
            },
            "weekly_reports": weekly_reports
        }
        yield json.dumps(meta) + "\n"
        return
    else:
        # Cache miss: send metadata first (with insights empty)
        meta = {
            "type": "meta",
            "cached": False,
            "monthly_data": {
                **current_report_data,
                "snapshot_version": "1.0.0",
                "last_insight_generated_time": "",
                "insight_version": user.insight_version,
                "insights": [],
                "report_cache": {}
            },
            "weekly_reports": weekly_reports
        }
        yield json.dumps(meta) + "\n"

        # Now begin LLM prompt generation
        user_details_text = extract_user_details(user)
        previous_insights = getattr(user, 'insights', [])
        previous_insights_str = "\n".join(f"- {pt}" for pt in previous_insights) if previous_insights else "None"
        
        distinct_foods = current_report_data.get("distinct_foods", [])
        food_freqs = current_report_data.get("food_frequencies", {})
        distinct_foods_list_str = ", ".join(f"{food} ({food_freqs[food]}x)" for food in distinct_foods) if distinct_foods else "None"
        
        prompt = f"""You are an expert AI nutritionist and health advisor.
The user has the following profile and health goals:
{user_details_text}

Here is the monthly aggregated nutrition report for the user:
- Average calories per meal: {current_report_data['average_calories_per_meal']} kcal
- Total meals logged: {current_report_data['total_meals_logged']}
- Monthly average daily calories: {current_report_data['monthly_average_calories']} kcal
- Monthly average daily nutrition:
  * Protein: {current_report_data['monthly_average_nutrition']['average_protein']}g
  * Carbs: {current_report_data['monthly_average_nutrition']['average_carbs']}g
  * Fat: {current_report_data['monthly_average_nutrition']['average_fat']}g
  * Grade: {current_report_data['monthly_average_nutrition']['average_grade']}
- Distinct foods consumed (sorted by frequency): {distinct_foods_list_str}
- Average time of consumption:
  * Morning: {current_report_data['time_of_consumption']['morning']['avg_time']} ({current_report_data['time_of_consumption']['morning']['count']} meals)
  * Afternoon: {current_report_data['time_of_consumption']['afternoon']['avg_time']} ({current_report_data['time_of_consumption']['afternoon']['count']} meals)
  * Evening: {current_report_data['time_of_consumption']['evening']['avg_time']} ({current_report_data['time_of_consumption']['evening']['count']} meals)
  * Night: {current_report_data['time_of_consumption']['night']['avg_time']} ({current_report_data['time_of_consumption']['night']['count']} meals)
- Confidence score of report (0-100%): {current_report_data['confidence_score']}%
  (A lower score means fewer meals were logged than expected, so the report might be incomplete.)

Previous insights:
{previous_insights_str}

Please generate a list of 4-6 personalized, actionable dietary and wellness insights.
Consider the user's goals (e.g., protein targets, weight management, glycemic care), food frequencies, and timing of meals.
If the confidence score is low, suggest logging meals more consistently.
Provide your response as a JSON object with a single key "insights" containing a list of strings.
Example output format:
{{
  "insights": [
    "Your protein intake is average, but you can increase it by adding eggs or Greek yogurt to your morning meals.",
    "You consume pizza frequently (5 times this month). Consider replacing some of these meals with fresh salads."
  ]
}}
"""

        insights = []
        full_raw_text = ""
        success = False

        if LLM_PROVIDER == "ollama":
            try:
                payload = {
                    "model": OLLAMA_MODEL,
                    "prompt": prompt,
                    "stream": True,
                    "format": "json"
                }
                req_data = json.dumps(payload).encode('utf-8')
                req = urllib.request.Request(
                    OLLAMA_API_URL,
                    data=req_data,
                    headers={'Content-Type': 'application/json'}
                )
                response = urllib.request.urlopen(req)
                for line in response:
                    if line:
                        chunk = json.loads(line.decode('utf-8'))
                        token = chunk.get("response", "")
                        full_raw_text += token
                        yield json.dumps({"type": "token", "token": token}) + "\n"
                success = True
            except Exception as e:
                print(f"Error streaming from Ollama: {e}")
                yield json.dumps({"type": "error", "detail": f"Ollama error: {str(e)}"}) + "\n"

        elif LLM_PROVIDER == "gemini":
            api_key = os.environ.get("GEMINI_API_KEY")
            if api_key:
                try:
                    # For Gemini, we make a live call, retrieve the text, and stream it locally
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
                    payload = {
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {
                            "responseMimeType": "application/json"
                        }
                    }
                    req_data = json.dumps(payload).encode('utf-8')
                    req = urllib.request.Request(
                        url, 
                        data=req_data, 
                        headers={'Content-Type': 'application/json'}
                    )
                    with urllib.request.urlopen(req, timeout=20) as response:
                        res = json.loads(response.read().decode('utf-8'))
                        text_response = res["candidates"][0]["content"]["parts"][0]["text"]
                        full_raw_text = text_response
                        # Stream the characters back to the UI to simulate typing
                        import time
                        for char in full_raw_text:
                            yield json.dumps({"type": "token", "token": char}) + "\n"
                            time.sleep(0.001)
                    success = True
                except Exception as e:
                    print(f"Error calling Gemini for stream: {e}")
                    yield json.dumps({"type": "error", "detail": f"Gemini error: {str(e)}"}) + "\n"
            else:
                print("Gemini provider selected but key is missing in environment.")

        # Parse insights from the streamed text
        if success and full_raw_text:
            try:
                data = json.loads(full_raw_text)
                if "insights" in data and isinstance(data["insights"], list):
                    insights = [str(pt) for pt in data["insights"]]
            except Exception:
                # Regex parsing fallback
                import re
                insights = re.findall(r'"([^"]*)"', full_raw_text)
                insights = [pt for pt in insights if len(pt) > 10 and pt != "insights"]

        # If LLM execution failed or returned empty insights, run local fallback
        if not insights:
            insights = generate_fallback_insights(user, current_report_data)
            fallback_json = json.dumps({"insights": insights}, indent=2)
            import time
            for char in fallback_json:
                yield json.dumps({"type": "token", "token": char}) + "\n"
                time.sleep(0.002)

        # Update cache on user DB
        user.report_cache = current_report_data
        user.insights = insights
        user.last_insight_generated_time = datetime.now().isoformat()
        user.insight_version += 1
        save_to_json()

        # Send final completion event
        yield json.dumps({
            "type": "done",
            "insights": insights,
            "insight_version": user.insight_version,
            "last_insight_generated_time": user.last_insight_generated_time
        }) + "\n"


@app.get("/api/users/{userid}/recommendations/stream")
def get_user_recommendations_stream(userid: str):
    if userid not in USERS_BY_ID:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found."
        )
    from fastapi.responses import StreamingResponse
    return StreamingResponse(
        stream_recommendations_generator(userid),
        media_type="application/x-ndjson"
    )

# Load details on start
load_from_json()
