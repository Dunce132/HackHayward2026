# Restaurant Decider AI

A conversational web app that helps you decide where to eat. Chat with an AI that asks about your location, dietary needs, and preferences, then recommends nearby restaurants using Google Places—with support for **group sessions** so friends can decide together.

## Features

### Chat & AI Recommendations
- **Conversational flow** — The AI asks about location, dietary restrictions, meal context, time, budget, and preferences in stages.
- **Smart ranking** — Uses Perplexity AI + Google Places to find and rank restaurants by fit.
- **Match scores** — Each recommendation shows a percentage match to your stated preferences.
- **Dish suggestions** — Ask "what should I order?" for menu tips from reviews and place details.

### Location
- **City / area field** — Type a city or neighborhood; autocomplete suggests locations.
- **Search radius** — Choose 3, 5, 10, 25, or 50 miles.
- **GPS autofill** — Allow location access to auto-fill your area from coordinates.
- **Drive times** — See travel time and distance from your location when available.

### Voice Input
- **Real-time speech-to-text** — Tap the 🎤 mic button to speak; text appears in the input as you talk.
- **Interim results** — See partial transcription while speaking, then finalize when you pause.
- **Continuous mode** — Speak multiple sentences; recognition keeps listening until you stop.

### Group Sessions (Live Sessions)
- **Create session** — Get a 6-character code to share with friends.
- **Join session** — Enter the code to join an existing group.
- **Synced chat** — Everyone sees the same questions, answers, and restaurant picks.
- **Lobby** — View who's in the session (display names).
- **Voting** — Vote for your favorite restaurant; see who voted and each person's match %.
- **Copy code** — One-click copy of the session code from the sidebar.

### Account & Persistence (Firebase)
- **Google sign-in** — Optional; enables saving data across devices.
- **Saved restaurants** — Bookmark picks for later without ending the chat.
- **Visited list** — Record places you’ve been.
- **Profile & preferences** — Save favorite cuisines, foods to avoid, and notes. The AI uses these in future chats.

### Accessibility & i18n
- **Multi-language** — UI in English, Español, 中文, Français, हिन्दी.
- **Read aloud** — TTS button on assistant messages.
- **Responsive** — Works on desktop and mobile.

---

## Usage

### Starting a Chat
1. Enter your **city or area** (or allow GPS to auto-fill).
2. Choose a **search radius** (miles).
3. Type or tap the mic to answer the AI’s questions.
4. Top matches appear in the carousel on the right; swipe or use arrows to browse.

### Quick Answers
When the AI offers quick reply options (e.g. "Spicy" / "Mild"), tap them to answer without typing.

### Saving & Choosing
- **Save for later** — Keeps the restaurant in your list without ending the chat.
- **Choose this place** — Selects it and ends the chat (e.g. for group decision).

### Group Session Flow
1. **Creator:** Click **Create session**. Copy the 6-character code (it also appears in the message input).
2. **Creator:** Share the code with friends.
3. **Joiners:** Enter the code and click **Join**.
4. **Everyone:** Chat and answer questions together. Restaurant picks sync in real time.
5. **Voting:** When restaurants appear, click **Vote** on your favorite. See who voted and their match %.
6. **Leave:** Click **Leave session** when done.

### Reset
Click **Reset chat** to start over with a new conversation.

---

## Setup

### 1. Local Development

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Create `.env` from `.env.example` and set:
- `PERPLEXITY_API_KEY` — Required for chat and recommendations.
- `GOOGLE_PLACES_API_KEY` — Required for restaurant search, autocomplete, photos.

Run:
```bash
python app.py
```

Open http://localhost:8080 (or the port shown; default 8080).

### 2. Google APIs

In [Google Cloud Console](https://console.cloud.google.com):
- Enable **Places API**, **Geocoding API**, **Distance Matrix API**, **Time Zone API**.
- Create an API key and restrict it as needed.

### 3. Firebase (Optional)

For sign-in, saved/visited restaurants, and group session persistence:
- Enable **Authentication** (Google) and **Firestore** in Firebase Console.
- Add web app config to `.env`: `FIREBASE_WEB_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`.
- Set `GOOGLE_APPLICATION_CREDENTIALS` to your Firebase Admin service account JSON path.

Without Firebase, the app runs with in-memory group sessions (cleared on restart).

### Optional .env Variables
- `PERPLEXITY_QUESTION_TEMPERATURE` — Default `0.55`; higher = more varied questions.
- `RECOMMENDATION_THRESHOLD` — Default `38`; lower = show restaurants sooner.
- `PORT` — Default `8080`.

---

## Testing

Run the API test script (with the app running):

```bash
./test_api.sh                      # tests http://127.0.0.1:8080
./test_api.sh http://localhost:8090   # tests a different port
```

Covers: health, config, create session, get session, join session, main page.

---

## Deploy to Google Cloud Run

```bash
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/restaurant-decider-ai
gcloud run deploy restaurant-decider-ai \
  --image gcr.io/YOUR_PROJECT_ID/restaurant-decider-ai \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars PERPLEXITY_API_KEY=...,GOOGLE_PLACES_API_KEY=...
```

For Firebase in production:
- Add the Cloud Run hostname to **Firebase → Authentication → Authorized domains**.
- Ensure `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_CREDENTIALS_JSON` is set on the service.

---

## Stack

- **Backend:** Flask
- **AI:** Perplexity Chat Completions API
- **Data:** Google Places API
- **Auth & Storage:** Firebase (Auth, Firestore)
- **Frontend:** Vanilla HTML/CSS/JS

---

## Notes

- Do not commit API keys or credentials.
- Group sessions use Firestore when configured; otherwise they use in-memory storage (lost on restart).
- Voice input works best in Chrome or Edge.
