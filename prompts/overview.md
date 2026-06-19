# FoodAnalyzer Codebase Context & Overview

This document provides a comprehensive overview of the **FoodAnalyzer** codebase. It is designed to serve as a context file for AI assistants to quickly understand the project's structure, files, interfaces, and architecture.

---

## 🏗️ Project Architecture

FoodAnalyzer is composed of a **Python (FastAPI) Backend** and an **Angular (v17+) Frontend** organized as a Single Page Application (SPA).

```
FoodAnlyzer/
├── backend/            # FastAPI python backend
├── frontend/           # Angular frontend client
└── prompts/            # Configuration and AI prompt guidance files
```

---

## 🐍 Backend Overview (`backend/`)

The backend handles user authentication, profile data persistence, and heuristic bio parsing.

### 1. Key Files
- **`main.py`**: The application entry point containing FastAPI setup, Pydantic schemas, REST endpoints, and mock database operations.
- **`users.json`**: A lightweight local file-based database for persistence.
- **`requirements.txt`**: Declares dependencies (`fastapi`, `uvicorn`, `pydantic`).
- **`run.sh`**: A shell script that automatically sets up the Python virtual environment (`venv`), installs dependencies, and launches the server.

### 2. Data Structure & Persistent Layer
- **`UserInDB` Class**: Represents the database model storing user attributes (`id`, `name`, `email`, `password`, `bio`, `confirmed`, `token`, `modifications` array).
- **In-Memory Cache**: `USERS_BY_EMAIL` and `USERS_BY_ID` enable fast indexing.
- **File Persistence**: The state (including the modifications array) is written to `users.json` via `save_to_json()` on any updates.

### 3. Smart Facts Extraction Heuristic
The backend parses the user's biography (`bio` field) and modifications list looking for key terms to automatically tag health preferences, conditions, and sensitivities:
* **Goals & Lifestyles:**
  * `"protein"` ➔ Nutrition Goal: Focus on high-protein intake
  * `"muscle"`, `"gain"` ➔ Fitness Target: Muscle building & hypertrophy
  * `"weight"`, `"lose"`, `"diet"` ➔ Dietary Goal: Calorie deficit and weight management
  * `"run"`, `"cardio"`, `"walk"`, `"active"` ➔ Lifestyle: Physically active routine
  * `"veg"`, `"vegan"`, `"plant"` ➔ Dietary Preference: Plant-based or vegetarian diet
  * `"keto"`, `"low carb"` ➔ Dietary Preference: Ketogenic / Low-carbohydrate leanings
  * `"dessert"`, `"sweet"`, `"sugar"` ➔ Health Focus: Moderate sweet/sugar intake
  * `"water"`, `"hydrate"` ➔ Hydration Goal: Monitoring daily water intake
  * `"stress"`, `"sleep"` ➔ Wellness Goal: Optimizing sleep and stress recovery
* **Health Conditions & Sensitivities:**
  * `"diabet"`, `"insulin"`, `"glycemic"` ➔ Health Condition: Blood glucose management / Diabetes considerations
  * `"pressure"`, `"hypertension"`, `"sodium"`, `"salt"` ➔ Health Condition: Cardiovascular care & low-sodium diet focus
  * `"cholesterol"`, `"lipid"`, `"fatty liver"` ➔ Health Condition: Cholesterol management and healthy lipid balance
  * `"thyroid"` ➔ Health Condition: Thyroid regulation / Metabolic rate support
  * `"stomach"`, `"digest"`, `"ibs"`, `"reflux"`, `"gerd"`, `"bloat"` ➔ Health Condition: Sensitive digestion & gut health optimization
  * `"joint"`, `"arthritis"`, `"bone"`, `"knee"` ➔ Wellness Focus: Joint mobility, bone density, and inflammation reduction
  * `"fatigue"`, `"energy"`, `"tired"`, `"exhausted"` ➔ Wellness Focus: Boosting metabolic energy & overcoming fatigue
* **Allergies & Dietary Restrictions:**
  * `"gluten"`, `"celiac"` ➔ Dietary Restriction: Gluten-free sensitivity / Celiac precautions
  * `"lactose"`, `"dairy"`, `"milk"` ➔ Dietary Restriction: Lactose sensitivity / Dairy-free preferences
  * `"allergy"`, `"allergies"`, `"nuts"`, `"peanut"` ➔ Safety Alert: Food allergen precautions (Nut/Food allergy monitoring)


