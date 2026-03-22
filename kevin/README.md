# Restaurant Decider AI (Perplexity + Google Places)

This is a chatbot web app that narrows your dining preferences through conversation, then returns nearby restaurant options using Google Places.

## Stack

- Backend: Flask
- AI brain: Perplexity Chat Completions API
- Restaurant data: Google Places API
- Hosting: Google Cloud Run
- Frontend: Vanilla HTML/CSS/JS

## 1) Local setup

1. Create a Python virtual environment:
   - `python3 -m venv .venv`
   - `source .venv/bin/activate`
2. Install dependencies:
   - `pip install -r requirements.txt`
3. Create `.env` from `.env.example` and set keys:
   - `PERPLEXITY_API_KEY`
   - `GOOGLE_PLACES_API_KEY`
   - Optional **Firebase** (accounts, saved/visited restaurants, synced preferences): see **Firebase setup** below.
4. Run:
   - `python app.py`
5. Open:
   - `http://localhost:8080`

`app.py` auto-loads values from `.env` on startup.

Optional: set `PERPLEXITY_QUESTION_TEMPERATURE` (default `0.55`) in `.env` to tune how varied vs steady the chat questions feel—higher = more creative, lower = more consistent.

Optional: set `RECOMMENDATION_THRESHOLD` (default `38`, range `15`–`90`) in `.env`. Lower values show the restaurant carousel **sooner** (once the model’s confidence reaches that number); higher values wait for more questions.

## 2) Google APIs you need

In Google Cloud Console:

1. Enable `Places API` (includes **Place Autocomplete** for the city/area field), `Geocoding API`, `Distance Matrix API`, and `Time Zone API` for your project. Geocoding fills the City/Area field from GPS and resolves the typed city to lat/lng for search anchoring (typed area is preferred over raw GPS for *where* to look), for the clock when GPS is off, and for drive times when needed; Distance Matrix powers drive times from the user’s GPS when available; Time Zone powers local clock display for that area. **Dish/menu hints:** Place Details provides editorial summaries and reviews—not a full Business Profile menu; the app uses those when you ask what to order.
2. Create an API key.
3. Restrict the key for Places API usage.

### Firebase (optional — Google sign-in & Firestore)

Use this for **accounts**, **saved / visited restaurants**, and **preferences** synced into the AI.

1. In [Firebase Console](https://console.firebase.google.com), create or open a project.
2. Enable **Authentication** → Sign-in method → **Google**.
3. Enable **Firestore** (Native mode). For a hackathon you can start in test mode; tighten rules for production.
4. Register a **Web** app under Project settings and copy values into `.env`: `FIREBASE_WEB_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`. Set `FIREBASE_AUTH_DOMAIN` if you use a custom domain; otherwise the server defaults it to `{FIREBASE_PROJECT_ID}.firebaseapp.com`.
5. **Service account** (for the Flask server): Project settings → Service accounts → Generate new private key (JSON). Set `GOOGLE_APPLICATION_CREDENTIALS` to that file’s path on the machine running `app.py` (see `.env.example`).
6. Install deps: `pip install -r requirements.txt` (includes `firebase-admin`).

If Firebase env vars are missing, the app still runs; sign-in is disabled and data stays local to the browser session only.

## 3) Deploy to Google Cloud Run

Make sure you installed [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) and authenticated:

- `gcloud auth login`
- `gcloud config set project YOUR_PROJECT_ID`

Then run:

1. Build and submit container:
   - `gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/restaurant-decider-ai`
2. Deploy to Cloud Run:
   - `gcloud run deploy restaurant-decider-ai --image gcr.io/YOUR_PROJECT_ID/restaurant-decider-ai --platform managed --region us-central1 --allow-unauthenticated --set-env-vars PERPLEXITY_API_KEY=YOUR_PERPLEXITY_API_KEY,GOOGLE_PLACES_API_KEY=YOUR_GOOGLE_PLACES_API_KEY`

Cloud Run will output a public HTTPS URL for the app.

### Firebase sign-in on Cloud Run (if Google sign-in fails after deploy)

1. **Set the same Firebase web env vars on the service** as locally (`FIREBASE_WEB_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, plus Admin credentials — see Cloud Run docs for Secret Manager). Confirm in the browser: `https://YOUR-SERVICE-URL.run.app/api/config` shows non-empty `firebase.apiKey`, `authDomain`, `projectId`.

2. **Firebase Console → Authentication → Settings → Authorized domains** — add your **Cloud Run hostname** only (no `https://`), e.g. `my-service-xxxxx-uc.a.run.app`. Without this, Google sign-in returns `auth/unauthorized-domain`.

3. **Google Cloud Console → APIs & Services → Credentials** — if your **Browser key** (same key as `FIREBASE_WEB_API_KEY`) has **HTTP referrer** restrictions, add your Cloud Run URL pattern (e.g. `https://*.run.app/*` or your exact service URL). A key restricted to `localhost` only will break production.

4. Hard-refresh the app after deploy (`Cmd+Shift+R` / `Ctrl+Shift+R`) so the browser loads the latest `app.js`.

5. **Firestore + “memory” + saves:** The browser signs in with Firebase **client** keys, but the server must also load a **Firebase Admin** service account (`GOOGLE_APPLICATION_CREDENTIALS` pointing at the JSON file, or `FIREBASE_CREDENTIALS_JSON` with the JSON string — common on Cloud Run via Secret Manager). Without Admin, the server **cannot verify ID tokens**, so `/api/chat` won’t attach your user id, **preferences won’t sync**, and **Save / visited** will fail. Check `GET /api/config`: `firestore_enabled` should be `true`.

## Notes

- Do not commit secret keys in source files.
- Chat **sessions** stay in memory (demo/hackathon). User **profiles and restaurant history** use Firestore when Firebase is configured.
