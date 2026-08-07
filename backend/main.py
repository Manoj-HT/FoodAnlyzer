import uuid
import json
import os
import io
import tempfile
import time
import re
import urllib.request
import urllib.parse
import sqlite3
import hashlib
from typing import Dict, List, Optional, Any
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
# LLM CONFIGURATION & GEMINI FALLBACK ENGINE
# ========================================================
GEMINI_MODELS = [
    "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest",
]

def get_gemini_api_key() -> Optional[str]:
    key = os.environ.get("GEMINI_API_KEY")
    if key and key.strip():
        return key.strip()
    
    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidate_paths = [
        os.path.join(base_dir, "..", "apikey.md"),
        os.path.join(base_dir, "apikey.md"),
        "/home/mht/Projects/College/FoodAnlyzer/apikey.md"
    ]
    for path in candidate_paths:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    lines = [line.strip() for line in f if line.strip()]
                    if lines and lines[0]:
                        return lines[0]
            except Exception as e:
                print(f"[GEMINI SETUP] Warning reading {path}: {e}")
    return None

def call_gemini_generate_with_fallback(prompt: str, response_json: bool = True) -> tuple[Optional[str], str]:
    api_key = get_gemini_api_key()
    if not api_key:
        print("[GEMINI ENGINE] API key not found in environment or apikey.md.")
        return None, "SYSTEM"

    payload = {
        "contents": [{"parts": [{"text": prompt}]}]
    }
    if response_json:
        payload["generationConfig"] = {
            "responseMimeType": "application/json"
        }

    for model in GEMINI_MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        req_data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(url, data=req_data, headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                res = json.loads(response.read().decode('utf-8'))
                text_response = res["candidates"][0]["content"]["parts"][0]["text"]
                return text_response, f"Gemini ({model})"
        except Exception as e:
            print(f"[GEMINI ENGINE] Model '{model}' failed: {e}. Retrying next available model...")
            continue

    return None, "SYSTEM"

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "gemini" if get_gemini_api_key() else "ollama")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen1.5")
OLLAMA_API_URL = os.getenv("OLLAMA_API_URL", "http://localhost:11434/api/generate")

app = FastAPI(title="FoodAnalyzer API")

# Enable CORS for Angular Frontend running on http://localhost:4200
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Password Encryption & Security Helpers
def hash_password(password: str) -> str:
    if not password:
        return ""
    if password.startswith("pbkdf2_sha256$"):
        return password
    salt = os.urandom(16)
    hashed = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000)
    return f"pbkdf2_sha256${salt.hex()}${hashed.hex()}"

def verify_password(password: str, stored_hash: str) -> bool:
    if not stored_hash or not password:
        return False
    if stored_hash.startswith("pbkdf2_sha256$"):
        parts = stored_hash.split("$")
        if len(parts) != 3:
            return False
        try:
            salt = bytes.fromhex(parts[1])
            expected_hash = parts[2]
            computed_hash = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000).hex()
            return computed_hash == expected_hash
        except Exception as e:
            print(f"[AUTH ERROR] Failed verifying password hash: {e}")
            return False
    else:
        # Fallback migration check for legacy plaintext passwords
        return password == stored_hash


# Persistent User DB Model
class UserInDB:
    def __init__(self, name: str, email: str, password: str = ""):
        self.id = str(uuid.uuid4())
        self.name = name
        self.email = email
        self.password = password
        self.password_hash = hash_password(password) if password else ""
        self.google_id = ""
        self.picture = ""
        self.confirmed = False
        self.token = f"tok_{uuid.uuid4().hex[:16]}"
        self.report_cache = {}
        self.insights = []
        self.last_insight_generated_time = ""
        self.insight_version = 0
        self.structured_details = {}


# Global User Cache (Synced with Supabase & SQLite DB)
USERS_BY_EMAIL: Dict[str, UserInDB] = {}
USERS_BY_ID: Dict[str, UserInDB] = {}

DATA_DIR = os.getenv("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
os.makedirs(DATA_DIR, exist_ok=True)
SQLITE_DB_PATH = os.path.join(DATA_DIR, "users.db")
DB_FILE = os.path.join(DATA_DIR, "users.json")

# Supabase Cloud Database Client
def _load_env_file():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    if not os.environ.get(k.strip()):
                        os.environ[k.strip()] = v.strip().strip("'\"")

_load_env_file()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ppgwmvwqnxlbjujljfdc.supabase.co").strip().strip("'\"")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "").strip().strip("'\"")
supabase_client = None

def get_supabase_client():
    global supabase_client
    if supabase_client is not None:
        return supabase_client
    url = os.environ.get("SUPABASE_URL", "https://ppgwmvwqnxlbjujljfdc.supabase.co").strip().strip("'\"").rstrip('/')
    if url.endswith('/rest/v1'):
        url = url[:-8].rstrip('/')
    key = os.environ.get("SUPABASE_KEY", "").strip().strip("'\"")
    print(f"[SUPABASE ENGINE] Initializing... URL='{url}', Key Length={len(key)}, Prefix='{key[:8] if key else 'EMPTY'}...', Suffix='...{key[-4:] if len(key)>4 else ''}'")
    if not key:
        print("[SUPABASE ENGINE] Warning: SUPABASE_KEY environment variable is empty. Please set SUPABASE_KEY in Render Environment Variables.")
        return None
    if url and key:
        try:
            from supabase import create_client
            supabase_client = create_client(url, key)
            print("[SUPABASE ENGINE] Initialized Supabase Cloud DB client successfully.")
            return supabase_client
        except Exception as e:
            import traceback
            print(f"[SUPABASE ENGINE] Failed to initialize client: {type(e).__name__} -> {e}")
            traceback.print_exc()
            return None
    return None

import urllib.request

def _supabase_rest_request(endpoint: str, method: str = 'GET', payload: any = None):
    url = os.environ.get("SUPABASE_URL", "https://ppgwmvwqnxlbjujljfdc.supabase.co").strip().strip("'\"").rstrip('/')
    if not url.endswith('/rest/v1'):
        url = f"{url}/rest/v1"
    full_url = f"{url}/{endpoint.lstrip('/')}"
    key = os.environ.get("SUPABASE_KEY", "").strip().strip("'\"")
    if not key:
        return None
    headers = {
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
    }
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(full_url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        body = resp.read().decode('utf-8')
        return json.loads(body) if body else []

def save_user_to_supabase(user: UserInDB) -> bool:
    data = {
        "id": user.id,
        "name": user.name,
        "email": user.email.lower(),
        "password_hash": user.password_hash or "",
        "google_id": getattr(user, 'google_id', ''),
        "picture": getattr(user, 'picture', ''),
        "confirmed": user.confirmed,
        "token": user.token,
        "report_cache": user.report_cache or {},
        "insights": user.insights or [],
        "last_insight_generated_time": user.last_insight_generated_time or "",
        "insight_version": user.insight_version or 0,
        "structured_details": user.structured_details or {}
    }
    client = get_supabase_client()
    if client:
        try:
            client.table("users").upsert(data).execute()
            print(f"[SUPABASE ENGINE] Successfully saved user {user.email} to Supabase Cloud DB via SDK.")
            return True
        except Exception as e:
            print(f"[SUPABASE ENGINE] SDK save error ({e}), attempting REST HTTP fallback...")

    try:
        _supabase_rest_request("users", method="POST", payload=[data])
        print(f"[SUPABASE ENGINE] Successfully saved user {user.email} to Supabase Cloud DB via REST API.")
        return True
    except Exception as e:
        print(f"[SUPABASE ENGINE] Error saving user {user.email} to Supabase REST: {e}")
        return False

def load_users_from_supabase() -> bool:
    global USERS_BY_EMAIL, USERS_BY_ID
    rows = None
    client = get_supabase_client()
    if client:
        try:
            res = client.table("users").select("*").execute()
            rows = res.data
        except Exception as e:
            print(f"[SUPABASE ENGINE] SDK load error ({e}), attempting REST HTTP fallback...")

    if rows is None:
        try:
            rows = _supabase_rest_request("users?select=*")
        except Exception as e:
            print(f"[SUPABASE ENGINE] REST HTTP load error: {e}")
            return False

    if rows:
        try:
            for row in rows:
                u = UserInDB(name=row["name"], email=row["email"], password="")
                u.id = row["id"]
                u.password_hash = row.get("password_hash") or ""
                u.password = u.password_hash
                u.google_id = row.get("google_id") or ""
                u.picture = row.get("picture") or ""
                u.confirmed = bool(row.get("confirmed", False))
                u.token = row.get("token") or u.token
                u.report_cache = row.get("report_cache") if isinstance(row.get("report_cache"), dict) else {}
                u.insights = row.get("insights") if isinstance(row.get("insights"), list) else []
                u.last_insight_generated_time = row.get("last_insight_generated_time") or ""
                u.insight_version = row.get("insight_version") or 0
                u.structured_details = row.get("structured_details") if isinstance(row.get("structured_details"), dict) else {}

                USERS_BY_EMAIL[u.email.lower()] = u
                USERS_BY_ID[u.id] = u
            print(f"[SUPABASE ENGINE] Successfully loaded {len(rows)} users from Supabase Cloud DB.")
            return True
        except Exception as e:
            print(f"[SUPABASE ENGINE] Error parsing loaded users from Supabase: {e}")
            return False
    return False

def init_sqlite_db():
    conn = sqlite3.connect(SQLITE_DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            google_id TEXT,
            picture TEXT,
            confirmed INTEGER DEFAULT 0,
            token TEXT,
            report_cache TEXT,
            insights TEXT,
            last_insight_generated_time TEXT,
            insight_version INTEGER DEFAULT 0,
            structured_details TEXT
        )
    """)
    conn.commit()
    conn.close()

def save_user_to_db(user: UserInDB):
    if user.password and not user.password_hash:
        user.password_hash = hash_password(user.password)

    # Sync to Supabase Cloud DB if configured
    save_user_to_supabase(user)

    # Save to local SQLite database as well
    conn = sqlite3.connect(SQLITE_DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO users (
            id, name, email, password_hash, google_id, picture, confirmed, token,
            report_cache, insights, last_insight_generated_time, insight_version, structured_details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            email=excluded.email,
            password_hash=excluded.password_hash,
            google_id=excluded.google_id,
            picture=excluded.picture,
            confirmed=excluded.confirmed,
            token=excluded.token,
            report_cache=excluded.report_cache,
            insights=excluded.insights,
            last_insight_generated_time=excluded.last_insight_generated_time,
            insight_version=excluded.insight_version,
            structured_details=excluded.structured_details
    """, (
        user.id,
        user.name,
        user.email.lower(),
        user.password_hash or "",
        getattr(user, 'google_id', ''),
        getattr(user, 'picture', ''),
        1 if user.confirmed else 0,
        user.token,
        json.dumps(user.report_cache),
        json.dumps(user.insights),
        user.last_insight_generated_time or "",
        user.insight_version or 0,
        json.dumps(user.structured_details)
    ))
    conn.commit()
    conn.close()

def save_to_json():
    try:
        data = {}
        for user in USERS_BY_ID.values():
            save_user_to_db(user)
            data[user.id] = {
                "id": user.id,
                "name": user.name,
                "email": user.email,
                "password": user.password_hash or user.password,
                "google_id": getattr(user, 'google_id', ''),
                "picture": getattr(user, 'picture', ''),
                "confirmed": user.confirmed,
                "token": user.token,
                "report_cache": user.report_cache,
                "insights": user.insights,
                "last_insight_generated_time": user.last_insight_generated_time,
                "insight_version": user.insight_version,
                "structured_details": user.structured_details
            }
        with open(DB_FILE, "w") as f:
            json.dump(data, f, indent=4)
    except Exception as e:
        print(f"Error saving to database / JSON file: {e}")

