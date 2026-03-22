import json
import math
import os
import random
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from difflib import get_close_matches
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import requests
from flask import Flask, Response, abort, jsonify, render_template, request
from dotenv import load_dotenv

import firebase_store

load_dotenv()

# Firestore subcollections (per user)
FS_SAVED = "savedRestaurants"
FS_VISITED = "visitedRestaurants"

# Strip whitespace/newlines — .env paste errors break HTTP headers (Invalid header value)
PERPLEXITY_API_KEY = (os.getenv("PERPLEXITY_API_KEY") or "").strip()
GOOGLE_PLACES_API_KEY = (os.getenv("GOOGLE_PLACES_API_KEY") or "").strip()
PORT = int(os.getenv("PORT", "8080"))
try:
    RECOMMENDATION_THRESHOLD = max(15, min(90, int(os.getenv("RECOMMENDATION_THRESHOLD", "38"))))
except ValueError:
    RECOMMENDATION_THRESHOLD = 38


def _questions_until_results_hint(
    threshold: int,
    readiness: int,
    recommendations_started: bool,
    results_in_response: bool,
) -> str:
    """User-facing estimate until first restaurant carousel (rough heuristic)."""
    if recommendations_started or results_in_response:
        return "Your picks are on the right — keep answering to refine them."
    gap = max(0, threshold - readiness)
    # Assume each exchange can add ~12 points toward the threshold on average.
    n = max(1, min(10, (gap + 11) // 12))
    if n == 1:
        return "About 1 more question until your first restaurant picks appear."
    return f"About {n} more questions until your first restaurant picks appear."


@dataclass
class ChatSession:
    location: Optional[str] = None
    user_lat: Optional[float] = None
    user_lng: Optional[float] = None
    timezone_id: Optional[str] = None  # IANA, from Google Time Zone API (GPS or geocoded area)
    location_geocode_lat: Optional[float] = None
    location_geocode_lng: Optional[float] = None
    location_geocode_for: Optional[str] = None  # session.location string used for geocode cache
    preferences: Dict[str, Any] = field(default_factory=dict)
    history: List[Dict[str, str]] = field(default_factory=list)
    stage_index: int = 0
    readiness_score: int = 0
    recommendations_started: bool = False
    # Last carousel results (for dish/menu questions)
    last_place_ids: List[str] = field(default_factory=list)
    last_place_names: List[str] = field(default_factory=list)


TOP_N_RESTAURANTS = 5
CANDIDATE_PLACES = 12
MAX_PHOTOS_PER_PLACE = 6


def _plain_assistant_reply(text: str) -> str:
    """Strip citation markers and extra whitespace; keep plain text for chat bubbles."""
    t = _safe_strip(text)
    if not t:
        return ""
    t = re.sub(r"\[\d+\]", "", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def _clip_why_fit(text: Any, max_len: int = 180) -> str:
    """Keep restaurant match blurbs short."""
    t = _plain_assistant_reply(text)
    if len(t) <= max_len:
        return t
    cut = t[: max_len].rsplit(" ", 1)[0].strip()
    if len(cut) < max_len // 2:
        return t[:max_len].strip() + "…"
    return cut + "…"


def _price_level_dollars(level: Any) -> str:
    if level is None:
        return "N/A"
    try:
        n = int(level)
    except (TypeError, ValueError):
        return "N/A"
    if n < 0:
        return "N/A"
    if n == 0:
        return "$"
    return "$" * min(4, max(1, n))


_DAY_ABBR = {
    "Monday": "Mon",
    "Tuesday": "Tue",
    "Wednesday": "Wed",
    "Thursday": "Thu",
    "Friday": "Fri",
    "Saturday": "Sat",
    "Sunday": "Sun",
}


def _compact_weekday_text(lines: List[str]) -> str:
    """Shorten Google weekday_text: group adjacent days with identical hours."""
    if not lines:
        return ""
    parsed: List[tuple] = []
    for line in lines:
        s = str(line).strip()
        if not s:
            continue
        if ": " in s:
            day, rest = s.split(": ", 1)
            parsed.append((day.strip(), rest.strip()))
        else:
            parsed.append(("", s))
    if not parsed:
        return ""
    chunks: List[tuple] = []
    for day, hours in parsed:
        if not day:
            continue
        if chunks and chunks[-1][1] == hours:
            chunks[-1][0].append(day)
        else:
            chunks.append(([day], hours))

    def fmt_range(days: List[str]) -> str:
        if len(days) == 1:
            d = days[0]
            return _DAY_ABBR.get(d, d[:3])
        a = _DAY_ABBR.get(days[0], days[0][:3])
        b = _DAY_ABBR.get(days[-1], days[-1][:3])
        return f"{a}–{b}"

    parts = [f"{fmt_range(days)}: {hours}" for days, hours in chunks]
    return " · ".join(parts)


def _hours_text_from_place_details(details_data: Dict[str, Any]) -> str:
    oh = details_data.get("opening_hours") or {}
    lines = oh.get("weekday_text") or []
    if isinstance(lines, list) and lines:
        clean = [str(x) for x in lines if x]
        return _compact_weekday_text(clean)
    return ""


def _geocode_address_to_latlng(address: str) -> Optional[tuple[float, float]]:
    """Forward geocode a city/area string for timezone (Geocoding API)."""
    if not address or not GOOGLE_PLACES_API_KEY:
        return None
    try:
        geo_resp = requests.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={
                "address": address,
                "key": GOOGLE_PLACES_API_KEY,
            },
            timeout=15,
        )
        geo_resp.raise_for_status()
        data = geo_resp.json()
    except (requests.RequestException, ValueError, TypeError):
        return None
    if data.get("status") not in ("OK", "ZERO_RESULTS"):
        return None
    results = data.get("results") or []
    if not results:
        return None
    loc = results[0].get("geometry", {}).get("location") or {}
    try:
        lat = float(loc.get("lat"))
        lng = float(loc.get("lng"))
    except (TypeError, ValueError):
        return None
    return lat, lng


def _ensure_session_timezone(session: ChatSession) -> None:
    if session.timezone_id:
        return
    if not GOOGLE_PLACES_API_KEY:
        return

    lat, lng = session.user_lat, session.user_lng
    if lat is None or lng is None:
        loc = _safe_strip(session.location)
        if loc:
            if session.location_geocode_for != loc or session.location_geocode_lat is None:
                geo = _geocode_address_to_latlng(loc)
                if geo:
                    session.location_geocode_lat, session.location_geocode_lng = geo
                    session.location_geocode_for = loc
                else:
                    session.location_geocode_lat = None
                    session.location_geocode_lng = None
            lat = session.location_geocode_lat
            lng = session.location_geocode_lng

    if lat is None or lng is None:
        return
    try:
        tz_resp = requests.get(
            "https://maps.googleapis.com/maps/api/timezone/json",
            params={
                "location": f"{lat},{lng}",
                "timestamp": int(time.time()),
                "key": GOOGLE_PLACES_API_KEY,
            },
            timeout=10,
        )
        tz_resp.raise_for_status()
        tz_data = tz_resp.json()
        if tz_data.get("status") == "OK":
            session.timezone_id = tz_data.get("timeZoneId")
    except (requests.RequestException, ValueError, TypeError):
        pass


def _format_local_time(tz_id: Optional[str]) -> str:
    if not tz_id:
        return ""
    try:
        now = datetime.now(ZoneInfo(tz_id))
        return now.strftime("%a %b %d, %I:%M %p %Z")
    except Exception:  # pylint: disable=broad-except
        return ""


app = Flask(__name__)
SESSIONS: Dict[str, ChatSession] = {}
# Order matters: location and dietary are always asked before the rest.
STAGES: List[str] = [
    "Location",
    "Dietary restrictions",
    "Meal context",
    "Logistics",
    "Time",
    "Budget",
    "Preferences",
    "Fine tuning",
    "Tie-breakers",
]

# Rotates each turn so Perplexity phrases questions differently (still same stage logic).
QUESTION_STYLE_HINTS: List[str] = [
    "Either/or; two short options in quick_replies only.",
    "One short reaction (≤6 words), then one question.",
    "Keep reply under 18 words total.",
    "Echo one phrase they used, then ask.",
    "One tradeoff question (e.g. fast vs sit-down).",
    "Sound like a friend; skip filler.",
    "quick_replies: 2 short phrases; no numbers in the reply text.",
]

QUESTION_TEMPERATURE = float(os.getenv("PERPLEXITY_QUESTION_TEMPERATURE", "0.55"))


def _last_assistant_message(history: List[Dict[str, str]]) -> str:
    if len(history) < 2:
        return ""
    for i in range(len(history) - 2, -1, -1):
        if history[i].get("role") == "assistant":
            return history[i].get("content") or ""
    return ""


_DIETARY_HINT_TOKENS = (
    "allerg",
    "vegan",
    "vegetarian",
    "veg ",
    "gluten",
    "kosher",
    "halal",
    "dairy",
    "nut",
    "shellfish",
    "lactose",
    "no restriction",
    "no dietary",
    "no allergies",
    "eat anything",
    "everything",
    "pesc",
    "keto",
    "paleo",
)


def _user_messages_text(history: List[Dict[str, str]]) -> str:
    return " ".join(
        _safe_strip(m.get("content")) for m in history if m.get("role") == "user"
    ).lower()


def _conversation_mentions_dietary(history: List[Dict[str, str]]) -> bool:
    blob = _user_messages_text(history)
    return any(tok in blob for tok in _DIETARY_HINT_TOKENS)


_MENU_QUESTION_RE = re.compile(
    r"\b(menu|dishes|dish|order|specials?|signature|what to (?:eat|get|order)|what'?s good|"
    r"what should i (?:eat|get|order)|recommend (?:a |some )?dishes?|try at|best thing|favorite thing)\b",
    re.IGNORECASE,
)


def _menu_question_intent(msg: str) -> bool:
    """User is asking what to order / menu / dishes at a place."""
    return bool(_safe_strip(msg)) and bool(_MENU_QUESTION_RE.search(msg))


def _resolve_place_for_menu_question(session: ChatSession, msg: str) -> Optional[str]:
    """Match user message to a place_id from last recommendations (name substring)."""
    ids = session.last_place_ids
    names = session.last_place_names
    if not ids:
        return None
    msg_l = msg.lower()
    if len(ids) == len(names):
        best_pid: Optional[str] = None
        best_len = 0
        for pid, name in zip(ids, names):
            n = _safe_strip(name)
            if len(n) < 2:
                continue
            n_low = n.lower()
            # Match full name or first segment (before comma)
            head = n_low.split(",")[0].strip()
            for candidate in (n_low, head):
                if len(candidate) >= 3 and candidate in msg_l and len(candidate) > best_len:
                    best_pid = pid
                    best_len = len(candidate)
        if best_pid:
            return best_pid
    return ids[0]


def fetch_place_menu_insights(place_id: str) -> str:
    """
    Gather Google Places text useful for dish ideas. Full menus are not exposed by
    standard Place Details; we use summary, reviews, and meal-type flags.
    """
    if not place_id or not GOOGLE_PLACES_API_KEY:
        return ""
    fields = [
        "name",
        "formatted_address",
        "editorial_summary",
        "reviews",
        "serves_breakfast",
        "serves_brunch",
        "serves_lunch",
        "serves_dinner",
        "serves_vegetarian_food",
        "serves_beer",
        "serves_wine",
    ]
    try:
        details_resp = requests.get(
            "https://maps.googleapis.com/maps/api/place/details/json",
            params={
                "place_id": place_id,
                "fields": ",".join(fields),
                "key": GOOGLE_PLACES_API_KEY,
            },
            timeout=20,
        )
        details_resp.raise_for_status()
        details_data = details_resp.json().get("result") or {}
    except (requests.RequestException, ValueError, TypeError):
        return ""

    name = _safe_strip(details_data.get("name"))
    addr = _safe_strip(details_data.get("formatted_address"))
    es = details_data.get("editorial_summary") or {}
    overview = ""
    if isinstance(es, dict):
        overview = _safe_strip(es.get("overview"))

    flags: List[str] = []
    for key, label in (
        ("serves_breakfast", "breakfast"),
        ("serves_brunch", "brunch"),
        ("serves_lunch", "lunch"),
        ("serves_dinner", "dinner"),
        ("serves_vegetarian_food", "vegetarian options"),
        ("serves_beer", "beer"),
        ("serves_wine", "wine"),
    ):
        if details_data.get(key):
            flags.append(label)

    review_chunks: List[str] = []
    for r in (details_data.get("reviews") or [])[:5]:
        txt = _safe_strip((r or {}).get("text"))
        if not txt:
            continue
        if len(txt) > 450:
            txt = txt[:449] + "…"
        review_chunks.append(txt)

    parts: List[str] = []
    if name:
        parts.append(f"Place: {name}")
    if addr:
        parts.append(f"Address: {addr}")
    if overview:
        parts.append(f"Google summary: {overview}")
    if flags:
        parts.append("Serves / style flags: " + ", ".join(flags))
    if review_chunks:
        parts.append("Recent review excerpts (may mention dishes): " + " | ".join(review_chunks))
    if not parts:
        return ""
    parts.append(
        "Note: Google Places does not return a full itemized menu here; infer only from the above."
    )
    return "\n".join(parts)


def get_or_create_session(session_id: Optional[str]) -> str:
    if session_id and session_id in SESSIONS:
        return session_id
    new_id = str(uuid.uuid4())
    SESSIONS[new_id] = ChatSession()
    return new_id


def extract_json(text: str) -> Dict[str, Any]:
    block_match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if block_match:
        return json.loads(block_match.group(1))

    direct_match = re.search(r"(\{.*\})", text, re.DOTALL)
    if direct_match:
        return json.loads(direct_match.group(1))

    raise ValueError("No JSON payload returned by AI")


def _safe_strip(val: Any) -> str:
    """Coerce API/JSON values to str; None and missing become ''."""
    if val is None:
        return ""
    return str(val).strip()


def _sanitize_quick_replies(raw: Any) -> List[str]:
    """2–5 short strings for checkbox UI; drop junk from model JSON."""
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    for x in raw:
        s = _safe_strip(x)
        if not s or len(s) > 200:
            continue
        if s not in out:
            out.append(s)
        if len(out) >= 5:
            break
    return out


def _normalize_place_name(name: Any) -> str:
    if name is None:
        return ""
    return re.sub(r"\s+", " ", str(name).lower().strip())


def find_restaurant_match(
    restaurants: List[Dict[str, Any]],
    place_id: Optional[str],
    ai_name: Any,
) -> Dict[str, Any]:
    """Match Perplexity output to a Places row (place_id first, then fuzzy name)."""
    if not restaurants:
        return {}

    by_id = {r.get("place_id"): r for r in restaurants if r.get("place_id")}
    if place_id and place_id in by_id:
        return dict(by_id[place_id])

    ai_name_s = _safe_strip(ai_name)
    if not ai_name_s:
        return {}

    target = _normalize_place_name(ai_name_s)
    for r in restaurants:
        if _normalize_place_name(r.get("name")) == target:
            return dict(r)

    for r in restaurants:
        rn = _normalize_place_name(r.get("name"))
        if not rn:
            continue
        if target in rn or rn in target:
            return dict(r)

    names = [r.get("name") or "" for r in restaurants]
    close = get_close_matches(ai_name_s, [n for n in names if n], n=1, cutoff=0.55)
    if close:
        for r in restaurants:
            if r.get("name") == close[0]:
                return dict(r)
    return {}


def _account_profile_for_ai(uid: Optional[str], session: ChatSession) -> Dict[str, Any]:
    if not uid or not firebase_store.is_configured():
        return {}
    return {
        "merged_preferences_from_account_and_chat": dict(session.preferences),
        "recently_saved_restaurant_names": firebase_store.list_recent_names(uid, FS_SAVED),
        "recently_visited_restaurant_names": firebase_store.list_recent_names(uid, FS_VISITED),
    }


def ask_perplexity_for_next_step(
    session: ChatSession,
    user_message: str,
    menu_context: Optional[str] = None,
    account_profile: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if not PERPLEXITY_API_KEY:
        raise RuntimeError("PERPLEXITY_API_KEY is not set")

    system_prompt = (
        "You are a concise restaurant guide. Follow the stages list in order by stage_index.\n"
        "TOP PRIORITY (do not skip): (0) LOCATION — city/neighborhood/area where they want to eat "
        "(use the UI City/Area field if present, or ask until you have a usable area). "
        "(1) DIETARY RESTRICTIONS — allergies, diets (vegan/halal/kosher/etc.), or explicit none. "
        "Stay on stage 0 until location is clear enough to search; stay on stage 1 until dietary is addressed. "
        "Only after both are covered should you move on to meal context, logistics, time, budget, etc.\n"
        "If the user volunteers location and dietary in one message, advance stage_index past both as appropriate. "
        "Merge facts into preferences_updates.\n"
        "When should_search is true, set search_query to ALWAYS include the city/area from known_location "
        "(e.g. 'Thai food in Hayward, CA'). Never use a locationless query if known_location is set.\n"
        "If account_profile is present in the JSON payload, the user is signed in: use merged_preferences_from_account_and_chat "
        "for allergies, diets, and tastes; consider recently_saved_restaurant_names and recently_visited_restaurant_names "
        "to avoid repeating the same picks unless they ask.\n"
        "If restaurant_menu_context_from_google is non-empty in the payload: the user asked about dishes/menu. "
        "Answer using ONLY that text (summary, review excerpts, meal flags). Suggest plausible dishes or categories "
        "that fit what reviewers and the summary imply—do not invent specific dishes with no support in the text. "
        "If data is thin, say so and suggest they check the menu link or photos. "
        "Standard Google Places does not return a full structured menu; be honest if they ask for the full menu. "
        "You may use 2–4 short sentences and skip a follow-up question if they only asked what to order.\n"
        "Otherwise reply format: at most 2 short sentences, under ~25 words. Exactly ONE question. "
        "Plain text only—no markdown, bullets, or [1][2] citations.\n"
        "quick_replies: 2–4 short phrases that answer your question (omit or use [] if not applicable).\n"
        "Readiness: set readiness_score >= recommendation_threshold and should_search true once you have "
        "a clear location (or area) AND dietary/allergy info (or explicit no restrictions), "
        "so results can appear; keep refining with follow-ups.\n"
        "Return ONLY JSON: reply, stage_index, preferences_updates, readiness_score, should_search, search_query, quick_replies."
    )

    user_turn = sum(1 for m in session.history if m.get("role") == "user")
    style_hint = random.choice(QUESTION_STYLE_HINTS)

    payload_obj: Dict[str, Any] = {
        "known_location": session.location,
        "location_city_field_filled": bool(_safe_strip(session.location)),
        "gps_coords_available": session.user_lat is not None and session.user_lng is not None,
        "dietary_mentioned_in_conversation": _conversation_mentions_dietary(session.history),
        "stage_index": session.stage_index,
        "current_stage_name": STAGES[session.stage_index],
        "stages": STAGES,
        "current_preferences": session.preferences,
        "conversation_history": session.history[-10:],
        "latest_user_message": user_message,
        "user_turn_number": user_turn,
        "last_assistant_reply": _last_assistant_message(session.history),
        "style_hint_for_this_turn": style_hint,
        "recommendation_threshold": RECOMMENDATION_THRESHOLD,
        "restaurant_menu_context_from_google": menu_context or "",
    }
    if account_profile:
        payload_obj["account_profile"] = account_profile

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(payload_obj)},
    ]

    response = requests.post(
        "https://api.perplexity.ai/chat/completions",
        headers={
            "Authorization": f"Bearer {PERPLEXITY_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": "sonar",
            "messages": messages,
            "temperature": QUESTION_TEMPERATURE,
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    content = data["choices"][0]["message"]["content"]

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        parsed = extract_json(content)

    parsed.setdefault("reply", "Tell me a little more about what you're craving.")
    parsed["reply"] = _plain_assistant_reply(parsed.get("reply", "")) or "Tell me a little more about what you're craving."
    parsed.setdefault("stage_index", session.stage_index)
    parsed.setdefault("preferences_updates", {})
    parsed.setdefault("readiness_score", 0)
    parsed.setdefault("should_search", False)
    parsed.setdefault("search_query", "")
    parsed.setdefault("quick_replies", [])
    parsed["quick_replies"] = _sanitize_quick_replies(parsed.get("quick_replies"))
    return parsed


def rank_restaurants_with_perplexity(
    session: ChatSession,
    restaurants: List[Dict[str, Any]],
    account_profile: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    if not PERPLEXITY_API_KEY:
        raise RuntimeError("PERPLEXITY_API_KEY is not set")

    if not restaurants:
        return []

    system_prompt = (
        "You rank restaurants from user preferences and Google Places data. Return ONLY JSON: {\"top_options\": [ ... ]}. "
        "Each option: place_id, name, match_score, why_fit — copied from the provided list only; never invent names.\n"
        "match_score: 0–100 (fit for this user). "
        f"Pick up to {TOP_N_RESTAURANTS} unique place_id values when possible.\n"
        "Prioritize places in or near the user's location string (match formatted_address to the area). "
        "If account_profile is present, apply merged_preferences_from_account_and_chat and favor variety vs recent lists. "
        "Then dietary needs and allergies, then meal context, distance, hours, budget, cuisine.\n"
        "why_fit: ONE short sentence (max ~120 characters). Explain only why it matches THEIR stated wants—"
        "diet, vibe, budget, distance, or timing. Skip generic praise. No bullets or markdown."
    )

    rank_payload: Dict[str, Any] = {
        "location": session.location,
        "stage_index": session.stage_index,
        "preferences": session.preferences,
        "conversation_history": session.history[-10:],
        "restaurants": restaurants,
    }
    if account_profile:
        rank_payload["account_profile"] = account_profile

    response = requests.post(
        "https://api.perplexity.ai/chat/completions",
        headers={
            "Authorization": f"Bearer {PERPLEXITY_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": "sonar",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(rank_payload)},
            ],
            "temperature": 0.35,
        },
        timeout=30,
    )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        parsed = extract_json(content)

    options = parsed.get("top_options", [])
    normalized: List[Dict[str, Any]] = []
    for option in options[:TOP_N_RESTAURANTS]:
        pid = option.get("place_id")
        name = option.get("name")
        base = find_restaurant_match(restaurants, pid if isinstance(pid, str) else None, name)
        if not base:
            continue
        raw_score = option.get("match_score", option.get("roi_score", 0))
        try:
            match_score = max(0, min(100, float(raw_score)))
        except (TypeError, ValueError):
            match_score = 0
        merged = dict(base)
        merged["match_score"] = match_score
        merged["why_fit"] = _clip_why_fit(option.get("why_fit"))
        normalized.append(merged)

    if not normalized and restaurants:
        for r in restaurants[:TOP_N_RESTAURANTS]:
            merged = dict(r)
            merged["match_score"] = float(merged.get("match_score") or merged.get("roi_score") or 50.0)
            merged["why_fit"] = _clip_why_fit(merged.get("why_fit") or "Close match for your area and search.")
            normalized.append(merged)
    return normalized


def _haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in miles."""
    r_miles = 3959.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    c = 2 * math.asin(min(1.0, math.sqrt(a)))
    return r_miles * c


def _approx_drive_minutes(miles: float) -> int:
    """Rough urban driving time from straight-line distance."""
    return max(1, round(miles * 2.3))


def enrich_travel_times(
    restaurants: List[Dict[str, Any]],
    user_lat: Optional[float],
    user_lng: Optional[float],
) -> None:
    """Add travel_duration_text / travel_distance_text using Distance Matrix, or haversine fallback."""
    for r in restaurants:
        r.setdefault("travel_duration_text", None)
        r.setdefault("travel_distance_text", None)

    if user_lat is None or user_lng is None:
        return

    indexed_coords: List[tuple] = []
    for i, r in enumerate(restaurants):
        lat, lng = r.get("lat"), r.get("lng")
        if lat is not None and lng is not None:
            try:
                indexed_coords.append((i, float(lat), float(lng)))
            except (TypeError, ValueError):
                continue

    if not indexed_coords:
        return

    dest_str = "|".join(f"{lat},{lng}" for _, lat, lng in indexed_coords)
    dm_url = "https://maps.googleapis.com/maps/api/distancematrix/json"
    try:
        dm_resp = requests.get(
            dm_url,
            params={
                "origins": f"{user_lat},{user_lng}",
                "destinations": dest_str,
                "mode": "driving",
                "units": "imperial",
                "key": GOOGLE_PLACES_API_KEY,
            },
            timeout=30,
        )
        dm_resp.raise_for_status()
        dm_data = dm_resp.json()
        if dm_data.get("status") != "OK":
            raise ValueError(dm_data.get("error_message", "Distance Matrix not OK"))
        row = dm_data.get("rows", [{}])[0]
        elements = row.get("elements", [])
        for j, (idx, rlat, rlng) in enumerate(indexed_coords):
            r = restaurants[idx]
            if j < len(elements):
                el = elements[j]
                if el.get("status") == "OK":
                    dur = el.get("duration") or {}
                    dist = el.get("distance") or {}
                    r["travel_duration_text"] = dur.get("text")
                    r["travel_distance_text"] = dist.get("text")
                    if r.get("travel_duration_text"):
                        continue
            miles = _haversine_miles(user_lat, user_lng, rlat, rlng)
            mins = _approx_drive_minutes(miles)
            r["travel_duration_text"] = f"~{mins} min drive"
            r["travel_distance_text"] = f"~{miles:.1f} mi (approx.)"
    except (requests.RequestException, ValueError, KeyError):
        for idx, rlat, rlng in indexed_coords:
            r = restaurants[idx]
            miles = _haversine_miles(user_lat, user_lng, rlat, rlng)
            mins = _approx_drive_minutes(miles)
            r["travel_duration_text"] = f"~{mins} min drive"
            r["travel_distance_text"] = f"~{miles:.1f} mi (approx.)"


def search_restaurants(
    search_query: Any,
    location: Optional[str],
    user_lat: Optional[float],
    user_lng: Optional[float],
) -> List[Dict[str, Any]]:
    if not GOOGLE_PLACES_API_KEY:
        raise RuntimeError("GOOGLE_PLACES_API_KEY is not set")

    location_part = _safe_strip(location)
    sq = _safe_strip(search_query)

    # Keep results in the user's area: fold City/Area into the keyword/query when missing.
    if sq and location_part:
        lp = location_part.lower()
        if lp not in sq.lower():
            sq = f"{sq} in {location_part}"
    elif not sq and location_part:
        sq = f"restaurants in {location_part}"

    # Map center for search: prefer geocoded City/Area over GPS so the typed destination wins over "where I am now".
    search_lat: Optional[float] = None
    search_lng: Optional[float] = None
    if location_part:
        geo_center = _geocode_address_to_latlng(location_part)
        if geo_center:
            search_lat, search_lng = geo_center

    if search_lat is None or search_lng is None:
        search_lat, search_lng = user_lat, user_lng

    origin_lat, origin_lng = search_lat, search_lng

    results: List[Dict[str, Any]] = []
    if origin_lat is not None and origin_lng is not None:
        nearby_url = "https://maps.googleapis.com/maps/api/place/nearbysearch/json"
        keyword = sq or "restaurant"
        nearby_resp = requests.get(
            nearby_url,
            params={
                "location": f"{origin_lat},{origin_lng}",
                "radius": 8000,
                "type": "restaurant",
                "keyword": keyword,
                "key": GOOGLE_PLACES_API_KEY,
            },
            timeout=30,
        )
        nearby_resp.raise_for_status()
        nearby_data = nearby_resp.json()
        results = nearby_data.get("results", [])[:CANDIDATE_PLACES]
    else:
        query = sq or "restaurants"
        if location_part and location_part.lower() not in query.lower():
            query = f"{query} {location_part}"
        if "restaurant" not in query.lower():
            query = f"{query} restaurants"

        text_search_url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
        text_params: Dict[str, Any] = {
            "query": query,
            "key": GOOGLE_PLACES_API_KEY,
        }
        if origin_lat is not None and origin_lng is not None:
            text_params["location"] = f"{origin_lat},{origin_lng}"
            text_params["radius"] = 12000

        text_resp = requests.get(
            text_search_url,
            params=text_params,
            timeout=30,
        )
        text_resp.raise_for_status()
        text_data = text_resp.json()
        results = text_data.get("results", [])[:CANDIDATE_PLACES]

    restaurants: List[Dict[str, Any]] = []
    details_url = "https://maps.googleapis.com/maps/api/place/details/json"
    for place in results:
        place_id = place.get("place_id")
        if not place_id:
            continue

        details_resp = requests.get(
            details_url,
            params={
                "place_id": place_id,
                "fields": ",".join(
                    [
                        "name",
                        "place_id",
                        "rating",
                        "price_level",
                        "formatted_address",
                        "opening_hours",
                        "formatted_phone_number",
                        "website",
                        "url",
                        "user_ratings_total",
                        "photos",
                        "geometry",
                    ]
                ),
                "key": GOOGLE_PLACES_API_KEY,
            },
            timeout=30,
        )
        details_resp.raise_for_status()
        details_data = details_resp.json().get("result", {})
        photos = details_data.get("photos") or []
        photo_refs = []
        for p in photos[:MAX_PHOTOS_PER_PLACE]:
            ref = p.get("photo_reference")
            if ref:
                photo_refs.append(ref)
        photo_ref = photo_refs[0] if photo_refs else None
        loc = details_data.get("geometry", {}).get("location") or {}
        lat = loc.get("lat")
        lng = loc.get("lng")
        hours_text = _hours_text_from_place_details(details_data)
        pl = details_data.get("price_level")

        restaurants.append(
            {
                "place_id": place_id,
                "name": details_data.get("name", place.get("name", "Unknown")),
                "rating": details_data.get("rating", place.get("rating")),
                "user_ratings_total": details_data.get("user_ratings_total"),
                "price_level": pl,
                "price_display": _price_level_dollars(pl),
                "address": details_data.get("formatted_address", place.get("vicinity")),
                "open_now": details_data.get("opening_hours", {}).get("open_now"),
                "hours_text": hours_text,
                "phone": details_data.get("formatted_phone_number"),
                "website": details_data.get("website"),
                "maps_url": details_data.get("url"),
                "photo_reference": photo_ref,
                "photo_references": photo_refs,
                "lat": lat,
                "lng": lng,
            }
        )

    # Drive times: use device GPS when available (from you), else the same center used for search.
    travel_lat = user_lat if user_lat is not None else origin_lat
    travel_lng = user_lng if user_lng is not None else origin_lng
    enrich_travel_times(restaurants, travel_lat, travel_lng)
    return restaurants


@app.get("/api/place-photo")
def place_photo():
    """Proxy Place Photos so the browser does not need the API key."""
    ref = request.args.get("ref")
    if not ref or not GOOGLE_PLACES_API_KEY:
        abort(400)
    photo_url = "https://maps.googleapis.com/maps/api/place/photo"
    try:
        img_resp = requests.get(
            photo_url,
            params={
                "maxwidth": 800,
                "photo_reference": ref,
                "key": GOOGLE_PLACES_API_KEY,
            },
            allow_redirects=True,
            timeout=30,
        )
        img_resp.raise_for_status()
    except requests.RequestException:
        abort(502)
    ctype = img_resp.headers.get("Content-Type", "image/jpeg")
    return Response(img_resp.content, mimetype=ctype)


def _city_state_from_geocode(result: Dict[str, Any]) -> str:
    """Build 'City, ST' from Geocoding address_components."""
    comps = result.get("address_components") or []
    locality = None
    admin1 = None
    sublocality = None
    for c in comps:
        types = c.get("types") or []
        if "locality" in types:
            locality = c.get("long_name")
        elif "administrative_area_level_1" in types:
            admin1 = c.get("short_name")
        elif "sublocality" in types or "sublocality_level_1" in types:
            sublocality = c.get("long_name")
        elif "neighborhood" in types and not sublocality:
            sublocality = c.get("long_name")

    city = locality or sublocality
    if city and admin1:
        return f"{city}, {admin1}"
    if city:
        return city
    formatted = (result.get("formatted_address") or "").strip()
    if formatted:
        parts = [p.strip() for p in formatted.split(",")]
        if len(parts) >= 3:
            return f"{parts[-3]}, {parts[-2]}"
        if len(parts) == 2:
            return ", ".join(parts)
        return parts[0]
    return ""


@app.get("/api/place-autocomplete")
def place_autocomplete():
    """Google Places Autocomplete for city/area (API key stays on server)."""
    if not GOOGLE_PLACES_API_KEY:
        return jsonify({"error": "Places not configured"}), 500
    q = _safe_strip(request.args.get("q"))
    if len(q) < 2:
        return jsonify({"predictions": []})

    try:
        ac_resp = requests.get(
            "https://maps.googleapis.com/maps/api/place/autocomplete/json",
            params={
                "input": q,
                "types": "(cities)",
                "key": GOOGLE_PLACES_API_KEY,
            },
            timeout=10,
        )
        ac_resp.raise_for_status()
        data = ac_resp.json()
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502

    status = data.get("status")
    if status not in ("OK", "ZERO_RESULTS"):
        return jsonify({"error": data.get("error_message", status)}), 502

    preds: List[Dict[str, Any]] = []
    for p in (data.get("predictions") or [])[:12]:
        preds.append(
            {
                "description": p.get("description"),
                "place_id": p.get("place_id"),
            }
        )
    return jsonify({"predictions": preds})


@app.get("/api/reverse-geocode")
def reverse_geocode():
    """Turn lat/lng into a city/area label for the location field (Geocoding API)."""
    if not GOOGLE_PLACES_API_KEY:
        return jsonify({"error": "Geocoding not configured"}), 500
    try:
        lat = float(request.args.get("lat", ""))
        lng = float(request.args.get("lng", ""))
    except (TypeError, ValueError):
        return jsonify({"error": "lat and lng required"}), 400

    geo_url = "https://maps.googleapis.com/maps/api/geocode/json"
    try:
        geo_resp = requests.get(
            geo_url,
            params={
                "latlng": f"{lat},{lng}",
                "key": GOOGLE_PLACES_API_KEY,
            },
            timeout=15,
        )
        geo_resp.raise_for_status()
        data = geo_resp.json()
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502

    if data.get("status") not in ("OK", "ZERO_RESULTS"):
        return jsonify({"error": data.get("error_message", data.get("status", "error"))}), 502

    results = data.get("results") or []
    if not results:
        return jsonify({"label": "", "formatted_address": ""})

    first = results[0]
    label = _city_state_from_geocode(first)
    return jsonify(
        {
            "label": label,
            "formatted_address": first.get("formatted_address", ""),
        }
    )


def _optional_uid_from_request() -> Optional[str]:
    auth = request.headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return None
    return firebase_store.verify_id_token(auth[7:].strip())


def _restaurant_record_from_body(body: Any) -> Dict[str, Any]:
    if not isinstance(body, dict):
        return {}
    return {
        "placeId": _safe_strip(body.get("place_id")),
        "name": _safe_strip(body.get("name")),
        "address": _safe_strip(body.get("address")),
        "summary": _safe_strip(body.get("summary") or body.get("why_fit")),
        "rating": body.get("rating"),
        "priceDisplay": _safe_strip(body.get("price_display")),
        "mapsUrl": _safe_strip(body.get("maps_url")),
        "matchScore": body.get("match_score"),
    }


@app.get("/api/config")
def api_config():
    """Public Firebase web config + feature flags for the browser."""
    return jsonify(
        {
            "firebase": {
                "apiKey": os.getenv("FIREBASE_WEB_API_KEY", ""),
                "authDomain": os.getenv("FIREBASE_AUTH_DOMAIN", ""),
                "projectId": os.getenv("FIREBASE_PROJECT_ID", ""),
                "appId": os.getenv("FIREBASE_APP_ID", ""),
                "messagingSenderId": os.getenv("FIREBASE_MESSAGING_SENDER_ID", ""),
            },
            "firestore_enabled": firebase_store.is_configured(),
        }
    )


@app.get("/api/user/preferences")
def api_get_preferences():
    uid = _optional_uid_from_request()
    if not uid:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"preferences": firebase_store.get_user_preferences(uid)})


@app.put("/api/user/preferences")
def api_put_preferences():
    uid = _optional_uid_from_request()
    if not uid:
        return jsonify({"error": "Unauthorized"}), 401
    body = request.get_json(force=True)
    prefs = body.get("preferences")
    if not isinstance(prefs, dict):
        return jsonify({"error": "preferences object required"}), 400
    firebase_store.merge_and_save_preferences(uid, prefs)
    return jsonify({"ok": True, "preferences": firebase_store.get_user_preferences(uid)})


@app.get("/api/restaurants/saved")
def api_list_saved():
    uid = _optional_uid_from_request()
    if not uid:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"items": firebase_store.list_restaurant_records(uid, FS_SAVED)})


@app.get("/api/restaurants/visited")
def api_list_visited():
    uid = _optional_uid_from_request()
    if not uid:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"items": firebase_store.list_restaurant_records(uid, FS_VISITED)})


@app.post("/api/restaurants/save")
def api_save_restaurant():
    uid = _optional_uid_from_request()
    if not uid:
        return jsonify({"error": "Unauthorized"}), 401
    body = request.get_json(force=True)
    rec = _restaurant_record_from_body(body)
    if not rec.get("name"):
        return jsonify({"error": "name required"}), 400
    doc_id = firebase_store.save_restaurant_record(uid, FS_SAVED, rec)
    return jsonify({"ok": True, "id": doc_id})


@app.post("/api/restaurants/visit")
def api_visit_restaurant():
    uid = _optional_uid_from_request()
    if not uid:
        return jsonify({"error": "Unauthorized"}), 401
    body = request.get_json(force=True)
    rec = _restaurant_record_from_body(body)
    if not rec.get("name"):
        return jsonify({"error": "name required"}), 400
    doc_id = firebase_store.save_restaurant_record(uid, FS_VISITED, rec)
    return jsonify({"ok": True, "id": doc_id})


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/chat")
def chat():
    payload = request.get_json(force=True)
    user_message = (payload.get("message") or "").strip()
    session_id = payload.get("session_id")
    location = (payload.get("location") or "").strip()
    user_lat = payload.get("user_lat")
    user_lng = payload.get("user_lng")
    client_timezone = _safe_strip(payload.get("client_timezone"))

    if not user_message:
        return jsonify({"error": "message is required"}), 400

    session_id = get_or_create_session(session_id)
    session = SESSIONS[session_id]

    old_loc = session.location
    old_ulat, old_ulng = session.user_lat, session.user_lng

    if location:
        session.location = location
    try:
        if user_lat is not None:
            session.user_lat = float(user_lat)
        if user_lng is not None:
            session.user_lng = float(user_lng)
    except (TypeError, ValueError):
        pass

    if old_loc != session.location:
        session.timezone_id = None
        session.location_geocode_lat = None
        session.location_geocode_lng = None
        session.location_geocode_for = None
        session.last_place_ids = []
        session.last_place_names = []
    if old_ulat != session.user_lat or old_ulng != session.user_lng:
        session.timezone_id = None

    uid = _optional_uid_from_request()
    if uid:
        cloud = firebase_store.get_user_preferences(uid)
        session.preferences = {**cloud, **session.preferences}

    session.history.append({"role": "user", "content": user_message})

    try:
        menu_context: Optional[str] = None
        if _menu_question_intent(user_message) and session.last_place_ids:
            pid = _resolve_place_for_menu_question(session, user_message)
            if pid:
                menu_context = fetch_place_menu_insights(pid)
        ap = _account_profile_for_ai(uid, session) if uid else None
        ai_step = ask_perplexity_for_next_step(
            session, user_message, menu_context=menu_context, account_profile=ap or None
        )
        prefs_up = ai_step.get("preferences_updates")
        if isinstance(prefs_up, dict):
            session.preferences.update(prefs_up)
        if uid and isinstance(prefs_up, dict) and prefs_up:
            firebase_store.merge_and_save_preferences(uid, prefs_up)

        stage_index = ai_step.get("stage_index", session.stage_index)
        try:
            stage_index = int(stage_index)
        except (TypeError, ValueError):
            stage_index = session.stage_index
        session.stage_index = max(0, min(len(STAGES) - 1, stage_index))

        readiness_score = ai_step.get("readiness_score", session.readiness_score)
        try:
            readiness_score = int(readiness_score)
        except (TypeError, ValueError):
            readiness_score = session.readiness_score
        session.readiness_score = max(0, min(100, readiness_score))

        should_search = bool(ai_step.get("should_search", False))
        reply = _plain_assistant_reply(ai_step.get("reply")) or "Tell me a little more."

        _ensure_session_timezone(session)
        tz_for_display = session.timezone_id or client_timezone or "UTC"

        response_payload: Dict[str, Any] = {
            "session_id": session_id,
            "reply": reply,
            "local_time_display": _format_local_time(tz_for_display),
            "action": "ask_followup",
            "restaurants": [],
            "top_options": [],
            "preferences": session.preferences,
            "stage_index": session.stage_index,
            "stage_name": STAGES[session.stage_index],
            "readiness_score": session.readiness_score,
            "recommendation_threshold": RECOMMENDATION_THRESHOLD,
            "quick_replies": _sanitize_quick_replies(ai_step.get("quick_replies")),
            "questions_hint": "",
        }

        hit_threshold = session.readiness_score >= RECOMMENDATION_THRESHOLD
        if hit_threshold:
            session.recommendations_started = True

        run_recommendations = should_search or session.recommendations_started
        if run_recommendations:
            restaurants = search_restaurants(
                ai_step.get("search_query"),
                session.location,
                session.user_lat,
                session.user_lng,
            )
            response_payload["restaurants"] = restaurants
            rank_profile = _account_profile_for_ai(uid, session) if uid else None
            response_payload["top_options"] = rank_restaurants_with_perplexity(
                session, restaurants, rank_profile
            )
            response_payload["action"] = "recommendations_updated"
            tops = response_payload.get("top_options") or []
            session.last_place_ids = [t.get("place_id") for t in tops if t.get("place_id")]
            session.last_place_names = [t.get("name") for t in tops if t.get("name")]

        results_in_response = bool(response_payload.get("top_options")) or bool(
            response_payload.get("restaurants")
        )
        response_payload["questions_hint"] = _questions_until_results_hint(
            RECOMMENDATION_THRESHOLD,
            session.readiness_score,
            session.recommendations_started,
            results_in_response,
        )

        session.history.append({"role": "assistant", "content": reply})
        return jsonify(response_payload)
    except requests.RequestException as exc:
        return jsonify({"error": f"External API request failed: {exc}"}), 502
    except Exception as exc:  # pylint: disable=broad-except
        return jsonify({"error": str(exc)}), 500


@app.get("/health")
def health():
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)