### 4. REST API Endpoints
All routes use the prefix `/api`:
- `POST /users/check` - Checks if an email is already registered.
- `GET /users/{userid}` - Fetches user profile attributes.
- `POST /users/login` - Authenticates user credentials and issues a token.
- `POST /users/register` - Registers new user, runs facts extraction, and returns initial details list.
- `POST /users/{userid}/confirm` - Confirms and locks in the user's details registration state.
- `POST /users/{userid}/update` - Appends modifications to a user's modifications array and runs facts extraction again.
- `POST /users/analyze-image` - Accepts binary food image and classifies it using Swin Transformer model with fallback safety.
- `POST /users/analyze-food` - Accepts a food query, searches USDA FoodData Central dynamically, scores the macronutrients, and returns custom tips.

---

## 🅰️ Frontend Overview (`frontend/`)

The frontend is an Angular Single Page Application configured without Server-Side Rendering (SSR), using SCSS styling and client-side routing.

### 1. Key Technologies
- **Standalone Components**: Components are independent and manage their own imports.
- **Signals**: Modern Angular signals (`signal`, `computed`, etc.) are used for reactive state and data tracking.
- **Router-based SPA**: Routing configurations are managed in `app.routes.ts`.

### 2. Core Service: `AuthService` (`src/app/services/auth.ts`)
Interacts with the FastAPI backend using standard `HttpClient`. Key tasks include:
- API wrappers (`checkEmail`, `login`, `register`, `updateDetails`, `confirmDetails`).
- Local session state management via browser `localStorage` (`userid`, `token`).

### 3. Route Protection: `authGuard` (`src/app/guards/auth.ts`)
- Restricts access to the main dashboard.
- Checks if the user is authenticated via `AuthService.isLoggedIn()`.
- Redirects unauthorized requests back to `/login`.

### 4. SPA Components (`src/app/components/`)

#### A. `LoginComponent` (`login/`)
- **UI State**: Starts with an **Email-only** input form.
- **On Initialization**: Looks for an existing `userid` in `localStorage`. If found, fetches the user's details, pre-fills the email, and enables the password input field.
- **Flow**: Submitting an email checks for registration. If registered, the password field is dynamically enabled. If not, the user is navigated to `/register` with their email passed in the query parameters.

#### B. `RegisterComponent` (`register/`)
- **Step 1 (Form)**: Captures user details (`name`, `email`, `password`, `bio`).
- **Step 2 (Verification)**: Receives the extracted smart facts list from the backend:
  - Displays the facts list in a dedicated template block.
  - Features an **"Any modifications?"** text area.
  - If the modifications area is empty, the button functions as **"Confirm & Go to Dashboard"** (calling `/confirm` API).
  - If the modifications area contains text, the button dynamically updates to **"Update Profile Details"** (calling `/update` API). When updated, it refreshes the smart facts list on-screen.

#### C. `WhatYouAteTodayComponent` (`what-you-ate-today/`)
- Acts as the protected Landing Page (mapped to `/dashboard`).
- Displays a greeting to the authenticated user and a sidebar showing their active bio and wellness goals.
- Provides a mock analyzer interface with a `textarea` for **"What you ate today?"**:
  - Simulates a loading state when analyzing food.
  - Categorizes food entries based on keywords (e.g., "pizza/burger", "salad/chicken breast/fish", "fruit/apple/banana") to return customized calorie values, macronutrient grams (protein, carbs, fats), nutritional health grades (A+, B, C-), and health advice tips.
  - Renders a visually appealing progress bar representing the macronutrient split.

---

## 🎨 Design System & Styling

- Global stylesheet is located in `frontend/src/styles.scss`.
- Uses a **premium light-glassmorphism** design scheme tailored in a soft sage palette:
  - **Background:** Pale dirty green near to white (`radial-gradient` from `#f4f6f3` to `#e6eae4`).
  - **Headings & Accents:** Deep forest/dark greens (`#1b3d22` / `#2c4c38`).
  - **Text:** High-contrast dark charcoal-green (`#2e3d30`).
- Highlights:
  - `.glass-card`: Semitransparent white cards (`rgba(255,255,255,0.75)`) with active backdrop blurs and subtle dark green borders.
  - Responsive grids for metrics cards (`.metrics-grid`) and dual-pane dashboards (`.dashboard-grid`).
  - Tactile action feedback on primary buttons and input focus frames.