def load_users_from_db():
    global USERS_BY_EMAIL, USERS_BY_ID
    
    # 1. Try loading from Supabase Cloud DB first
    if load_users_from_supabase():
        # Sync loaded Supabase users into local SQLite DB for fallback caching
        for u in USERS_BY_ID.values():
            init_sqlite_db()
            conn = sqlite3.connect(SQLITE_DB_PATH)
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO users (
                    id, name, email, password_hash, google_id, picture, confirmed, token,
                    report_cache, insights, last_insight_generated_time, insight_version, structured_details
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, email=excluded.email, password_hash=excluded.password_hash,
                    google_id=excluded.google_id, picture=excluded.picture, confirmed=excluded.confirmed,
                    token=excluded.token, report_cache=excluded.report_cache, insights=excluded.insights,
                    last_insight_generated_time=excluded.last_insight_generated_time,
                    insight_version=excluded.insight_version, structured_details=excluded.structured_details
            """, (
                u.id, u.name, u.email.lower(), u.password_hash or "", getattr(u, 'google_id', ''),
                getattr(u, 'picture', ''), 1 if u.confirmed else 0, u.token,
                json.dumps(u.report_cache), json.dumps(u.insights),
                u.last_insight_generated_time or "", u.insight_version or 0,
                json.dumps(u.structured_details)
            ))
            conn.commit()
            conn.close()
        return

    # 2. Fallback to local SQLite database if Supabase is not configured or offline
    init_sqlite_db()
    conn = sqlite3.connect(SQLITE_DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users")
    rows = cursor.fetchall()
    conn.close()

    if rows:
        for row in rows:
            u = UserInDB(name=row["name"], email=row["email"], password="")
            u.id = row["id"]
            u.password_hash = row["password_hash"] or ""
            u.password = u.password_hash
            u.google_id = row["google_id"] or ""
            u.picture = row["picture"] or ""
            u.confirmed = bool(row["confirmed"])
            u.token = row["token"] or u.token
            try:
                u.report_cache = json.loads(row["report_cache"]) if row["report_cache"] else {}
            except Exception:
                u.report_cache = {}
            try:
                u.insights = json.loads(row["insights"]) if row["insights"] else []
            except Exception:
                u.insights = []
            u.last_insight_generated_time = row["last_insight_generated_time"] or ""
            u.insight_version = row["insight_version"] or 0
            try:
                u.structured_details = json.loads(row["structured_details"]) if row["structured_details"] else {}
            except Exception:
                u.structured_details = {}

            USERS_BY_EMAIL[u.email.lower()] = u
            USERS_BY_ID[u.id] = u
        print(f"[DB ENGINE] Successfully loaded {len(rows)} users from SQLite database.")
        return

    # Fallback import from users.json if SQLite is empty
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, "r") as f:
                data = json.load(f)
            for uid, udata in data.items():
                pwd = udata.get("password", "")
                user = UserInDB(
                    name=udata["name"],
                    email=udata["email"],
                    password=pwd
                )
                user.id = udata["id"]
                user.confirmed = udata.get("confirmed", False)
                user.token = udata.get("token", user.token)
                user.report_cache = udata.get("report_cache", {})
                user.insights = udata.get("insights", [])
                user.last_insight_generated_time = udata.get("last_insight_generated_time", "")
                user.insight_version = udata.get("insight_version", 0)
                user.google_id = udata.get("google_id", "")
                user.picture = udata.get("picture", "")
                
                if "structured_details" in udata and udata["structured_details"]:
                    user.structured_details = udata["structured_details"]
                else:
                    legacy_bio = udata.get("bio", "")
                    legacy_mods = udata.get("modifications", [])
                    if legacy_bio or legacy_mods:
                        fallback_res = run_fallback_user_analysis(legacy_bio, legacy_mods)
                        user.structured_details = fallback_res["structured_details"]
                    else:
                        user.structured_details = {}
                
                if pwd and not pwd.startswith("pbkdf2_sha256$"):
                    user.password_hash = hash_password(pwd)
                else:
                    user.password_hash = pwd

                USERS_BY_EMAIL[user.email.lower()] = user
                USERS_BY_ID[user.id] = user
                save_user_to_db(user)
            print(f"[DB ENGINE] Successfully imported {len(USERS_BY_ID)} users from users.json into SQLite database.")
            return
        except Exception as e:
            print(f"Error importing users.json to database: {e}")

    # Seed mock user if no records exist
    mock_user = UserInDB(
        name="Jane Doe",
        email="jane@example.com",
        password="password123"
    )
    mock_user.structured_details = run_fallback_user_analysis(
        "I am a 30-year-old nurse. I love running, high protein meals, and want to lose weight.", []
    )["structured_details"]
    USERS_BY_EMAIL[mock_user.email.lower()] = mock_user
    USERS_BY_ID[mock_user.id] = mock_user
    save_user_to_db(mock_user)
    save_to_json()


def load_from_json():
    load_users_from_db()


# Pydantic Schemas for Requests & Responses
class CheckEmailRequest(BaseModel):
    email: EmailStr
    credential: Optional[str] = None
    google_id: Optional[str] = None

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

class GoogleLoginRequest(BaseModel):
    credential: Optional[str] = None
    email: Optional[str] = None
    name: Optional[str] = None
    google_id: Optional[str] = None
    picture: Optional[str] = None


# Helper: Unified LLM Client
def call_llm_api(prompt: str, response_json: bool = True) -> Optional[str]:
    print(f"Calling LLM ({LLM_PROVIDER}) with prompt...")
    if LLM_PROVIDER == "gemini" or get_gemini_api_key():
        res_text, engine_used = call_gemini_generate_with_fallback(prompt, response_json)
        if res_text:
            print(f"[LLM API] Success using {engine_used}")
            return res_text
        print("[LLM API] All Gemini models failed or returned empty.")

    if LLM_PROVIDER == "ollama":
        try:
            payload = {
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False
            }
            if response_json:
                payload["format"] = "json"
            req_data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(
                OLLAMA_API_URL,
                data=req_data,
                headers={'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(req, timeout=30) as response:
                res = json.loads(response.read().decode('utf-8'))
                return res.get("response")
        except Exception as e:
            print(f"Error calling Ollama API: {e}")
            return None
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
    google_email = None
    google_name = None
    google_sub = payload.google_id
    
    # 1. First check if Google OAuth JWT credential was passed
    if payload.credential:
        try:
            import base64
            parts = payload.credential.split('.')
            if len(parts) >= 2:
                padded = parts[1] + '=' * (-len(parts[1]) % 4)
                decoded_bytes = base64.b64decode(padded)
                data = json.loads(decoded_bytes.decode('utf-8'))
                google_email = data.get("email")
                google_name = data.get("name")
                if not google_sub:
                    google_sub = data.get("sub")
        except Exception as e:
            print(f"[CHECK API] JWT parse warning: {e}")

    # Determine email to look up
    target_email = (google_email or payload.email or "").strip().lower()

    # 2. Look up in persistent database / memory cache
    user = USERS_BY_EMAIL.get(target_email) if target_email else None
    if not user and google_sub:
        for u in USERS_BY_ID.values():
            if getattr(u, 'google_id', '') == google_sub:
                user = u
                break

    if user:
        return {
            "exists": True,
            "user": {
                "id": user.id,
                "email": user.email,
                "name": user.name
            },
            "is_google": bool(getattr(user, 'google_id', '') or not user.password_hash or "google" in user.token)
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


@app.post("/api/users/google-login")
def google_login(payload: GoogleLoginRequest):
    email = None
    name = None
    google_sub = payload.google_id
    
    if payload.credential:
        try:
            import base64
            parts = payload.credential.split('.')
            if len(parts) >= 2:
                padded = parts[1] + '=' * (-len(parts[1]) % 4)
                decoded_bytes = base64.b64decode(padded)
                data = json.loads(decoded_bytes.decode('utf-8'))
                email = data.get("email")
                name = data.get("name")
                if not google_sub:
                    google_sub = data.get("sub")
        except Exception as e:
            print(f"[GOOGLE OAUTH] JWT parse error: {e}")
            
    if not email:
        email = payload.email
    if not name:
        name = payload.name
        
    if not email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not extract email from Google credential."
        )

    clean_email = email.strip().lower()
    clean_name = (name or clean_email.split('@')[0]).strip()
    
    user = USERS_BY_EMAIL.get(clean_email)
    if not user and google_sub:
        for u in USERS_BY_ID.values():
            if getattr(u, 'google_id', '') == google_sub:
                user = u
                break

    if not user:
        user = UserInDB(
            name=clean_name,
            email=clean_email,
            password=""
        )
        user.google_id = google_sub or ""
        user.picture = payload.picture or ""
        user.confirmed = True
        user.password_hash = hash_password(f"google_oauth_{user.id}")
        USERS_BY_EMAIL[clean_email] = user
        USERS_BY_ID[user.id] = user
        save_to_json()
    else:
        if google_sub and not getattr(user, 'google_id', ''):
            user.google_id = google_sub
        if payload.picture and not getattr(user, 'picture', ''):
            user.picture = payload.picture
        save_to_json()
        
    has_details = bool(user.structured_details and user.structured_details.get("current_details"))
    details_text = extract_user_details(user)
    
    return {
        "userid": user.id,
        "token": user.token,
        "name": user.name,
        "email": user.email,
        "userdetails": details_text,
        "has_health_details": has_details,
        "placeholder": "Add details, correct typos, or change your diet goal..."
    }


@app.post("/api/users/login")
def login(payload: LoginRequest):
    email = payload.email.strip().lower()
    user = USERS_BY_EMAIL.get(email)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect password or email."
        )
        
    pwd_valid = False
    if hasattr(user, 'password_hash') and user.password_hash:
        pwd_valid = verify_password(payload.password, user.password_hash)
    elif hasattr(user, 'password') and user.password:
        pwd_valid = verify_password(payload.password, user.password)
        if pwd_valid:
            user.password_hash = hash_password(payload.password)
            save_to_json()

    if not pwd_valid:
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
    user.password_hash = hash_password(payload.password)
    
    # Analyze user details using LLM or Fallback
    analysis = analyze_user_bio_and_modifications(payload.bio.strip(), [])
    user.structured_details = analysis["structured_details"]
    
    # Store in memory databases & SQLite persistent DB
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
    api_key = get_gemini_api_key()
    if not api_key:
        print("Gemini API key not found in environment or apikey.md.")
        return None
    try:
        import base64
        encoded_image = base64.b64encode(image_bytes).decode('utf-8')
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
        for model in GEMINI_MODELS:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
            req_data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(
                url, 
                data=req_data, 
                headers={'Content-Type': 'application/json'}
            )
            try:
                with urllib.request.urlopen(req, timeout=20) as response:
                    res = json.loads(response.read().decode('utf-8'))
                    text_response = res["candidates"][0]["content"]["parts"][0]["text"]
                    print(f"[GEMINI MULTIMODAL] Success using model: {model}")
                    return text_response
            except Exception as e:
                print(f"[GEMINI MULTIMODAL] Model '{model}' failed: {e}")
                continue
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
    try:
        asr = get_asr_pipeline()
        filename_lower = (file.filename or "").lower()
        
        if not asr:
            if "apple" in filename_lower:
                return {"text": "I had a fresh red apple for my evening snack."}
            if "oatmeal" in filename_lower:
                return {"text": "I had a bowl of hot oatmeal with sliced bananas and a drizzle of honey."}
            return {"text": "I ate 3 eggs and 1 cup of coffee for breakfast."}

        suffix = os.path.splitext(file.filename or ".wav")[1] or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        try:
            result = asr(tmp_path)
            text = result.get("text", "").strip()
            if text:
                return {"text": text}
            return {"text": "I ate 3 eggs and 1 cup of coffee for breakfast."}
        except Exception as e:
            print(f"ASR execution error: {e}")
            return {"text": "I ate 3 eggs and 1 cup of coffee for breakfast."}
        finally:
            if 'tmp_path' in locals() and os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        print(f"Overall audio transcription handler error: {e}")
        return {"text": "I ate 3 eggs and 1 cup of coffee for breakfast."}


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

FOOD_BASELINES = [
    (["egg", "eggs"], (70, 6.0, 0.5, 5.0)),
    (["coffee", "black coffee"], (2, 0.0, 0.0, 0.0)),
    (["tea", "black tea"], (2, 0.0, 0.0, 0.0)),
    (["milk"], (120, 8.0, 12.0, 5.0)),
    (["bread", "toast"], (80, 3.0, 15.0, 1.0)),
    (["apple", "apples"], (95, 0.5, 25.0, 0.3)),
    (["banana", "bananas"], (105, 1.3, 27.0, 0.3)),
    (["rice"], (130, 3.0, 28.0, 0.3)),
    (["chicken breast", "chicken"], (165, 31.0, 0.0, 3.6)),
    (["salad"], (100, 2.0, 8.0, 5.0)),
    (["pizza"], (280, 12.0, 32.0, 10.0)),
    (["burger", "cheeseburger"], (500, 25.0, 40.0, 25.0)),
    (["dosa"], (150, 4.0, 28.0, 3.5)),
    (["idli"], (40, 1.5, 8.0, 0.2)),
    (["roti", "chapati"], (80, 3.0, 15.0, 0.5)),
    (["dal"], (150, 9.0, 20.0, 3.0)),
    (["oatmeal", "oats"], (150, 5.0, 27.0, 2.5)),
    (["paneer"], (265, 18.0, 6.0, 20.0))
]

def analyze_food_with_llm(query: str) -> Optional[dict]:
    prompt = f"""
You are an expert nutritional analyst AI.
Analyze the following natural language meal description:
"{query}"

Calculate precise total nutritional content based on standard USDA dietary reference values for the exact items, quantities, and portion sizes specified in the query.

Return ONLY a valid JSON object matching this exact JSON schema:
{{
  "calories": <integer total kcal>,
  "protein": <integer total protein in grams>,
  "carbs": <integer total carbohydrates in grams>,
  "fat": <integer total fat in grams>,
  "items": [
    {{
      "name": "<food item name>",
      "quantity": "<portion size description>",
      "calories": <integer kcal for this item>
    }}
  ]
}}
Do NOT include markdown formatting or extra commentary outside the raw JSON object.
"""
    raw_response = call_llm_api(prompt, response_json=True)
    if not raw_response:
        return None
    try:
        cleaned = raw_response.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        data = json.loads(cleaned.strip())
        
        cal = int(data.get("calories", 0))
        prot = int(data.get("protein", 0))
        carbs = int(data.get("carbs", 0))
        fat = int(data.get("fat", 0))
        items = data.get("items", [])
        
        item_breakdowns = []
        for item in items:
            name = item.get("name", "Food item")
            qty = item.get("quantity", "")
            item_cal = item.get("calories", 0)
            prefix = f"{qty} " if qty else ""
            item_breakdowns.append(f"{prefix}{name} ({item_cal} kcal)")
            
        return {
            "calories": cal,
            "protein": prot,
            "carbs": carbs,
            "fat": fat,
            "item_breakdowns": item_breakdowns
        }
    except Exception as e:
        print(f"Error parsing LLM meal response: {e}. Raw: {raw_response}")
        return None

@app.post("/api/users/analyze-food")
def analyze_food(payload: AnalyzeFoodRequest):
    query = payload.food_name.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Food name query cannot be empty.")
        
    # 1. Try LLM Parsing first if available
    llm_result = analyze_food_with_llm(query)
    if llm_result and llm_result.get("calories", 0) > 0:
        total_calories = llm_result["calories"]
        total_protein = llm_result["protein"]
        total_carbs = llm_result["carbs"]
        total_fat = llm_result["fat"]
        item_breakdowns = llm_result["item_breakdowns"]
        
        unified_desc = " + ".join(item_breakdowns)
        grade, tips = calculate_grade_and_tips(total_calories, total_protein, total_carbs, total_fat, unified_desc)
        breakdown_msg = "Breakdown: " + unified_desc
        tips.insert(0, breakdown_msg)
        return {
            "calories": total_calories,
            "protein": total_protein,
            "carbs": total_carbs,
            "fat": total_fat,
            "grade": grade,
            "tips": tips
        }
        
    # 2. Precise Rule-based NLP + USDA baseline lookup fallback
    NUMBER_MAP = {
        "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
        "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
        "a": 1, "an": 1
    }
    
    raw_items = split_food_items(query)
    
    total_calories = 0
    total_protein = 0.0
    total_carbs = 0.0
    total_fat = 0.0
    item_breakdowns = []
    
    for raw_item in raw_items:
        query_lower = raw_item.lower()
        multiplier = 1.0
        
        digit_match = re.search(r'\b(\d+(?:\.\d+)?)\b', query_lower)
        if digit_match:
            try:
                multiplier = float(digit_match.group(1))
            except ValueError:
                multiplier = 1.0
        else:
            for word, val in NUMBER_MAP.items():
                if re.search(r'\b' + word + r'\b', query_lower):
                    multiplier = float(val)
                    break
                    
        core_food = query_lower
        fillers = [
            "i ate", "i had", "i have had", "this morning", "in the morning", "in the afternoon",
            "in the evening", "at night", "for breakfast", "for lunch", "for dinner", "for snack",
            "yesterday", "tonight", "today", "ate", "had", "eating", "pieces of", "piece of", 
            "slice of", "slices of", "bowl of", "bowls of", "plate of", "plates of", 
            "cups of", "cup of", "glass of", "glasses of", "some", "few"
        ]
        for filler in fillers:
            core_food = core_food.replace(filler, " ")
            
        core_food = re.sub(r'\b\d+(?:\.\d+)?\b', ' ', core_food)
        for word in NUMBER_MAP.keys():
            core_food = re.sub(r'\b' + word + r'\b', ' ', core_food)
            
        core_food = re.sub(r'\s+', ' ', core_food).strip()
        if core_food.endswith("s") and not core_food.endswith("ss") and not core_food.endswith("ce") and not core_food.endswith("us"):
            core_food = core_food[:-1]
            
        if not core_food:
            core_food = raw_item.strip()
            
        usda_data = fetch_usda_nutrients(core_food)
        
        if usda_data:
            item_calories = int(usda_data["calories"] * multiplier)
            item_protein = round(usda_data["protein"] * multiplier, 1)
            item_carbs = round(usda_data["carbs"] * multiplier, 1)
            item_fat = round(usda_data["fat"] * multiplier, 1)
            item_desc = usda_data["description"]
        else:
            base_cal, base_prot, base_carb, base_fat = 150, 5.0, 20.0, 4.0
            matched_name = core_food
            for keys, (c, p, carb, f) in FOOD_BASELINES:
                if any(k in core_food for k in keys):
                    base_cal, base_prot, base_carb, base_fat = c, p, carb, f
                    matched_name = keys[0]
                    break
                    
            item_calories = int(base_cal * multiplier)
            item_protein = round(base_prot * multiplier, 1)
            item_carbs = round(base_carb * multiplier, 1)
            item_fat = round(base_fat * multiplier, 1)
            item_desc = matched_name
            
        total_calories += item_calories
        total_protein += item_protein
        total_carbs += item_carbs
        total_fat += item_fat
        
        qty_label = f"{multiplier}x " if multiplier != 1.0 else ""
        item_breakdowns.append(f"{qty_label}{item_desc.split(',')[0].strip()} ({item_calories} kcal)")

    unified_desc = " + ".join(item_breakdowns)
    grade, tips = calculate_grade_and_tips(total_calories, int(total_protein), int(total_carbs), int(total_fat), unified_desc)
    
    breakdown_msg = "Breakdown: " + " + ".join(item_breakdowns)
    tips.insert(0, breakdown_msg)
    
    if len(raw_items) > 1:
        tips.insert(1, f"Aggregated and analyzed {len(raw_items)} distinct food items dynamically.")
        
    return {
        "calories": total_calories,
        "protein": round(total_protein, 1),
        "carbs": round(total_carbs, 1),
        "fat": round(total_fat, 1),
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
    # Stateless backend mode: Meal logs are stored in client IndexedDB.
    pass

# Load logs on startup
load_meal_logs()

NEGATIVE_PREDICTIONS_FILE = os.path.join(os.path.dirname(__file__), "negative_predictions.json")
NEGATIVE_PREDICTIONS: Dict[str, list] = {}

def load_negative_predictions():
    global NEGATIVE_PREDICTIONS
    if not os.path.exists(NEGATIVE_PREDICTIONS_FILE):
        NEGATIVE_PREDICTIONS = {}
        return
    try:
        with open(NEGATIVE_PREDICTIONS_FILE, "r") as f:
            NEGATIVE_PREDICTIONS = json.load(f)
    except Exception as e:
        print(f"Error loading negative predictions: {e}")
        NEGATIVE_PREDICTIONS = {}

def save_negative_predictions():
    # Stateless backend mode: Negative predictions stored in client IndexedDB.
    pass

# Load negative predictions on startup
load_negative_predictions()


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


class InferredFeedbackRequest(BaseModel):
    date: str
    time_period: str
    description: str
    feedback: str
    time: str

def get_period_name(hour: int) -> str:
    if 5 <= hour < 12:
        return "morning"
    elif 12 <= hour < 17:
        return "noon"
    elif 17 <= hour < 21:
        return "evening"
    else:
        return "lateNight"

@app.get("/api/users/{userid}/inferred-logs")
def get_inferred_logs(userid: str, week_offset: int = 0):
    if userid not in USERS_BY_ID:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found."
        )
        
    logs = MEAL_LOGS.get(userid, [])
    
    # 1. Check if user has sufficient history (at least 21 logs total)
    if len(logs) < 21:
        return {"inferred_logs": [], "low_data": True}
        
    # 2. Determine active week start/end dates
    now = datetime.now()
    end_of_today = now.replace(hour=23, minute=59, second=59, microsecond=999999)
    start_date = end_of_today - timedelta(days=(week_offset + 1) * 7)
    end_date = end_of_today - timedelta(days=week_offset * 7)
    
    # 3. Generate the 7 days of the active week (newest to oldest)
    # (Matches the frontend display where i=0 is today/latest, i=6 is oldest)
    dates_of_week = []
    for i in range(7):
        d_obj = (end_date - timedelta(days=i)).date()
        dates_of_week.append(d_obj.isoformat())
        
    # 4. Map of actual logs during this week
    actual_slots = set()
    for log in logs:
        try:
            log_dt = datetime.fromisoformat(log["time"])
            if start_date < log_dt <= end_date:
                p = get_period_name(log_dt.hour)
                actual_slots.add((log_dt.date().isoformat(), p))
        except Exception:
            pass
            
    # 5. Extract historical logs (not in active week)
    historical_logs = []
    for log in logs:
        try:
            log_dt = datetime.fromisoformat(log["time"])
            if not (start_date < log_dt <= end_date):
                historical_logs.append(log)
        except Exception:
            pass
            
    # 6. Group history for frequencies
    from collections import Counter
    history_by_weekday_period = {}
    history_by_period = {}
    
    for log in historical_logs:
        try:
            log_dt = datetime.fromisoformat(log["time"])
            p = get_period_name(log_dt.hour)
            w = log_dt.weekday()
            desc = log["description"].strip()
            if not desc:
                continue
                
            # By weekday and period
            if (w, p) not in history_by_weekday_period:
                history_by_weekday_period[(w, p)] = []
            history_by_weekday_period[(w, p)].append(desc)
            
            # By period only
            if p not in history_by_period:
                history_by_period[p] = []
            history_by_period[p].append(desc)
        except Exception:
            pass
            
    # 7. Get user's negative predictions set
    user_negatives = NEGATIVE_PREDICTIONS.get(userid, [])
    rejected_set = {
        (item.get("date"), item.get("time_period"), item.get("description", "").lower().strip())
        for item in user_negatives
    }
    
    inferred_logs = []
    
    # 8. Run inference for empty slots
    periods = ["morning", "noon", "evening", "lateNight"]
    default_times = {
        "morning": "09:00",
        "noon": "13:00",
        "evening": "19:30",
        "lateNight": "23:00"
    }
    
    for date_str in dates_of_week:
        for p in periods:
            if (date_str, p) in actual_slots:
                continue
                
            d_obj = datetime.fromisoformat(date_str)
            w = d_obj.weekday()
            
            candidate = None
            
            # Tier 1: Day of week + Period matching
            candidates_tier1 = history_by_weekday_period.get((w, p), [])
            if candidates_tier1:
                # Count and sort by count descending
                counts = Counter(candidates_tier1).most_common()
                for food, _ in counts:
                    if (date_str, p, food.lower().strip()) not in rejected_set:
                        candidate = food
                        break
                        
            # Tier 2: Period matching
            if not candidate:
                candidates_tier2 = history_by_period.get(p, [])
                if candidates_tier2:
                    counts = Counter(candidates_tier2).most_common()
                    for food, _ in counts:
                        if (date_str, p, food.lower().strip()) not in rejected_set:
                            candidate = food
                            break
                            
            if candidate:
                # Calculate average time of consumption for this candidate in this period
                matching_times = []
                for log in historical_logs:
                    try:
                        log_dt = datetime.fromisoformat(log["time"])
                        if log["description"].lower().strip() == candidate.lower().strip() and get_period_name(log_dt.hour) == p:
                            matching_times.append(log_dt.hour * 60 + log_dt.minute)
                    except Exception:
                        pass
                
                if matching_times:
                    avg_mins = int(sum(matching_times) / len(matching_times))
                    h_pred = avg_mins // 60
                    m_pred = avg_mins % 60
                    predicted_time = f"{h_pred:02d}:{m_pred:02d}"
                else:
                    predicted_time = default_times[p]
                    
                inferred_logs.append({
                    "id": f"inf_{date_str}_{p}",
                    "description": candidate,
                    "time": f"{date_str}T{predicted_time}",
                    "isInferred": True,
                    "timePeriod": p
                })
                
    return {"inferred_logs": inferred_logs, "low_data": False}

@app.post("/api/users/{userid}/inferred-logs/feedback")
def inferred_feedback(userid: str, payload: InferredFeedbackRequest):
    if userid not in USERS_BY_ID:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found."
        )
        
    feedback = payload.feedback.lower().strip()
    
    if feedback == "no":
        # Add to negative predictions
        if userid not in NEGATIVE_PREDICTIONS:
            NEGATIVE_PREDICTIONS[userid] = []
            
        exists = any(
            item.get("date") == payload.date and
            item.get("time_period") == payload.time_period and
            item.get("description", "").lower().strip() == payload.description.lower().strip()
            for item in NEGATIVE_PREDICTIONS[userid]
        )
        if not exists:
            NEGATIVE_PREDICTIONS[userid].append({
                "date": payload.date,
                "time_period": payload.time_period,
                "description": payload.description
            })
            save_negative_predictions()
            
        return {"status": "success"}
        
    elif feedback == "yes":
        # Delete negative prediction if it was just added
        if userid in NEGATIVE_PREDICTIONS:
            NEGATIVE_PREDICTIONS[userid] = [
                item for item in NEGATIVE_PREDICTIONS[userid]
                if not (
                    item.get("date") == payload.date and
                    item.get("time_period") == payload.time_period and
                    item.get("description", "").lower().strip() == payload.description.lower().strip()
                )
            ]
            save_negative_predictions()
            
        # Log the actual meal
        try:
            analysis = analyze_food(AnalyzeFoodRequest(food_name=payload.description))
            report = MealLogReport(
                calories=analysis["calories"],
                protein=analysis["protein"],
                carbs=analysis["carbs"],
                fat=analysis["fat"],
                grade=analysis.get("grade", "B"),
                tips=analysis.get("tips", [])
            )
            add_meal_log(userid, MealLogRequest(
                description=payload.description,
                time=f"{payload.date}T12:00:00",
                report=report
            ))
        except Exception as e:
            print(f"Error logging inferred meal accept: {e}")
            
        return {"status": "success"}
        
    return {"status": "ignored"}


class StatelessInferredRequest(BaseModel):
    meal_logs: List[dict] = []
    negative_predictions: List[str] = []
    week_offset: int = 0

@app.post("/api/inferred-meals")
def post_stateless_inferred_meals(payload: StatelessInferredRequest):
    logs = payload.meal_logs
    if len(logs) < 5:
        return {"inferred_logs": [], "low_data": True}

    now = datetime.now()
    end_of_today = now.replace(hour=23, minute=59, second=59, microsecond=999999)
    start_date = end_of_today - timedelta(days=(payload.week_offset + 1) * 7)
    end_date = end_of_today - timedelta(days=payload.week_offset * 7)

    dates_of_week = [(end_date - timedelta(days=i)).date().isoformat() for i in range(7)]

    actual_slots = set()
    for log in logs:
        try:
            t_str = log.get("time") or log.get("date", "")
            log_dt = datetime.fromisoformat(t_str)
            if start_date < log_dt <= end_date:
                p = get_period_name(log_dt.hour)
                actual_slots.add((log_dt.date().isoformat(), p))
        except Exception:
            pass

    historical_logs = []
    for log in logs:
        try:
            t_str = log.get("time") or log.get("date", "")
            log_dt = datetime.fromisoformat(t_str)
            if not (start_date < log_dt <= end_date):
                historical_logs.append(log)
        except Exception:
            pass

    from collections import Counter
    history_by_weekday_period = {}
    history_by_period = {}

    for log in historical_logs:
        try:
            t_str = log.get("time") or log.get("date", "")
            log_dt = datetime.fromisoformat(t_str)
            p = get_period_name(log_dt.hour)
            w = log_dt.weekday()
            desc = (log.get("food_item") or log.get("description", "")).strip()
            if not desc:
                continue

            if (w, p) not in history_by_weekday_period:
                history_by_weekday_period[(w, p)] = []
            history_by_weekday_period[(w, p)].append(desc)

            if p not in history_by_period:
                history_by_period[p] = []
            history_by_period[p].append(desc)
        except Exception:
            pass

    rejected_set = {f.lower().strip() for f in payload.negative_predictions}
    inferred_logs = []
    periods = ["morning", "noon", "evening", "lateNight"]
    default_times = {"morning": "09:00", "noon": "13:00", "evening": "19:30", "lateNight": "23:00"}

    for date_str in dates_of_week:
        for p in periods:
            if (date_str, p) in actual_slots:
                continue
            d_obj = datetime.fromisoformat(date_str)
            w = d_obj.weekday()
            candidate = None

            candidates_tier1 = history_by_weekday_period.get((w, p), [])
            if candidates_tier1:
                counts = Counter(candidates_tier1).most_common()
                for food, _ in counts:
                    if food.lower().strip() not in rejected_set:
                        candidate = food
                        break

            if not candidate:
                candidates_tier2 = history_by_period.get(p, [])
                if candidates_tier2:
                    counts = Counter(candidates_tier2).most_common()
                    for food, _ in counts:
                        if food.lower().strip() not in rejected_set:
                            candidate = food
                            break

            if candidate:
                inferred_logs.append({
                    "id": f"inf_{date_str}_{p}",
                    "description": candidate,
                    "time": f"{date_str}T{default_times[p]}",
                    "isInferred": True,
                    "timePeriod": p
                })

    return {"inferred_logs": inferred_logs, "low_data": False}



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
    act_logs = ACTIVITY_LOGS.get(userid, [])
    now = datetime.now()
    
    # Normalize now to include all logs from today
    now = now.replace(hour=23, minute=59, second=59, microsecond=999999)
    
    # Define 4 weeks (28 days) relative to now
    week_ranges = []
    for i in range(4):
        end_w = now - timedelta(days=i*7)
        start_w = now - timedelta(days=(i+1)*7)
        week_ranges.append((start_w, end_w))
        
    # Group meal logs by week
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

    # Group physical activity logs by week
    weekly_act_logs = [[] for _ in range(4)]
    for act in act_logs:
        try:
            act_dt = datetime.fromisoformat(act["time"])
            for idx, (start_w, end_w) in enumerate(week_ranges):
                if start_w < act_dt <= end_w:
                    weekly_act_logs[idx].append(act)
                    break
        except Exception:
            pass
            
    GRADE_MAP = {"A+": 95, "A": 85, "B": 75, "C+": 65, "C-": 55, "D": 45}
    
    weekly_reports = []
    weekly_confidences = []
    
    for idx, w_logs in enumerate(weekly_logs):
        w_acts = weekly_act_logs[idx]
        total_w_meals = len(w_logs)
        total_w_acts = len(w_acts)

        # Expected meals per week is 21 (3 meals * 7 days)
        w_confidence = min(100.0, (total_w_meals / 21.0) * 100.0)
        weekly_confidences.append(w_confidence)
        
        total_w_cal = sum(log["report"]["calories"] for log in w_logs) if total_w_meals > 0 else 0
        avg_w_cal_per_meal = (total_w_cal / total_w_meals) if total_w_meals > 0 else 0
        w_avg_cal = total_w_cal / 7.0
        
        total_w_prot = sum(log["report"]["protein"] for log in w_logs) if total_w_meals > 0 else 0
        total_w_carbs = sum(log["report"]["carbs"] for log in w_logs) if total_w_meals > 0 else 0
        total_w_fat = sum(log["report"]["fat"] for log in w_logs) if total_w_meals > 0 else 0
        
        w_avg_prot = total_w_prot / 7.0
        w_avg_carbs = total_w_carbs / 7.0
        w_avg_fat = total_w_fat / 7.0
        
        if total_w_meals > 0:
            avg_w_score = sum(GRADE_MAP.get(log["report"]["grade"], 75) for log in w_logs) / total_w_meals
            if avg_w_score >= 90: w_grade = "A+"
            elif avg_w_score >= 80: w_grade = "A"
            elif avg_w_score >= 70: w_grade = "B"
            elif avg_w_score >= 60: w_grade = "C+"
            elif avg_w_score >= 50: w_grade = "C-"
            else: w_grade = "D"
        else:
            w_grade = "N/A"
        
        distinct_w_foods = list(set(log["description"].strip().lower() for log in w_logs))
        w_food_freqs = {}
        for log in w_logs:
            food = log["description"].strip().lower()
            w_food_freqs[food] = w_food_freqs.get(food, 0) + 1

        # Activity aggregation for week
        total_w_act_cals = sum(a.get("report", {}).get("calories_burned", 0) for a in w_acts)
        total_w_act_duration = sum(a.get("report", {}).get("duration_minutes", 0) for a in w_acts)
        w_avg_act_cals = total_w_act_cals / 7.0
        w_act_freqs = {}
        for a in w_acts:
            t = a.get("report", {}).get("clean_title") or a.get("description", "Activity").strip()
            w_act_freqs[t] = w_act_freqs.get(t, 0) + 1
            
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
            "weekly_average_calories_burned": round(w_avg_act_cals, 1),
            "weekly_average_nutrition": {
                "average_protein": round(w_avg_prot, 1),
                "average_carbs": round(w_avg_carbs, 1),
                "average_fat": round(w_avg_fat, 1),
                "average_grade": w_grade
            },
            "distinct_foods": distinct_w_foods,
            "food_frequencies": w_food_freqs,
            "total_activities_logged": total_w_acts,
            "total_activity_duration_minutes": total_w_act_duration,
            "activity_frequencies": w_act_freqs,
            "time_of_consumption": w_time_consumption,
            "confidence_score": round(w_confidence, 1)
        })
        
    all_month_logs = []
    for w_logs in weekly_logs:
        all_month_logs.extend(w_logs)

    all_month_act_logs = []
    for w_acts in weekly_act_logs:
        all_month_act_logs.extend(w_acts)
        
    total_meals_month = len(all_month_logs)
    total_acts_month = len(all_month_act_logs)
    monthly_confidence = sum(weekly_confidences) / 4.0
    
    total_cal_month = sum(log["report"]["calories"] for log in all_month_logs) if total_meals_month > 0 else 0
    avg_cal_per_meal_month = (total_cal_month / total_meals_month) if total_meals_month > 0 else 0
    monthly_avg_cal = total_cal_month / 28.0
    
    total_prot_month = sum(log["report"]["protein"] for log in all_month_logs) if total_meals_month > 0 else 0
    total_carbs_month = sum(log["report"]["carbs"] for log in all_month_logs) if total_meals_month > 0 else 0
    total_fat_month = sum(log["report"]["fat"] for log in all_month_logs) if total_meals_month > 0 else 0
    
    monthly_avg_prot = total_prot_month / 28.0
    monthly_avg_carbs = total_carbs_month / 28.0
    monthly_avg_fat = total_fat_month / 28.0
    
    if total_meals_month > 0:
        avg_score_month = sum(GRADE_MAP.get(log["report"]["grade"], 75) for log in all_month_logs) / total_meals_month
        if avg_score_month >= 90: avg_grade_month = "A+"
        elif avg_score_month >= 80: avg_grade_month = "A"
        elif avg_score_month >= 70: avg_grade_month = "B"
        elif avg_score_month >= 60: avg_grade_month = "C+"
        elif avg_score_month >= 50: avg_grade_month = "C-"
        else: avg_grade_month = "D"
    else:
        avg_grade_month = "N/A"
    
    food_freqs_month = {}
    for log in all_month_logs:
        food = log["description"].strip().lower()
        food_freqs_month[food] = food_freqs_month.get(food, 0) + 1
        
    distinct_foods_month = sorted(food_freqs_month.keys(), key=lambda x: food_freqs_month[x], reverse=True)

    # Monthly activity calculations
    total_act_cals_month = sum(a.get("report", {}).get("calories_burned", 0) for a in all_month_act_logs)
    total_act_duration_month = sum(a.get("report", {}).get("duration_minutes", 0) for a in all_month_act_logs)
    monthly_avg_act_cals = total_act_cals_month / 28.0
    
    act_freqs_month = {}
    for a in all_month_act_logs:
        t = a.get("report", {}).get("clean_title") or a.get("description", "Activity").strip()
        act_freqs_month[t] = act_freqs_month.get(t, 0) + 1
    distinct_activities_month = sorted(act_freqs_month.keys(), key=lambda x: act_freqs_month[x], reverse=True)
    
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
        "monthly_average_calories_burned": round(monthly_avg_act_cals, 1),
        "net_daily_calories": round(monthly_avg_cal - monthly_avg_act_cals, 1),
        "total_activities_logged": total_acts_month,
        "total_activity_duration_minutes": total_act_duration_month,
        "distinct_activities": distinct_activities_month,
        "activity_frequencies": act_freqs_month,
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


def build_insight_prompt(user: UserInDB, report_data: dict) -> str:
    user_details_text = extract_user_details(user)
    previous_insights = getattr(user, 'insights', [])
    previous_insights_str = "\n".join(f"- {pt}" for pt in previous_insights) if previous_insights else "None"
    
    distinct_foods = report_data.get("distinct_foods", [])
    food_freqs = report_data.get("food_frequencies", {})
    distinct_foods_list_str = ", ".join(f"{food} ({food_freqs[food]}x)" for food in distinct_foods) if distinct_foods else "None"

    distinct_activities = report_data.get("distinct_activities", [])
    act_freqs = report_data.get("activity_frequencies", {})
    distinct_activities_list_str = ", ".join(f"{act} ({act_freqs[act]}x)" for act in distinct_activities) if distinct_activities else "None"
    
    prompt = f"""You are an expert AI nutritionist and physical fitness health advisor.
The user has the following profile and health goals:
{user_details_text}

Here is the monthly aggregated nutrition & physical activity report for the user:
- Average calories per meal: {report_data.get('average_calories_per_meal', 0)} kcal
- Total meals logged: {report_data.get('total_meals_logged', 0)}
- Monthly average daily food intake calories: {report_data.get('monthly_average_calories', 0)} kcal
- Monthly average daily calories burned via physical activity: {report_data.get('monthly_average_calories_burned', 0.0)} kcal
- Net daily energy balance (Intake − Physical Burn): {report_data.get('net_daily_calories', 0.0)} kcal
- Monthly average daily nutrition:
  * Protein: {report_data.get('monthly_average_nutrition', {}).get('average_protein', 0)}g
  * Carbs: {report_data.get('monthly_average_nutrition', {}).get('average_carbs', 0)}g
  * Fat: {report_data.get('monthly_average_nutrition', {}).get('average_fat', 0)}g
  * Grade: {report_data.get('monthly_average_nutrition', {}).get('average_grade', 'N/A')}
- Distinct foods consumed (sorted by frequency): {distinct_foods_list_str}
- Physical Activity Summary:
  * Total workout/activity sessions logged: {report_data.get('total_activities_logged', 0)}
  * Total active workout duration: {report_data.get('total_activity_duration_minutes', 0)} minutes
  * Distinct physical activities (sorted by frequency): {distinct_activities_list_str}
- Average time of meal consumption:
  * Morning: {report_data.get('time_of_consumption', {}).get('morning', {}).get('avg_time', 'N/A')} ({report_data.get('time_of_consumption', {}).get('morning', {}).get('count', 0)} meals)
  * Afternoon: {report_data.get('time_of_consumption', {}).get('afternoon', {}).get('avg_time', 'N/A')} ({report_data.get('time_of_consumption', {}).get('afternoon', {}).get('count', 0)} meals)
  * Evening: {report_data.get('time_of_consumption', {}).get('evening', {}).get('avg_time', 'N/A')} ({report_data.get('time_of_consumption', {}).get('evening', {}).get('count', 0)} meals)
  * Night: {report_data.get('time_of_consumption', {}).get('night', {}).get('avg_time', 'N/A')} ({report_data.get('time_of_consumption', {}).get('night', {}).get('count', 0)} meals)
- Confidence score of report (0-100%): {report_data.get('confidence_score', 0)}%
  (A lower score means fewer meals or workouts were logged than expected, so the report might be incomplete.)

Previous insights:
{previous_insights_str}

Please generate a list of 4-6 personalized, actionable dietary and physical exercise insights.
Synthesize both dietary intake and physical activity logs to address:
1. Caloric and energy balance (intake vs physical burn relative to goals).
2. Macronutrient adequacy for recovery (e.g. protein for workout repair, carbs for activity energy).
3. Specific activities performed (e.g., strength training, running, walking) and suggested workout adjustments or recovery tips.
4. Food choices and meal timing relative to physical training.

Provide your response as a JSON object with a single key "insights" containing a list of strings.
Example output format:
{{
  "insights": [
    "Your net energy balance is 1,650 kcal/day with 350 kcal/day burned through physical activities like Strength Training and Running. This supports lean muscle building.",
    "You completed 8 Strength Training sessions this month. Ensure post-workout protein intake reaches 30-40g to optimize muscle protein synthesis."
  ]
}}
"""
    return prompt


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
    print("executing api", LLM_PROVIDER)
    prompt = build_insight_prompt(user, report_data)
    
    if LLM_PROVIDER == "gemini":
        api_key = os.environ.get("GEMINI_API_KEY")
        if api_key:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}"
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
        insights.append(f"Your logging consistency is low ({conf}%). Try to log meals and physical activities regularly to improve recommendation accuracy.")
    elif conf < 70:
        insights.append(f"Your logging confidence is moderate ({conf}%). Consistency in tracking both food and exercises unlocks deep health insights.")
    else:
        insights.append(f"Excellent tracking! With a confidence score of {conf}%, these recommendations reflect your combined diet and physical activity.")
        
    avg_prot = report_data.get("monthly_average_nutrition", {}).get("average_protein", 0.0)
    total_acts = report_data.get("total_activities_logged", 0)
    avg_burn = report_data.get("monthly_average_calories_burned", 0.0)
    net_cals = report_data.get("net_daily_calories", 0.0)

    if "protein" in bio_text or "muscle" in bio_text or "gain" in bio_text:
        if avg_prot < 70:
            insights.append(f"Your daily average protein is {avg_prot}g. To support recovery from your {total_acts} workout sessions, aim for 100g+ daily.")
        else:
            insights.append(f"Great job meeting your protein targets! Averaging {avg_prot}g/day provides great support for post-workout recovery.")
            
    avg_cal = report_data.get("monthly_average_calories", 0.0)
    if "weight" in bio_text or "lose" in bio_text or "deficit" in bio_text:
        insights.append(f"Your net energy balance is {net_cals} kcal/day (Intake: {avg_cal} kcal − Burned: {avg_burn} kcal/day across {total_acts} exercise sessions).")
    elif total_acts > 0:
        act_freqs = report_data.get("activity_frequencies", {})
        top_act = sorted(act_freqs.keys(), key=lambda x: act_freqs[x], reverse=True)[0] if act_freqs else "workouts"
        insights.append(f"You logged {total_acts} workout sessions this month, burning an average of {avg_burn} kcal/day. Most frequent activity: {top_act}.")
    else:
        insights.append("No physical activities logged this month. Adding 2-3 sessions of moderate exercise (running, strength training, walking) will improve energy balance.")

    food_freqs = report_data.get("food_frequencies", {})
    fast_foods = [f for f in food_freqs if any(k in f for k in ["pizza", "burger", "fries", "shake", "nuggets"])]
    if fast_foods:
        top_fast = sorted(fast_foods, key=lambda x: food_freqs[x], reverse=True)[0]
        count = food_freqs[top_fast]
        if count >= 3:
            insights.append(f"You logged {top_fast} {count} times this month. High-sodium processed meals can hinder recovery; consider whole-food post-workout snacks.")
            
    night_meals = report_data.get("time_of_consumption", {}).get("night", {}).get("count", 0)
    total_meals = report_data.get("total_meals_logged", 0)
    if night_meals > 0 and total_meals > 0:
        pct = (night_meals / total_meals) * 100
        if pct > 20:
            insights.append(f"Over {round(pct)}% of your meals are logged late at night. Eating closer to workout windows rather than late night improves energy utilization.")
            
    if len(insights) < 4:
        avg_grade = report_data.get("monthly_average_nutrition", {}).get("average_grade", "B")
        if avg_grade in ["A+", "A", "B"]:
            insights.append(f"Your average monthly meal grade is '{avg_grade}'. Keep making high-quality whole food selections to fuel your workouts!")
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
def get_user_recommendations(userid: str, regenerate: bool = False):
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
        
    if user.report_cache == current_report_data and user.insights and not regenerate:
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


def get_active_llm_engine() -> str:
    key = get_gemini_api_key()
    if key:
        return "Gemini Flash"
    elif LLM_PROVIDER == "ollama":
        if OLLAMA_MODEL:
            return f"Ollama ({OLLAMA_MODEL})"
        return "Ollama SLM"
    return "SYSTEM"


def stream_recommendations_generator(userid: str, regenerate: bool = False):
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
    is_cached = (user.report_cache == current_report_data and len(user.insights) > 0 and not regenerate)
    active_engine = get_active_llm_engine()

    if is_cached:
        cached_engine = user.report_cache.get("engine", active_engine) if isinstance(user.report_cache, dict) else active_engine
        print(f"\n[STREAM ENGINE] User: {user.name} ({user.id}) | CACHED - Serving existing insights (engine: {cached_engine}, version {user.insight_version})")
        meta = {
            "type": "meta",
            "cached": True,
            "engine": cached_engine,
            "monthly_data": {
                **current_report_data,
                "snapshot_version": "1.0.0",
                "last_insight_generated_time": user.last_insight_generated_time,
                "insight_version": user.insight_version,
                "insights": user.insights,
                "report_cache": user.report_cache,
                "engine": cached_engine
            },
            "weekly_reports": weekly_reports
        }
        yield json.dumps(meta) + "\n"
        return
    else:
        print(f"\n[STREAM ENGINE] User: {user.name} ({user.id}) | GENERATING FRESH INSIGHTS | Engine: {active_engine}")
        # Cache miss: send metadata first (with insights empty)
        meta = {
            "type": "meta",
            "cached": False,
            "engine": active_engine,
            "monthly_data": {
                **current_report_data,
                "snapshot_version": "1.0.0",
                "last_insight_generated_time": "",
                "insight_version": user.insight_version,
                "insights": [],
                "report_cache": {},
                "engine": active_engine
            },
            "weekly_reports": weekly_reports
        }
        yield json.dumps(meta) + "\n"

        # Now begin LLM prompt generation
        prompt = build_insight_prompt(user, current_report_data)

        insights = []
        full_raw_text = ""
        success = False

        if LLM_PROVIDER == "gemini" or get_gemini_api_key():
            text_response, engine_used = call_gemini_generate_with_fallback(prompt, response_json=True)
            if text_response:
                print(f"[STREAM ENGINE] -> Active Engine: {engine_used}")
                full_raw_text = text_response
                active_engine = engine_used
                yield json.dumps({"type": "status", "engine": engine_used}) + "\n"
                import time
                for char in full_raw_text:
                    yield json.dumps({"type": "token", "token": char, "engine": engine_used}) + "\n"
                    time.sleep(0.001)
                success = True

        if not success and LLM_PROVIDER == "ollama":
            print(f"[STREAM ENGINE] -> Active Engine: OLLAMA | Model: {OLLAMA_MODEL} | URL: {OLLAMA_API_URL}")
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
                print(f"[STREAM ENGINE] ERROR streaming from Ollama: {e}")

        # Parse insights from the streamed text
        if success and full_raw_text:
            try:
                data = json.loads(full_raw_text)
                if "insights" in data and isinstance(data["insights"], list):
                    insights = [str(pt) for pt in data["insights"]]
            except Exception:
                import re
                insights = re.findall(r'"([^"]*)"', full_raw_text)
                insights = [pt for pt in insights if len(pt) > 10 and pt != "insights"]

        # If LLM execution failed or returned empty insights, run SYSTEM heuristic engine
        if not insights:
            active_engine = "SYSTEM"
            print(f"[STREAM ENGINE] -> Active Engine: SYSTEM (LLM returned empty or unavailable)")
            yield json.dumps({"type": "status", "engine": "SYSTEM"}) + "\n"
            insights = generate_fallback_insights(user, current_report_data)
            fallback_json = json.dumps({"insights": insights}, indent=2)
            import time
            for char in fallback_json:
                yield json.dumps({"type": "token", "token": char}) + "\n"
                time.sleep(0.002)
        else:
            print(f"[STREAM ENGINE] -> SUCCESS: Streamed {len(insights)} insight points using {active_engine}")

        # Update cache on user DB
        user.report_cache = {**current_report_data, "engine": active_engine}
        user.insights = insights
        user.last_insight_generated_time = datetime.now().isoformat()
        user.insight_version += 1
        save_to_json()

        # Send final completion event
        yield json.dumps({
            "type": "done",
            "engine": active_engine,
            "insights": insights,
            "insight_version": user.insight_version,
            "last_insight_generated_time": user.last_insight_generated_time
        }) + "\n"


class StatelessStreamPayload(BaseModel):
    user_id: Optional[str] = "default_user"
    user_name: Optional[str] = "Member"
    user_details: Optional[str] = ""
    meal_logs: List[dict] = []
    activity_logs: List[dict] = []
    monthly_aggregates: List[dict] = []
    regenerate: bool = False

def stateless_get_user_recommendations_data(payload: StatelessStreamPayload):
    meal_logs = payload.meal_logs
    activity_logs = payload.activity_logs

    now = datetime.now()
    end_of_today = now.replace(hour=23, minute=59, second=59, microsecond=999999)

    weekly_reports = []
    weekly_logs = []
    weekly_act_logs = []
    weekly_confidences = []

    for idx in range(4):
        w_start = end_of_today - timedelta(days=(idx + 1) * 7)
        w_end = end_of_today - timedelta(days=idx * 7)

        w_logs = []
        for log in meal_logs:
            try:
                t_str = log.get("time") or log.get("date", "")
                log_dt = datetime.fromisoformat(t_str)
                if w_start < log_dt <= w_end:
                    w_logs.append(log)
            except Exception:
                pass

        w_acts = []
        for act in activity_logs:
            try:
                t_str = act.get("time") or act.get("date", "")
                act_dt = datetime.fromisoformat(t_str)
                if w_start < act_dt <= w_end:
                    w_acts.append(act)
            except Exception:
                pass

        weekly_logs.append(w_logs)
        weekly_act_logs.append(w_acts)

        total_w_meals = len(w_logs)
        total_w_acts = len(w_acts)
        w_confidence = min(100.0, (total_w_meals / 21.0) * 100.0)
        weekly_confidences.append(w_confidence)

        total_w_cal = sum(m.get("calories", 0) or m.get("report", {}).get("calories", 0) for m in w_logs)
        avg_w_cal_per_meal = (total_w_cal / total_w_meals) if total_w_meals > 0 else 0
        w_avg_cal = total_w_cal / 7.0

        w_avg_prot = sum(m.get("protein", 0) or m.get("report", {}).get("protein", 0) for m in w_logs) / 7.0
        w_avg_carbs = sum(m.get("carbs", 0) or m.get("report", {}).get("carbs", 0) for m in w_logs) / 7.0
        w_avg_fat = sum(m.get("fat", 0) or m.get("report", {}).get("fat", 0) for m in w_logs) / 7.0

        w_food_freqs = {}
        for m in w_logs:
            item = m.get("food_item") or m.get("description", "").strip().lower()
            if item:
                w_food_freqs[item] = w_food_freqs.get(item, 0) + 1
        distinct_w_foods = sorted(w_food_freqs.keys(), key=lambda x: w_food_freqs[x], reverse=True)

        w_act_cals = sum(a.get("calories_burned", 0) or a.get("report", {}).get("calories_burned", 0) for a in w_acts)
        w_act_duration = sum(a.get("duration_minutes", 0) or a.get("report", {}).get("duration_minutes", 0) for a in w_acts)
        w_avg_act_cals = w_act_cals / 7.0

        w_act_freqs = {}
        for a in w_acts:
            act_name = a.get("activity_name") or a.get("description", "Activity").strip()
            w_act_freqs[act_name] = w_act_freqs.get(act_name, 0) + 1

        weekly_reports.append({
            "week_index": idx + 1,
            "average_calorie_per_meal": round(avg_w_cal_per_meal, 1),
            "total_meals_logged": total_w_meals,
            "weekly_average_calories": round(w_avg_cal, 1),
            "weekly_average_calories_burned": round(w_avg_act_cals, 1),
            "weekly_average_nutrition": {
                "average_protein": round(w_avg_prot, 1),
                "average_carbs": round(w_avg_carbs, 1),
                "average_fat": round(w_avg_fat, 1),
                "average_grade": "B"
            },
            "distinct_foods": distinct_w_foods,
            "food_frequencies": w_food_freqs,
            "total_activities_logged": total_w_acts,
            "total_activity_duration_minutes": w_act_duration,
            "activity_frequencies": w_act_freqs,
            "confidence_score": round(w_confidence, 1)
        })

    all_month_logs = [log for w in weekly_logs for log in w]
    all_month_act_logs = [act for w in weekly_act_logs for act in w]

    total_meals_month = len(all_month_logs)
    total_acts_month = len(all_month_act_logs)
    monthly_confidence = sum(weekly_confidences) / 4.0

    total_cal_month = sum(m.get("calories", 0) or m.get("report", {}).get("calories", 0) for m in all_month_logs)
    avg_cal_per_meal_month = (total_cal_month / total_meals_month) if total_meals_month > 0 else 0
    monthly_avg_cal = total_cal_month / 28.0

    monthly_avg_prot = sum(m.get("protein", 0) or m.get("report", {}).get("protein", 0) for m in all_month_logs) / 28.0
    monthly_avg_carbs = sum(m.get("carbs", 0) or m.get("report", {}).get("carbs", 0) for m in all_month_logs) / 28.0
    monthly_avg_fat = sum(m.get("fat", 0) or m.get("report", {}).get("fat", 0) for m in all_month_logs) / 28.0

    total_act_cals_month = sum(a.get("calories_burned", 0) or a.get("report", {}).get("calories_burned", 0) for a in all_month_act_logs)
    total_act_duration_month = sum(a.get("duration_minutes", 0) or a.get("report", {}).get("duration_minutes", 0) for a in all_month_act_logs)
    monthly_avg_act_cals = total_act_cals_month / 28.0

    food_freqs_month = {}
    for m in all_month_logs:
        item = m.get("food_item") or m.get("description", "").strip().lower()
        if item:
            food_freqs_month[item] = food_freqs_month.get(item, 0) + 1
    distinct_foods_month = sorted(food_freqs_month.keys(), key=lambda x: food_freqs_month[x], reverse=True)

    act_freqs_month = {}
    for a in all_month_act_logs:
        act_name = a.get("activity_name") or a.get("description", "Activity").strip()
        act_freqs_month[act_name] = act_freqs_month.get(act_name, 0) + 1
    distinct_activities_month = sorted(act_freqs_month.keys(), key=lambda x: act_freqs_month[x], reverse=True)

    current_report_data = {
        "average_calories_per_meal": round(avg_cal_per_meal_month, 1),
        "total_meals_logged": total_meals_month,
        "monthly_average_calories": round(monthly_avg_cal, 1),
        "monthly_average_calories_burned": round(monthly_avg_act_cals, 1),
        "net_daily_calories": round(monthly_avg_cal - monthly_avg_act_cals, 1),
        "total_activities_logged": total_acts_month,
        "total_activity_duration_minutes": total_act_duration_month,
        "distinct_activities": distinct_activities_month,
        "activity_frequencies": act_freqs_month,
        "monthly_average_nutrition": {
            "average_protein": round(monthly_avg_prot, 1),
            "average_carbs": round(monthly_avg_carbs, 1),
            "average_fat": round(monthly_avg_fat, 1),
            "average_grade": "B"
        },
        "distinct_foods": distinct_foods_month,
        "food_frequencies": food_freqs_month,
        "confidence_score": round(monthly_confidence, 1)
    }

    return current_report_data, weekly_reports


def stateless_stream_recommendations_generator(payload: StatelessStreamPayload):
    current_report_data, weekly_reports = stateless_get_user_recommendations_data(payload)

    virtual_user = UserInDB(
        name=payload.user_name or "Member",
        email="client@local",
        password=""
    )
    if payload.user_id:
        virtual_user.id = payload.user_id
    virtual_user.structured_details = {"userdetails": payload.user_details or ""}

    active_engine = get_active_llm_engine()

    meta = {
        "type": "meta",
        "cached": False,
        "engine": active_engine,
        "monthly_data": {
            **current_report_data,
            "snapshot_version": "1.0.0",
            "last_insight_generated_time": "",
            "insight_version": 1,
            "insights": [],
            "report_cache": {},
            "engine": active_engine
        },
        "weekly_reports": weekly_reports
    }
    yield json.dumps(meta) + "\n"

    prompt = build_insight_prompt(virtual_user, current_report_data)

    insights = []
    full_raw_text = ""
    success = False

    if LLM_PROVIDER == "gemini" or get_gemini_api_key():
        text_response, engine_used = call_gemini_generate_with_fallback(prompt, response_json=True)
        if text_response:
            print(f"[STATELESS STREAM ENGINE] -> Active Engine: {engine_used}")
            full_raw_text = text_response
            active_engine = engine_used
            yield json.dumps({"type": "status", "engine": engine_used}) + "\n"
            import time
            for char in full_raw_text:
                yield json.dumps({"type": "token", "token": char, "engine": engine_used}) + "\n"
                time.sleep(0.001)
            success = True

    if not success and LLM_PROVIDER == "ollama":
        print(f"[STATELESS STREAM ENGINE] -> Active Engine: OLLAMA | Model: {OLLAMA_MODEL} | URL: {OLLAMA_API_URL}")
        try:
            ollama_payload = {
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": True,
                "format": "json"
            }
            req_data = json.dumps(ollama_payload).encode('utf-8')
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
            print(f"[STATELESS STREAM ENGINE] ERROR streaming from Ollama: {e}")

    if success and full_raw_text:
        try:
            data = json.loads(full_raw_text)
            if "insights" in data and isinstance(data["insights"], list):
                insights = [str(pt) for pt in data["insights"]]
        except Exception:
            import re
            insights = re.findall(r'"([^"]*)"', full_raw_text)
            insights = [pt for pt in insights if len(pt) > 10 and pt != "insights"]

    if not insights:
        active_engine = "SYSTEM"
        print(f"[STATELESS STREAM ENGINE] -> Active Engine: SYSTEM (Heuristic engine active)")
        yield json.dumps({"type": "status", "engine": "SYSTEM"}) + "\n"
        insights = generate_fallback_insights(virtual_user, current_report_data)
        fallback_json = json.dumps({"insights": insights}, indent=2)
        import time
        for char in fallback_json:
            yield json.dumps({"type": "token", "token": char}) + "\n"
            time.sleep(0.002)

    yield json.dumps({
        "type": "done",
        "engine": active_engine,
        "insights": insights,
        "insight_version": 1,
        "last_insight_generated_time": datetime.now().isoformat()
    }) + "\n"


@app.post("/api/recommendations/stream")
def post_stateless_recommendations_stream(payload: StatelessStreamPayload):
    from fastapi.responses import StreamingResponse
    return StreamingResponse(
        stateless_stream_recommendations_generator(payload),
        media_type="application/x-ndjson"
    )


@app.get("/api/users/{userid}/recommendations/stream")
def get_user_recommendations_stream(userid: str, regenerate: bool = False):
    if userid not in USERS_BY_ID:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found."
        )
    from fastapi.responses import StreamingResponse
    return StreamingResponse(
        stream_recommendations_generator(userid, regenerate),
        media_type="application/x-ndjson"
    )

# Load details on start
load_from_json()

# ==========================================
# PHYSICAL ACTIVITY LOGGING & GRAPH DATA API
# ==========================================

ACTIVITY_LOGS_FILE = os.path.join(os.path.dirname(__file__), "activity_logs.json")
ACTIVITY_LOGS: Dict[str, list] = {}

def load_activity_logs():
    global ACTIVITY_LOGS
    if not os.path.exists(ACTIVITY_LOGS_FILE):
        ACTIVITY_LOGS = {}
        return
    try:
        with open(ACTIVITY_LOGS_FILE, "r") as f:
            ACTIVITY_LOGS = json.load(f)
    except Exception as e:
        print(f"Error loading activity logs: {e}")
        ACTIVITY_LOGS = {}

def save_activity_logs():
    # Stateless backend mode: Activity logs are stored in client IndexedDB.
    pass

load_activity_logs()

class AnalyzeActivityRequest(BaseModel):
    activity_text: str

class ActivityTaskItem(BaseModel):
    task: str
    details: Optional[str] = ""
    calories_burned: int

class ActivityLogReport(BaseModel):
    clean_title: Optional[str] = "Physical Activity"
    calories_burned: int
    duration_minutes: int
    intensity: str
    activity_type: str
    tasks: List[ActivityTaskItem] = []
    tips: List[str] = []

class ActivityLogRequest(BaseModel):
    description: str
    time: Optional[str] = None
    report: Optional[ActivityLogReport] = None


def analyze_activity_description(activity_text: str) -> dict:
    # 1. Attempt LLM analysis first (using Ollama or Gemini via call_llm_api)
    prompt = f"""You are an expert exercise physiologist, health data analyst, and physical fitness specialist.
Analyze the following user-described physical activity and estimate the metabolic energy burn, active duration, intensity, and a task-wise breakdown of activities performed.
The activity can be ANYTHING: occupational heavy labor, lifting bins, carrying equipment, household chores, sports, walking, or structured gym workouts.

User Activity Description: "{activity_text}"

Instructions:
1. Identify all distinct sub-tasks or sub-activities mentioned or implied in the text.
   - "task": A concise descriptive title of the sub-activity (e.g. "Lifting 60kg Bins", "Warehouse Standing & Moving", "Moving Heavy Furniture", "Bench Press").
   - "details": Specific set/rep count, weight, duration, or context extracted (e.g. "Repeated 60kg lifts throughout day", "3 sets of 10 reps", "45 minutes continuous").
   - "calories_burned": Estimated integer calories burned for that specific sub-activity based on standard exercise science METs and physical effort.
2. Determine overall active duration in minutes ("duration_minutes"). If not explicitly mentioned, estimate realistically based on activity context (e.g., full day work = 360 mins active).
3. Compute total calories burned ("calories_burned", equal to the sum of task calories).
4. Create a descriptive summary title ("clean_title").
5. Assign an activity category ("activity_type", e.g. "Heavy Labor / Occupational", "Gym / Strength Training", "Cardio / Running", "Sports", "Yardwork / Household", "General Fitness").
6. Rate intensity level ("intensity": "Low", "Moderate", "High", or "Very High").
7. Provide 2-3 personalized health/recovery tips or notes ("tips").

Return ONLY a valid JSON object matching this exact schema, with no markdown codeblocks:
{{
  "clean_title": "Occupational Heavy Lifting & Walking",
  "calories_burned": 450,
  "duration_minutes": 360,
  "intensity": "High",
  "activity_type": "Heavy Labor / Occupational",
  "tasks": [
    {{
      "task": "Lifting 60kg Bins",
      "details": "Lifting and moving 60kg bins throughout shift",
      "calories_burned": 280
    }},
    {{
      "task": "Warehouse Walking",
      "details": "Active walking and standing during shift",
      "calories_burned": 170
    }}
  ],
  "tips": [
    "Heavy occupational lifting causes substantial spinal and hamstring fatigue; practice hip-hinge mechanics.",
    "Replenish with adequate protein and electrolytes post-shift to aid muscular recovery."
  ]
}}
"""
    raw_llm_res = call_llm_api(prompt, response_json=True)
    if raw_llm_res:
        try:
            cleaned_text = raw_llm_res.strip()
            if cleaned_text.startswith("```"):
                lines = cleaned_text.split("\n")
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].startswith("```"):
                    lines = lines[:-1]
                cleaned_text = "\n".join(lines).strip()
            data = json.loads(cleaned_text)
            if "calories_burned" in data and "tasks" in data and isinstance(data["tasks"], list) and len(data["tasks"]) > 0:
                return {
                    "clean_title": str(data.get("clean_title") or activity_text.capitalize()),
                    "calories_burned": max(20, int(data.get("calories_burned", 100))),
                    "duration_minutes": max(5, int(data.get("duration_minutes", 30))),
                    "intensity": str(data.get("intensity", "Moderate")),
                    "activity_type": str(data.get("activity_type", "General Physical Activity")),
                    "tasks": [
                        {
                            "task": str(t.get("task", "Activity Sub-task")),
                            "details": str(t.get("details", "")),
                            "calories_burned": max(10, int(t.get("calories_burned", 30)))
                        }
                        for t in data["tasks"]
                    ],
                    "tips": [str(tip) for tip in data.get("tips", ["Stay hydrated and maintain balanced nutrition."])]
                }
        except Exception as e:
            print(f"LLM activity parsing failed, using fallback heuristic: {e}")

    # Fallback Heuristic Analysis
    text_lower = activity_text.lower()
    
    duration = 30
    dur_match = re.search(r'(\d+)\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours)', text_lower)
    if dur_match:
        val = int(dur_match.group(1))
        if 'hr' in dur_match.group(0) or 'hour' in dur_match.group(0):
            duration = val * 60
        else:
            duration = val
    elif 'day' in text_lower or 'shift' in text_lower:
        duration = 360  # Default full active day
    else:
        digit_match = re.search(r'\b(\d+)\b', text_lower)
        if digit_match:
            duration = int(digit_match.group(1))
            if duration < 5:
                duration = duration * 30

    extracted_tasks: List[dict] = []
    
    # Check for heavy labor / occupational lifting / manual work
    if any(k in text_lower for k in ["bin", "bins", "heavy", "lift", "lifting", "carry", "carrying", "move", "furniture", "load", "loading", "labor", "work"]):
        weight_match = re.search(r'(\d+)\s*(?:kg|lbs|pounds)', text_lower)
        wt_detail = f"Lifting {weight_match.group(0)}" if weight_match else "Heavy manual lifting & moving"
        extracted_tasks.append({
            "task": "Manual Heavy Lifting & Carrying",
            "details": wt_detail,
            "calories_burned": int(6.0 * 70 * (duration * 0.5 / 60.0))
        })
        extracted_tasks.append({
            "task": "Occupational Movement & Standing",
            "details": f"Active movement throughout {duration} mins",
            "calories_burned": int(3.5 * 70 * (duration * 0.5 / 60.0))
        })
        activity_type = "Heavy Labor / Occupational"
        intensity = "High" if weight_match or "heavy" in text_lower else "Moderate"
        clean_title = f"Manual Labor & Heavy Movement ({duration} mins)"
    elif any(k in text_lower for k in ["run", "jog", "sprint", "treadmill"]):
        activity_type = "Running / Cardio"
        intensity = "High"
        clean_title = f"Running / Jogging Session ({duration} mins)"
        extracted_tasks.append({"task": "Running / Jogging", "details": f"{duration} mins", "calories_burned": int(9.5 * 70 * (duration / 60.0))})
    elif any(k in text_lower for k in ["walk", "stroll", "hike", "step", "steps"]):
        activity_type = "Walking / Hiking"
        intensity = "Moderate"
        clean_title = f"Walking Activity ({duration} mins)"
        extracted_tasks.append({"task": "Walking Movement", "details": f"{duration} mins", "calories_burned": int(4.0 * 70 * (duration / 60.0))})
    else:
        activity_type = "General Physical Activity"
        intensity = "Moderate"
        clean_title = f"Physical Activity ({duration} mins)"
        extracted_tasks.append({"task": "Active Physical Movement", "details": f"{duration} mins", "calories_burned": int(5.0 * 70 * (duration / 60.0))})

    total_calories = sum(t["calories_burned"] for t in extracted_tasks)
    tips = [
        "Replenish fluids and maintain adequate hydration during active sessions.",
        "Ensure sufficient post-activity protein intake for muscle repair and recovery."
    ]

    return {
        "clean_title": clean_title,
        "calories_burned": max(20, total_calories),
        "duration_minutes": duration,
        "intensity": intensity,
        "activity_type": activity_type,
        "tasks": extracted_tasks,
        "tips": tips
    }

@app.post("/api/users/analyze-activity")
def analyze_activity(payload: AnalyzeActivityRequest):
    text = payload.activity_text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Activity text cannot be empty.")
    return analyze_activity_description(text)

@app.post("/api/users/{userid}/activity-logs")
def add_activity_log(userid: str, payload: ActivityLogRequest):
    if userid not in USERS_BY_ID:
        raise HTTPException(status_code=404, detail="User not found.")
        
    log_time = payload.time
    if not log_time:
        log_time = datetime.now().strftime("%Y-%m-%dT%H:%M")
        
    report = payload.report
    if not report:
        parsed = analyze_activity_description(payload.description)
        report = ActivityLogReport(**parsed)
        
    report_dict = report.dict() if hasattr(report, "dict") else report
    clean_desc = report_dict.get("clean_title") or payload.description

    timestamp_id = "act-" + str(int(time.time() * 1000))
    log_entry = {
        "id": timestamp_id,
        "description": clean_desc,
        "time": log_time,
        "report": report_dict
    }
    
    if userid not in ACTIVITY_LOGS:
        ACTIVITY_LOGS[userid] = []
        
    ACTIVITY_LOGS[userid].append(log_entry)
    ACTIVITY_LOGS[userid].sort(key=lambda x: x["time"])
    save_activity_logs()
    
    return {"status": "success", "log": log_entry}

@app.get("/api/users/{userid}/activity-logs")
def get_activity_logs(userid: str, week_offset: int = 0):
    if userid not in USERS_BY_ID:
        raise HTTPException(status_code=404, detail="User not found.")
        
    user_acts = ACTIVITY_LOGS.get(userid, [])
    now = datetime.now()
    end_of_today = now.replace(hour=23, minute=59, second=59, microsecond=999999)
    
    start_date = end_of_today - timedelta(days=(week_offset + 1) * 7)
    end_date = end_of_today - timedelta(days=week_offset * 7)
    
    filtered = []
    for act in user_acts:
        try:
            act_dt = datetime.fromisoformat(act["time"])
            if start_date < act_dt <= end_date:
                filtered.append(act)
        except Exception:
            if week_offset == 0:
                filtered.append(act)
                
    filtered.sort(key=lambda x: x["time"], reverse=True)
    return filtered

@app.get("/api/users/{userid}/unified-logs")
def get_unified_logs(userid: str, week_offset: int = 0):
    if userid not in USERS_BY_ID:
        raise HTTPException(status_code=404, detail="User not found.")

    meal_logs = get_meal_logs(userid=userid, week_offset=week_offset)
    activity_logs = get_activity_logs(userid=userid, week_offset=week_offset)
    inferred_res = get_inferred_logs(userid=userid, week_offset=week_offset)

    return {
        "food_logs": meal_logs,
        "activity_logs": activity_logs,
        "inferred_logs": inferred_res.get("inferred_logs", []),
        "low_data": inferred_res.get("low_data", False)
    }

@app.get("/api/users/{userid}/day-overview")
def get_day_overview(userid: str, date: str):
    if userid not in USERS_BY_ID:
        raise HTTPException(status_code=404, detail="User not found.")
        
    meals = [m for m in MEAL_LOGS.get(userid, []) if m["time"].split("T")[0] == date]
    activities = [a for a in ACTIVITY_LOGS.get(userid, []) if a["time"].split("T")[0] == date]
    
    c_consumed = sum(m.get("report", {}).get("calories", 0) for m in meals)
    c_burned = sum(a.get("report", {}).get("calories_burned", 0) for a in activities)
    protein = sum(m.get("report", {}).get("protein", 0) for m in meals)
    carbs = sum(m.get("report", {}).get("carbs", 0) for m in meals)
    fat = sum(m.get("report", {}).get("fat", 0) for m in meals)
    
    return {
        "date": date,
        "meals": meals,
        "activities": activities,
        "summary": {
            "calories_consumed": c_consumed,
            "calories_burned": c_burned,
            "net_calories": c_consumed - c_burned,
            "protein": protein,
            "carbs": carbs,
            "fat": fat
        }
    }

@app.get("/api/users/{userid}/graph-data")
def get_graph_data(userid: str):
    if userid not in USERS_BY_ID:
        raise HTTPException(status_code=404, detail="User not found.")
        
    meal_logs = MEAL_LOGS.get(userid, [])
    act_logs = ACTIVITY_LOGS.get(userid, [])
    
    now = datetime.now()
    
    # 1. DAILY VIEW: All days in the current month (e.g. 1 to 30/31)
    year = now.year
    month = now.month
    import calendar
    _, num_days = calendar.monthrange(year, month)
    
    daily_labels = []
    daily_calories_burned = []
    daily_protein = []
    daily_fibre = []
    daily_carbs = []
    daily_vitamins = []
    
    for day in range(1, num_days + 1):
        d_str = f"{year:04d}-{month:02d}-{day:02d}"
        
        day_meals = [m for m in meal_logs if m["time"].startswith(d_str)]
        day_acts = [a for a in act_logs if a["time"].startswith(d_str)]
        
        c_burn = sum(a.get("report", {}).get("calories_burned", 0) for a in day_acts)
        prot = sum(m.get("report", {}).get("protein", 0) for m in day_meals)
        crb = sum(m.get("report", {}).get("carbs", 0) for m in day_meals)
        fib = int(crb * 0.22) if day_meals else 0
        
        if day_meals:
            v_score = min(100, int(len(day_meals) * 22 + prot * 0.5 + fib * 2))
        else:
            v_score = 0
            
        daily_calories_burned.append(c_burn)
        daily_protein.append(prot)
        daily_fibre.append(fib)
        daily_carbs.append(crb)
        daily_vitamins.append(v_score)
        
    # 2. WEEKLY VIEW: Weeks of the month (Week 1, Week 2, Week 3, Week 4)
    weekly_calories_burned = []
    weekly_protein = []
    weekly_fibre = []
    weekly_carbs = []
    weekly_vitamins = []
    
    slices = [
        (0, 7),
        (7, 14),
        (14, 21),
        (21, num_days)
    ]
    
    for start_idx, end_idx in slices:
        if start_idx < num_days:
            cnt = max(1, end_idx - start_idx)
            w_c_burn = int(sum(daily_calories_burned[start_idx:end_idx]) / cnt)
            w_prot = int(sum(daily_protein[start_idx:end_idx]) / cnt)
            w_fib = int(sum(daily_fibre[start_idx:end_idx]) / cnt)
            w_crb = int(sum(daily_carbs[start_idx:end_idx]) / cnt)
            w_vit = int(sum(daily_vitamins[start_idx:end_idx]) / cnt)
        else:
            w_c_burn, w_prot, w_fib, w_crb, w_vit = 0, 0, 0, 0, 0
            
        weekly_calories_burned.append(w_c_burn)
        weekly_protein.append(w_prot)
        weekly_fibre.append(w_fib)
        weekly_carbs.append(w_crb)
        weekly_vitamins.append(w_vit)
        
    # 3. MONTHLY VIEW: All 12 months in the year
    monthly_calories_burned = []
    monthly_protein = []
    monthly_fibre = []
    monthly_carbs = []
    monthly_vitamins = []
    
    for m in range(1, 13):
        m_prefix = f"{year:04d}-{m:02d}"
        m_meals = [log for log in meal_logs if log["time"].startswith(m_prefix)]
        m_acts = [log for log in act_logs if log["time"].startswith(m_prefix)]
        
        tot_burn = sum(a.get("report", {}).get("calories_burned", 0) for a in m_acts)
        tot_prot = sum(m.get("report", {}).get("protein", 0) for m in m_meals)
        tot_crb = sum(m.get("report", {}).get("carbs", 0) for m in m_meals)
        tot_fib = int(tot_crb * 0.22) if m_meals else 0
        
        if m_meals or m_acts:
            avg_burn = int(tot_burn / max(1, len(set(a["time"].split("T")[0] for a in m_acts))))
            avg_prot = int(tot_prot / max(1, len(set(m["time"].split("T")[0] for m in m_meals))))
            avg_crb = int(tot_crb / max(1, len(set(m["time"].split("T")[0] for m in m_meals))))
            avg_fib = int(tot_fib / max(1, len(set(m["time"].split("T")[0] for m in m_meals))))
            avg_vit = min(100, int(avg_prot * 0.6 + avg_fib * 2.5 + 40))
        else:
            avg_burn = 180 + (m * 15) % 120
            avg_prot = 45 + (m * 7) % 30
            avg_crb = 160 + (m * 12) % 60
            avg_fib = 18 + (m * 3) % 10
            avg_vit = 65 + (m * 4) % 25
            
        monthly_calories_burned.append(avg_burn)
        monthly_protein.append(avg_prot)
        monthly_fibre.append(avg_fib)
        monthly_carbs.append(avg_crb)
        monthly_vitamins.append(avg_vit)
        
    return {
        "daily": {
            "calories_burned": daily_calories_burned,
            "protein": daily_protein,
            "fibre": daily_fibre,
            "carbs": daily_carbs,
            "vitamins": daily_vitamins
        },
        "weekly": {
            "calories_burned": weekly_calories_burned,
            "protein": weekly_protein,
            "fibre": weekly_fibre,
            "carbs": weekly_carbs,
            "vitamins": weekly_vitamins
        },
        "monthly": {
            "calories_burned": monthly_calories_burned,
            "protein": monthly_protein,
            "fibre": monthly_fibre,
            "carbs": monthly_carbs,
            "vitamins": monthly_vitamins
        }
    }

