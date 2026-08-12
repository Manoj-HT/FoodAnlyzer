# Privacy Policy for FoodAnalyzer

**Effective Date:** August 8, 2026  
**Last Updated:** August 8, 2026  
**Project Lead:** Manoj H T & Team (PES University Electronic City Campus)  
**Contact Email:** `manulogan101@gmail.com` / `privacy@foodanalyzer.app`

---

## Our Commitment to Your Privacy

At **FoodAnalyzer**, we believe your health, dietary choices, voice recordings, and exercise activities are deeply personal. We designed FoodAnalyzer from the ground up with a **privacy-first, local-first mindset**.

> **The Core Promise:**  
> **Your data belongs to you.** We do not sell your personal information, we do not build advertising profiles, and we treat cloud storage strictly as an optional backup layer to keep your records safe across devices.

---

## 1. How Your Data is Handled & Stored

### A. Local-First Browser & Device Storage (`IndexedDB`)
* **Primary Storage:** All your daily meal entries, exercise logs, calculated macronutrients, and personalized health recommendations are stored directly on your browser or mobile device inside an isolated, encrypted local database (`IndexedDB`).
* **Offline Capability:** You can access your logs, review your weekly food diary, and track your activity history even without an active internet connection.

### B. Cloud Synchronization & Secure Backup Only
* **Purpose of Cloud Backup:** When you create an account or sign in with Google OAuth, a copy of your account profile and structured logs is saved to our secure cloud database (Supabase) **strictly to serve as a backup**.
* **Why We Store Backups:** If you switch smartphones, clear your browser cache, or re-install the application, your health records are safely restored so you never lose your personal history.
* **No Unnecessary Telemetry:** We store only what is essential for restoring your account (email, display name, structured health preferences, meal/workout entries, and generated recommendations).

---

## 2. Right to Data Erasure & Full Account Deletion

You retain **complete control** over your information at all times.

* **On-Demand Deletion:** If you ever wish to remove your data, delete your account, or purge your cloud backups, you can request immediate account and data erasure.
* **How to Request Removal:** Simply contact us at `manulogan101@gmail.com` or use the in-app account deletion request option in your Profile tab.
* **Immediate Purge:** Upon receiving your request, all cloud backup records, user profiles, and associated database entries will be **permanently deleted within 24 hours**.
* **Local Purge:** You can also clear your local application data at any time directly through your browser or mobile app settings.

---

## 3. Data Ownership & Native Gzip Export

We believe in complete data portability without vendor lock-in.

* **Full Data Export:** You can export your entire health history at any time from your Profile page.
* **Stream Compressed Backup (`.json.gz`):** Exports are packed using native Web Gzip stream compression (`CompressionStream('gzip')`) to create lightweight, portable backup files.
* **Native Mobile Sharing:** On mobile devices (Android), FoodAnalyzer routes your backups directly to your native `Documents` folder via `@capacitor/filesystem` or lets you share them securely via Google Drive, messaging apps, or local storage.

---

## 4. Zero Data Monetization & Zero Third-Party Advertising

* **No Data Selling:** We **never** sell, rent, monetize, or share your nutritional entries, body metrics, or exercise logs with third-party advertisers, data brokers, or insurance companies.
* **No Ad Trackers:** FoodAnalyzer does not contain third-party ad network scripts, tracking pixels, or cross-site behavioral analytics trackers.

---

## 5. Artificial Intelligence & Audio / Vision Processing

To provide instant nutritional insights, food identification, and speech-to-text logging:

* **Voice & Audio Notes:** Spoken meal recordings are processed strictly to transcribe your voice into plain text. Voice recordings are processed in real-time and are **never** stored permanently on third-party servers.
* **Food Photographs:** Meal photos uploaded for visual recognition are analyzed solely to identify food items and estimate macronutrients. Photos are not used for public AI training datasets or facial recognition.
* **Cloud AI Fallbacks:** High-level contextual recommendations are processed via secure cloud endpoints (Google Gemini 1.5 Flash) over HTTPS SSL encryption.

---

## 6. Future Roadmap: 100% Full Offline Mode & On-Device AI

We are actively advancing our privacy technology to bring complete offline autonomy to FoodAnalyzer:

* **On-Device Micro-SLMs:** We are actively researching and developing client-side Small Language Models (`Qwen2.5-1.5B`) quantized to run directly inside your device's browser using WebGPU and WebAssembly (WASM).
* **Zero Cloud Dependency:** In upcoming updates, AI entity extraction and nutritional analysis will be capable of executing **100% locally on your smartphone or browser** without sending a single byte of audio, image, or text data over the internet.

---

## 7. Contact Us

If you have any questions, concerns, or feedback regarding this Privacy Policy, or if you would like to submit a data erasure request, please reach out to us:

* **Email:** `manulogan101@gmail.com`
* **Department:** Department of Computer Science & Engineering  
* **Institution:** PES University Electronic City Campus, Bengaluru – 560100, Karnataka, India

---

*Thank you for trusting FoodAnalyzer with your personal health journey.*
