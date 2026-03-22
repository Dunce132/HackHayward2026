"""
Google Firebase Admin: Firestore for user preferences, saved & visited restaurants.
Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_CREDENTIALS_JSON (path or inline JSON).
"""
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

_firebase_ready = False
_db = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_firebase() -> bool:
    """Initialize Firebase Admin once. Returns True if Firestore is available."""
    global _firebase_ready, _db  # pylint: disable=global-statement
    if _firebase_ready and _db is not None:
        return True
    try:
        import firebase_admin  # pylint: disable=import-outside-toplevel
        from firebase_admin import credentials, firestore  # pylint: disable=import-outside-toplevel
    except ImportError:
        return False

    if firebase_admin._apps:
        _db = firestore.client()
        _firebase_ready = True
        return True

    cred = None
    raw = (os.getenv("FIREBASE_CREDENTIALS_JSON") or "").strip()
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")
    path = (
        os.getenv("FIREBASE_CREDENTIALS_PATH", "").strip()
        or os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    )

    try:
        if raw.startswith("{"):
            cred = credentials.Certificate(json.loads(raw))
        elif path and os.path.isfile(path):
            cred = credentials.Certificate(path)
        else:
            return False
        firebase_admin.initialize_app(cred)
        _db = firestore.client()
        _firebase_ready = True
        return True
    except (ValueError, OSError, TypeError, json.JSONDecodeError) as exc:
        if raw or path:
            print(
                "firebase_store.init_firebase: failed (check FIREBASE_CREDENTIALS_JSON / path):",
                type(exc).__name__,
                str(exc)[:200],
                file=sys.stderr,
            )
        return False


def is_configured() -> bool:
    return init_firebase()


def verify_id_token(id_token: str) -> Optional[str]:
    """Return Firebase uid if token is valid."""
    if not id_token or not init_firebase():
        return None
    try:
        from firebase_admin import auth  # pylint: disable=import-outside-toplevel

        decoded = auth.verify_id_token(id_token)
        return decoded.get("uid")
    except Exception:  # pylint: disable=broad-except
        return None


def _user_doc_ref(uid: str):
    return _db.collection("users").document(uid)


def get_user_preferences(uid: str) -> Dict[str, Any]:
    if not init_firebase():
        return {}
    snap = _user_doc_ref(uid).get()
    if not snap.exists:
        return {}
    data = snap.to_dict() or {}
    return data.get("preferences") or {}


def merge_and_save_preferences(uid: str, updates: Dict[str, Any]) -> None:
    if not init_firebase() or not updates:
        return
    ref = _user_doc_ref(uid)
    snap = ref.get()
    current = (snap.to_dict() or {}).get("preferences") or {}
    merged = {**current, **updates}
    ref.set(
        {
            "preferences": merged,
            "updatedAt": _utc_now_iso(),
        },
        merge=True,
    )


def set_user_profile(uid: str, email: Optional[str], display_name: Optional[str]) -> None:
    if not init_firebase():
        return
    _user_doc_ref(uid).set(
        {
            "email": email or "",
            "displayName": display_name or "",
            "updatedAt": _utc_now_iso(),
        },
        merge=True,
    )


def list_recent_names(uid: str, subcollection: str, limit: int = 8) -> List[str]:
    """Recent saved or visited restaurant names for AI context."""
    if not init_firebase():
        return []
    try:
        from firebase_admin import firestore as fs  # pylint: disable=import-outside-toplevel

        col = _user_doc_ref(uid).collection(subcollection)
        q = col.order_by("recordedAt", direction=fs.Query.DESCENDING).limit(limit)
        names: List[str] = []
        for doc in q.stream():
            d = doc.to_dict() or {}
            n = d.get("name")
            if n and isinstance(n, str):
                names.append(n)
        return names
    except Exception:  # pylint: disable=broad-except
        return []


def save_restaurant_record(
    uid: str,
    subcollection: str,
    payload: Dict[str, Any],
) -> str:
    if not init_firebase():
        return ""
    doc_ref = _user_doc_ref(uid).collection(subcollection).document()
    doc_ref.set(
        {
            **payload,
            "recordedAt": _utc_now_iso(),
        }
    )
    return doc_ref.id


def list_restaurant_records(uid: str, subcollection: str, limit: int = 50) -> List[Dict[str, Any]]:
    if not init_firebase():
        return []
    try:
        from firebase_admin import firestore as fs  # pylint: disable=import-outside-toplevel

        col = _user_doc_ref(uid).collection(subcollection)
        q = col.order_by("recordedAt", direction=fs.Query.DESCENDING).limit(limit)
        out: List[Dict[str, Any]] = []
        for doc in q.stream():
            d = doc.to_dict() or {}
            d["id"] = doc.id
            out.append(d)
        return out
    except Exception:  # pylint: disable=broad-except
        return []
