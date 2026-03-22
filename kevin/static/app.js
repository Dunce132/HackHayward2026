const chatEl = document.getElementById("chat");
const formEl = document.getElementById("chat-form");
const messageEl = document.getElementById("message");
const locationEl = document.getElementById("location");
const locationAutocompleteEl = document.getElementById("location-autocomplete");
const restaurantsEl = document.getElementById("restaurants");
const localTimeEl = document.getElementById("local-time");
const resetChatEl = document.getElementById("reset-chat");
const carouselEmptyEl = document.getElementById("carousel-empty");
const carouselUiEl = document.getElementById("carousel-ui");
const carouselViewportEl = document.getElementById("carousel-viewport");
const carouselDotsEl = document.getElementById("carousel-dots");
const carouselPrevEl = document.querySelector(".carousel-prev");
const carouselNextEl = document.querySelector(".carousel-next");
const quickRepliesSectionEl = document.getElementById("quick-replies-section");
const quickRepliesListEl = document.getElementById("quick-replies-list");
const quickRepliesClearEl = document.getElementById("quick-replies-clear");
const signInGoogleEl = document.getElementById("sign-in-google");
const signOutEl = document.getElementById("sign-out");
const authUserLabelEl = document.getElementById("auth-user-label");
const listSavedEl = document.getElementById("list-saved");
const listVisitedEl = document.getElementById("list-visited");
const listSavedEmptyEl = document.getElementById("list-saved-empty");
const listVisitedEmptyEl = document.getElementById("list-visited-empty");
const panelSavedEl = document.getElementById("panel-saved");
const panelVisitedEl = document.getElementById("panel-visited");
const tabSavedEl = document.getElementById("tab-saved");
const tabVisitedEl = document.getElementById("tab-visited");
const locationRangeEl = document.getElementById("location-range");
const btnSaveLocationEl = document.getElementById("btn-save-location");
const btnProfileEl = document.getElementById("btn-profile");
const profileModalEl = document.getElementById("profile-modal");
const btnSavePreferencesEl = document.getElementById("btn-save-preferences");
const btnCloseProfileEl = document.getElementById("btn-close-profile");
const btnMicEl = document.getElementById("btn-mic");
const btnCreateSessionEl = document.getElementById("btn-create-session");
const btnJoinSessionEl = document.getElementById("btn-join-session");
const sessionCodeInputEl = document.getElementById("session-code-input");
const liveSessionCodeEl = document.getElementById("live-session-code");
const btnLeaveSessionEl = document.getElementById("btn-leave-session");

let sessionId = null;
let liveSessionCode = null;
let liveSessionPollTimer = null;
let liveSessionLastHistoryLength = 0;
let firebaseAuth = null;
/** True when server has Firebase Admin + Firestore (can verify tokens and save). */
let serverFirestoreEnabled = false;
let userCoords = null;
/** After user picks a restaurant, chat input is disabled until Reset. */
let chatEnded = false;
let lastRestaurantList = [];
let lastVotesWithDetails = [];
let selectedPlaceId = null;

function getClientTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

function updateLocalTimeDisplay(text) {
  if (!localTimeEl) return;
  localTimeEl.textContent = text ? `Local time: ${text}` : "";
}

async function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (firebaseAuth && firebaseAuth.currentUser) {
    const token = await firebaseAuth.currentUser.getIdToken();
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

/**
 * Parse JSON from a fetch Response. Clear error when server returns HTML (404/502/error pages).
 */
async function readJsonFromResponse(res) {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`Empty response from server (HTTP ${res.status}).`);
  }
  if (trimmed.startsWith("<") || trimmed.startsWith("<!")) {
    const st = res.status;
    let msg = "The app expected JSON but the server returned a web page. ";
    if (st === 404) {
      msg +=
        "404 — API not found. Open the app via your Cloud Run HTTPS URL (not file://). If you use a static host, the Flask API is not there.";
    } else if (st >= 500) {
      msg += `Server error ${st} — check Cloud Run logs for crashes.`;
    } else if (st === 502 || st === 503) {
      msg += `${st} — service busy or cold starting; retry in a few seconds.`;
    } else {
      msg += `HTTP ${st}.`;
    }
    throw new Error(msg);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Invalid JSON (HTTP ${res.status}): ${trimmed.slice(0, 80)}…`);
  }
}

function formatRecordDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

async function refreshSidebarLists() {
  if (!firebaseAuth || !firebaseAuth.currentUser) {
    if (listSavedEl) listSavedEl.innerHTML = "";
    if (listVisitedEl) listVisitedEl.innerHTML = "";
    if (listSavedEmptyEl) listSavedEmptyEl.classList.remove("hidden");
    if (listVisitedEmptyEl) listVisitedEmptyEl.classList.remove("hidden");
    return;
  }
  try {
    const [rs, rv] = await Promise.all([
      fetch("/api/restaurants/saved", { headers: await authHeaders() }),
      fetch("/api/restaurants/visited", { headers: await authHeaders() }),
    ]);
    const savedData = rs.ok ? await rs.json() : { items: [] };
    const visitedData = rv.ok ? await rv.json() : { items: [] };
    const saved = savedData.items || [];
    const visited = visitedData.items || [];

    if (listSavedEl) {
      listSavedEl.innerHTML = "";
      saved.forEach((item) => {
        const li = document.createElement("li");
        li.className = "history-item";
        const content = document.createElement("div");
        content.className = "history-item-content";
        const title = document.createElement("span");
        title.className = "history-item-title";
        title.textContent = item.name || "Restaurant";
        content.appendChild(title);
        if (item.summary) {
          const sm = document.createElement("span");
          sm.className = "history-item-meta";
          sm.textContent = item.summary.length > 80 ? `${item.summary.slice(0, 80)}…` : item.summary;
          content.appendChild(sm);
        }
        if (item.recordedAt) {
          const dt = document.createElement("span");
          dt.className = "history-item-date";
          dt.textContent = formatRecordDate(item.recordedAt);
          content.appendChild(dt);
        }
        li.appendChild(content);
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "history-item-remove";
        delBtn.setAttribute("aria-label", `Remove ${item.name || "restaurant"}`);
        delBtn.textContent = "×";
        delBtn.addEventListener("click", () => deleteSavedRestaurant(item.id));
        li.appendChild(delBtn);
        listSavedEl.appendChild(li);
      });
    }
    if (listVisitedEl) {
      listVisitedEl.innerHTML = "";
      visited.forEach((item) => {
        const li = document.createElement("li");
        li.className = "history-item";
        const content = document.createElement("div");
        content.className = "history-item-content";
        const title = document.createElement("span");
        title.className = "history-item-title";
        title.textContent = item.name || "Restaurant";
        content.appendChild(title);
        if (item.recordedAt) {
          const dt = document.createElement("span");
          dt.className = "history-item-date";
          dt.textContent = formatRecordDate(item.recordedAt);
          content.appendChild(dt);
        }
        li.appendChild(content);
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "history-item-remove";
        delBtn.setAttribute("aria-label", `Remove ${item.name || "restaurant"}`);
        delBtn.textContent = "×";
        delBtn.addEventListener("click", () => deleteVisitedRestaurant(item.id));
        li.appendChild(delBtn);
        listVisitedEl.appendChild(li);
      });
    }
    if (listSavedEmptyEl) listSavedEmptyEl.classList.toggle("hidden", saved.length > 0);
    if (listVisitedEmptyEl) listVisitedEmptyEl.classList.toggle("hidden", visited.length > 0);
  } catch {
    /* ignore */
  }
}

function updateAuthUI(user) {
  if (!signInGoogleEl || !signOutEl || !authUserLabelEl) return;
  if (user) {
    signInGoogleEl.classList.add("hidden");
    signOutEl.classList.remove("hidden");
    authUserLabelEl.textContent = user.displayName || user.email || "Signed in";
    if (btnProfileEl) btnProfileEl.classList.remove("hidden");
    loadSavedLocation();
  } else {
    signInGoogleEl.classList.remove("hidden");
    signOutEl.classList.add("hidden");
    authUserLabelEl.textContent = "";
    if (btnProfileEl) btnProfileEl.classList.add("hidden");
  }
}

function firebaseConfigReady(fb) {
  return Boolean(
    fb &&
      fb.apiKey &&
      fb.authDomain &&
      fb.projectId
  );
}

function updateBackendSyncHint() {
  const hint = document.getElementById("auth-hint");
  if (!hint) return;
  const base =
    "Sign in to save preferences, bookmark restaurants, and get smarter suggestions next time.";
  if (firebaseAuth && firebaseAuth.currentUser && !serverFirestoreEnabled) {
    hint.textContent =
      "Signed in, but the server can’t reach Firestore (missing service account on Cloud Run / server). Saves and synced memory won’t work until GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_CREDENTIALS_JSON is set.";
    hint.style.color = "#b45309";
    return;
  }
  hint.textContent = base;
  hint.style.color = "";
}

async function initFirebaseClient() {
  try {
    const res = await fetch("/api/config");
    const cfg = await readJsonFromResponse(res);
    serverFirestoreEnabled = Boolean(cfg.firestore_enabled);
    const fb = cfg.firebase;
    if (!firebaseConfigReady(fb)) {
      if (signInGoogleEl) signInGoogleEl.disabled = true;
      updateBackendSyncHint();
      return;
    }
    firebase.initializeApp(fb);
    firebaseAuth = firebase.auth();
    // Complete Google sign-in if we returned from signInWithRedirect
    try {
      await firebaseAuth.getRedirectResult();
    } catch {
      /* ignore */
    }
    firebaseAuth.onAuthStateChanged((user) => {
      updateAuthUI(user);
      updateBackendSyncHint();
      refreshSidebarLists();
    });
    updateBackendSyncHint();
  } catch {
    if (signInGoogleEl) signInGoogleEl.disabled = true;
  }
}

function restaurantPayload(r) {
  return {
    place_id: r.place_id,
    name: r.name,
    address: r.address,
    summary: r.why_fit,
    rating: r.rating,
    price_display: r.price_display,
    maps_url: r.maps_url,
    match_score: r.match_score,
  };
}

async function saveRestaurantForLater(r) {
  if (!firebaseAuth || !firebaseAuth.currentUser) {
    addBubble("Sign in with Google (left) to save restaurants to your account.", "assistant");
    return;
  }
  if (!serverFirestoreEnabled) {
    addBubble(
      "Can’t save: the server isn’t connected to Firestore. Set Firebase Admin credentials (GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_CREDENTIALS_JSON) on the machine or Cloud Run service.",
      "assistant"
    );
    return;
  }
  try {
    const res = await fetch("/api/restaurants/save", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(restaurantPayload(r)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) {
        addBubble(
          "Couldn’t save — the server rejected your sign-in token. Try signing out and back in, or confirm the service account matches your Firebase project.",
          "assistant"
        );
      } else {
        addBubble(data.error || "Could not save.", "assistant");
      }
      return;
    }
    addBubble(`Saved “${r.name || "this place"}” to your list.`, "assistant");
    refreshSidebarLists();
  } catch (e) {
    addBubble(`Save failed: ${e.message}`, "assistant");
  }
}

async function recordVisitToCloud(r) {
  if (!firebaseAuth || !firebaseAuth.currentUser) return;
  if (!serverFirestoreEnabled) {
    addBubble(
      "Your choice wasn’t recorded in the cloud — Firestore isn’t configured on the server (service account missing).",
      "assistant"
    );
    return;
  }
  try {
    const res = await fetch("/api/restaurants/visit", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(restaurantPayload(r)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) {
        addBubble("Couldn’t record your visit (sign-in not accepted by server). Try signing out and back in.", "assistant");
      } else {
        addBubble(data.error || "Could not record visit.", "assistant");
      }
      return;
    }
    refreshSidebarLists();
  } catch (e) {
    addBubble(`Visit save failed: ${e.message}`, "assistant");
  }
}

async function deleteSavedRestaurant(docId) {
  if (!firebaseAuth?.currentUser || !docId) return;
  try {
    const res = await fetch(`/api/restaurants/saved/${encodeURIComponent(docId)}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
    if (res.ok) refreshSidebarLists();
    else addBubble("Could not remove.", "assistant");
  } catch (e) {
    addBubble(`Remove failed: ${e.message}`, "assistant");
  }
}

async function deleteVisitedRestaurant(docId) {
  if (!firebaseAuth?.currentUser || !docId) return;
  try {
    const res = await fetch(`/api/restaurants/visited/${encodeURIComponent(docId)}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
    if (res.ok) refreshSidebarLists();
    else addBubble("Could not remove.", "assistant");
  } catch (e) {
    addBubble(`Remove failed: ${e.message}`, "assistant");
  }
}

async function saveLocationToProfile() {
  if (!firebaseAuth?.currentUser) {
    addBubble("Sign in to save your location.", "assistant");
    return;
  }
  try {
    const res = await fetch("/api/user/location", {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({
        location: locationEl.value.trim(),
        lat: userCoords?.lat ?? null,
        lng: userCoords?.lng ?? null,
      }),
    });
    if (res.ok) addBubble("Location saved to your profile.", "assistant");
    else addBubble("Could not save location.", "assistant");
  } catch (e) {
    addBubble(`Save failed: ${e.message}`, "assistant");
  }
}

async function loadSavedLocation() {
  if (!firebaseAuth?.currentUser) return;
  try {
    const res = await fetch("/api/user/location", { headers: await authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (data.location && !locationEl.value.trim()) {
      locationEl.value = data.location;
    }
    if (data.lat != null && data.lng != null && !userCoords) {
      userCoords = { lat: data.lat, lng: data.lng };
    }
  } catch {
    /* ignore */
  }
}

function clearQuickReplies() {
  quickRepliesListEl.innerHTML = "";
  quickRepliesSectionEl.classList.add("hidden");
}

function renderQuickReplies(options) {
  quickRepliesListEl.innerHTML = "";
  if (!options || !options.length) {
    quickRepliesSectionEl.classList.add("hidden");
    return;
  }
  options.forEach((text, i) => {
    const row = document.createElement("label");
    row.className = "quick-reply-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = text;
    cb.id = `quick-reply-${i}`;
    const span = document.createElement("span");
    span.textContent = text;
    row.appendChild(cb);
    row.appendChild(span);
    quickRepliesListEl.appendChild(row);
  });
  quickRepliesSectionEl.classList.remove("hidden");
}

function getSelectedQuickReplyTexts() {
  const boxes = quickRepliesListEl.querySelectorAll('input[type="checkbox"]');
  const out = [];
  boxes.forEach((cb) => {
    if (cb.checked) out.push(cb.value);
  });
  return out;
}

/** Combine typed text with checked quick replies (used when sending). */
function buildOutgoingMessage() {
  const typed = messageEl.value.trim();
  const quick = getSelectedQuickReplyTexts();
  if (!typed && !quick.length) {
    return "";
  }
  if (!typed) {
    return quick.join("; ");
  }
  if (!quick.length) {
    return typed;
  }
  return `${typed}; ${quick.join("; ")}`;
}

function setChatInputsEnabled(enabled) {
  messageEl.disabled = !enabled;
  locationEl.disabled = !enabled;
  const sendBtn = formEl.querySelector('button[type="submit"]');
  if (sendBtn) sendBtn.disabled = !enabled;
  if (quickRepliesClearEl) quickRepliesClearEl.disabled = !enabled;
}

function finalizeRestaurantChoice(r) {
  if (chatEnded) return;
  chatEnded = true;
  selectedPlaceId = r.place_id || r.name || null;
  clearQuickReplies();
  quickRepliesSectionEl.classList.add("hidden");
  setChatInputsEnabled(false);
  document.body.classList.add("chat-ended");

  const name = r.name || "this place";
  addBubble(`I'll go with: ${name}`, "user");
  addBubble(
    `Sounds good — enjoy ${name}. This chat is done. Use “Reset chat” if you want to pick again.`,
    "assistant"
  );
  recordVisitToCloud(r);
  renderRestaurants(lastRestaurantList);
}

async function sendChatMessage(message) {
  if (chatEnded) {
    return;
  }
  const trimmed = (message || "").trim();
  if (!trimmed) {
    return;
  }

  clearQuickReplies();

  addBubble(trimmed, "user");
  messageEl.value = "";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        session_id: sessionId,
        live_session_code: liveSessionCode || undefined,
        message: trimmed,
        location: locationEl.value.trim(),
        user_lat: userCoords ? userCoords.lat : null,
        user_lng: userCoords ? userCoords.lng : null,
        location_range_miles: locationRangeEl ? parseInt(locationRangeEl.value, 10) : 10,
        client_timezone: getClientTimezone(),
      }),
    });

    const data = await readJsonFromResponse(response);
    if (!response.ok) {
      addBubble(`Error: ${data.error || "Unknown error"}`, "assistant");
      return;
    }

    sessionId = data.session_id;
    addBubble(data.reply, "assistant");
    if (liveSessionCode) liveSessionLastHistoryLength = chatEl.querySelectorAll(".bubble").length;
    updateLocalTimeDisplay(data.local_time_display || "");
    if (locationRangeEl && data.location_range_miles) {
      locationRangeEl.value = String(data.location_range_miles);
    }
    renderRestaurants(data.top_options || data.restaurants);
    renderQuickReplies(data.quick_replies);
    if (liveSessionCode && lastRestaurantList.length) {
      updateLiveSessionRestaurants();
    }
  } catch (err) {
    addBubble(`Network error: ${err.message}`, "assistant");
  }
}

function resetChat() {
  chatEnded = false;
  selectedPlaceId = null;
  lastRestaurantList = [];
  setChatInputsEnabled(true);
  document.body.classList.remove("chat-ended");
  sessionId = null;
  chatEl.innerHTML = "";
  messageEl.value = "";
  updateLocalTimeDisplay("");
  clearQuickReplies();
  renderRestaurants([]);
  addBubble(typeof t === "function" ? t("initialGreeting") : "Hi! Where do you want to eat, and any dietary restrictions or allergies? (Or say none.)", "assistant");
}

let speechVoicesLoaded = false;
function loadSpeechVoices(cb) {
  if (speechVoicesLoaded) return cb && cb();
  const v = speechSynthesis.getVoices();
  if (v.length) {
    speechVoicesLoaded = true;
    return cb && cb();
  }
  speechSynthesis.onvoiceschanged = () => {
    speechVoicesLoaded = true;
    cb && cb();
  };
}

function speakText(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  loadSpeechVoices(() => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.88;
    u.pitch = 1.02;
    u.volume = 1;
    const voices = speechSynthesis.getVoices();
    const pref = voices.find((v) => /Samantha|Karen|Daniel|Google US English/.test(v.name)) ||
      voices.find((v) => v.name.includes("Female") && v.lang.startsWith("en")) ||
      voices.find((v) => v.lang.startsWith("en-US"));
    if (pref) u.voice = pref;
    window.speechSynthesis.speak(u);
  });
}

function addBubble(text, role) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  const textSpan = document.createElement("span");
  textSpan.textContent = text;
  div.appendChild(textSpan);
  if (role === "assistant" && text && "speechSynthesis" in window) {
    const speakBtn = document.createElement("button");
    speakBtn.type = "button";
    speakBtn.className = "bubble-speak";
    speakBtn.setAttribute("aria-label", "Read aloud");
    speakBtn.textContent = "🔊";
    speakBtn.title = "Read aloud";
    speakBtn.addEventListener("click", () => speakText(text));
    div.appendChild(speakBtn);
  }
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function getMatchScore(r) {
  const v = r.match_score ?? r.roi_score;
  if (v === undefined || v === null) return -1;
  const n = Number(v);
  return Number.isFinite(n) ? n : -1;
}

function sortByBestMatchFirst(restaurants) {
  if (!restaurants || !restaurants.length) return [];
  return [...restaurants].sort((a, b) => getMatchScore(b) - getMatchScore(a));
}

function getPhotoRefs(r) {
  if (Array.isArray(r.photo_references) && r.photo_references.length) {
    return r.photo_references;
  }
  if (r.photo_reference) {
    return [r.photo_reference];
  }
  return [];
}

function updateCarouselDots(count) {
  carouselDotsEl.innerHTML = "";
  for (let i = 0; i < count; i += 1) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "carousel-dot";
    btn.setAttribute("aria-label", `Go to restaurant ${i + 1}`);
    btn.addEventListener("click", () => {
      const w = carouselViewportEl.clientWidth;
      carouselViewportEl.scrollTo({ left: i * w, behavior: "smooth" });
    });
    carouselDotsEl.appendChild(btn);
  }
  syncDotsWithScroll();
}

function syncDotsWithScroll() {
  const w = carouselViewportEl.clientWidth;
  if (!w) return;
  const slides = carouselViewportEl.querySelectorAll(".carousel-track .restaurant-card");
  const n = slides.length;
  if (!n) return;
  const i = Math.round(carouselViewportEl.scrollLeft / w) % n;
  const dots = carouselDotsEl.querySelectorAll(".carousel-dot");
  dots.forEach((d, idx) => d.setAttribute("aria-current", idx === i ? "true" : "false"));
}

function scrollMainCarousel(delta) {
  const w = carouselViewportEl.clientWidth;
  const slides = carouselViewportEl.querySelectorAll(".carousel-track .restaurant-card");
  const n = slides.length;
  if (!n || !w) return;
  const i = Math.round(carouselViewportEl.scrollLeft / w);
  const next = (i + delta + n) % n;
  carouselViewportEl.scrollTo({ left: next * w, behavior: "smooth" });
}

function sizeInnerSlides(viewport) {
  const track = viewport.querySelector(".inner-carousel-track");
  if (!track) return;
  const w = viewport.clientWidth;
  if (!w) return;
  track.querySelectorAll(".inner-slide").forEach((slide) => {
    slide.style.flex = `0 0 ${w}px`;
    slide.style.width = `${w}px`;
  });
}

function wireInnerCarousel(viewport) {
  const track = viewport.querySelector(".inner-carousel-track");
  if (!track) return;
  const wrap = viewport.parentElement;
  const prev = wrap && wrap.querySelector(".inner-carousel-btn.inner-prev");
  const next = wrap && wrap.querySelector(".inner-carousel-btn.inner-next");
  const slideCount = () => track.querySelectorAll(".inner-slide").length;
  const go = (delta) => {
    const w = viewport.clientWidth;
    const n = slideCount();
    if (!n || !w) return;
    const i = Math.round(viewport.scrollLeft / w);
    const j = (i + delta + n) % n;
    viewport.scrollTo({ left: j * w, behavior: "smooth" });
  };
  if (prev) prev.addEventListener("click", () => go(-1));
  if (next) next.addEventListener("click", () => go(1));
}

function renderRestaurants(restaurants, votesWithDetails) {
  lastRestaurantList = Array.isArray(restaurants) ? restaurants : [];
  if (Array.isArray(votesWithDetails)) lastVotesWithDetails = votesWithDetails;
  restaurantsEl.innerHTML = "";
  const sorted = sortByBestMatchFirst(lastRestaurantList);

  if (!sorted.length) {
    carouselEmptyEl.classList.remove("hidden");
    carouselUiEl.classList.add("hidden");
    return;
  }

  carouselEmptyEl.classList.add("hidden");
  carouselUiEl.classList.remove("hidden");

  sorted.forEach((r, index) => {
    const card = document.createElement("article");
    card.className = "restaurant-card";
    const pid = r.place_id;
    const selected =
      (pid && selectedPlaceId === pid) || (!pid && r.name && selectedPlaceId === r.name);
    if (selectedPlaceId && selected) {
      card.classList.add("restaurant-card--selected");
    }

    const rank = document.createElement("span");
    rank.className = "rank-badge";
    rank.textContent = index === 0 ? (typeof t === "function" ? t("bestMatch") : "Best match") : `#${index + 1} ${typeof t === "function" ? t("pick") : "pick"}`;
    card.appendChild(rank);

    const refs = getPhotoRefs(r);
    if (refs.length) {
      const wrap = document.createElement("div");
      wrap.className = "inner-carousel-wrap";
      const prevBtn = document.createElement("button");
      prevBtn.type = "button";
      prevBtn.className = "inner-carousel-btn inner-prev";
      prevBtn.setAttribute("aria-label", "Previous photo");
      prevBtn.textContent = "‹";
      const innerVp = document.createElement("div");
      innerVp.className = "inner-carousel-viewport";
      const innerTrack = document.createElement("div");
      innerTrack.className = "inner-carousel-track";
      refs.forEach((ref) => {
        const slide = document.createElement("div");
        slide.className = "inner-slide";
        const img = document.createElement("img");
        img.alt = r.name || "Photo";
        img.loading = "lazy";
        img.src = `/api/place-photo?ref=${encodeURIComponent(ref)}&maxwidth=1200`;
        slide.appendChild(img);
        innerTrack.appendChild(slide);
      });
      innerVp.appendChild(innerTrack);
      const nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.className = "inner-carousel-btn inner-next";
      nextBtn.setAttribute("aria-label", "Next photo");
      nextBtn.textContent = "›";
      wrap.appendChild(prevBtn);
      wrap.appendChild(innerVp);
      wrap.appendChild(nextBtn);
      card.appendChild(wrap);
      requestAnimationFrame(() => {
        sizeInnerSlides(innerVp);
        wireInnerCarousel(innerVp);
      });
    }

    const titleRow = document.createElement("div");
    titleRow.style.marginBottom = "4px";

    const title = document.createElement("h3");
    title.style.display = "inline";
    title.textContent = r.name || "Unknown";
    titleRow.appendChild(title);

    const pct = getMatchScore(r);
    if (pct >= 0) {
      const badge = document.createElement("span");
      badge.className = "match-pct";
      badge.textContent = `${Math.round(pct)}% match`;
      titleRow.appendChild(badge);
    }
    card.appendChild(titleRow);

    const rating = document.createElement("p");
    rating.className = "muted";
    rating.textContent = `Rating: ${r.rating ?? "N/A"} (${r.user_ratings_total ?? 0} reviews)`;
    card.appendChild(rating);

    const price = document.createElement("p");
    price.className = "muted";
    const priceLabel = r.price_display != null ? r.price_display : r.price_level ?? "N/A";
    price.textContent = `Price: ${priceLabel}`;
    card.appendChild(price);

    if (r.hours_text) {
      const hours = document.createElement("div");
      hours.className = "hours-plain";
      hours.textContent = `Hours: ${r.hours_text}`;
      card.appendChild(hours);
    }

    const address = document.createElement("p");
    address.className = "muted";
    address.textContent = r.address || "No address available";
    card.appendChild(address);

    if (r.travel_duration_text) {
      const travel = document.createElement("p");
      travel.className = "travel-estimate";
      const parts = [r.travel_duration_text];
      if (r.travel_distance_text) {
        parts.push(r.travel_distance_text);
      }
      travel.textContent = `From you: ${parts.join(" · ")}`;
      card.appendChild(travel);
    }

    if (r.dish_highlight) {
      const dish = document.createElement("p");
      dish.className = "dish-highlight";
      dish.textContent = `${typeof t === "function" ? t("mustTry") : "Must try"}: ${r.dish_highlight}`;
      card.appendChild(dish);
    }

    if (r.why_fit) {
      const why = document.createElement("p");
      why.className = "note-plain";
      why.textContent = r.why_fit;
      card.appendChild(why);
    }

    if (r.website) {
      const website = document.createElement("a");
      website.href = r.website;
      website.target = "_blank";
      website.rel = "noreferrer";
      website.textContent = typeof t === "function" ? t("website") : "Website";
      card.appendChild(website);
    }

    if (r.maps_url) {
      const maps = document.createElement("a");
      maps.href = r.maps_url;
      maps.target = "_blank";
      maps.rel = "noreferrer";
      maps.style.marginLeft = "10px";
      maps.textContent = typeof t === "function" ? t("maps") : "Google Maps";
      card.appendChild(maps);
    }

    const actionsRow = document.createElement("div");
    actionsRow.className = "restaurant-actions-row";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-save-restaurant";
    saveBtn.textContent = typeof t === "function" ? t("saveForLater") : "Save for later";
    saveBtn.disabled = chatEnded;
    saveBtn.setAttribute("aria-label", `Save ${r.name || "restaurant"} without ending chat`);
    if (!chatEnded) {
      saveBtn.addEventListener("click", () => saveRestaurantForLater(r));
    }
    actionsRow.appendChild(saveBtn);

    const selectRow = document.createElement("div");
    selectRow.className = "restaurant-select-row";
    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className = "btn-select-restaurant";
    if (chatEnded) {
      selectBtn.textContent = selected ? (typeof t === "function" ? t("selected") : "Selected") : (typeof t === "function" ? t("notChosen") : "Not chosen");
      selectBtn.disabled = true;
      selectBtn.classList.toggle("btn-select-restaurant--muted", !selected);
    } else {
      selectBtn.textContent = typeof t === "function" ? t("chooseThis") : "Choose this place";
      selectBtn.disabled = false;
    }
    selectBtn.setAttribute(
      "aria-label",
      chatEnded
        ? selected
          ? "Your choice"
          : "Another option"
        : `Choose ${r.name || "this restaurant"} and end chat`
    );
    if (!chatEnded) {
      selectBtn.addEventListener("click", () => finalizeRestaurantChoice(r));
    }

    selectRow.appendChild(selectBtn);
    actionsRow.appendChild(selectRow);

    if (liveSessionCode && pid) {
      const voteBtn = document.createElement("button");
      voteBtn.type = "button";
      voteBtn.className = "btn-vote";
      voteBtn.textContent = typeof t === "function" ? t("vote") : "Vote";
      voteBtn.setAttribute("aria-label", `Vote for ${r.name || "this restaurant"}`);
      voteBtn.addEventListener("click", () => voteForRestaurant(pid));
      actionsRow.appendChild(voteBtn);
    }

    card.appendChild(actionsRow);

    if (liveSessionCode && pid) {
      const votesForThis = lastVotesWithDetails.filter((v) => v.place_id === pid);
      if (votesForThis.length) {
        const badgeWrap = document.createElement("div");
        badgeWrap.className = "vote-badges";
        votesForThis.forEach((v) => {
          const badge = document.createElement("span");
          badge.className = "vote-badge";
          const matchStr = v.match_score != null ? ` ${v.match_score}%` : "";
          badge.textContent = `${v.displayName || "?"} voted${matchStr}`;
          badgeWrap.appendChild(badge);
        });
        card.appendChild(badgeWrap);
      }
    }

    restaurantsEl.appendChild(card);
  });

  requestAnimationFrame(() => {
    carouselViewportEl.scrollLeft = 0;
    updateCarouselDots(sorted.length);
  });
}

carouselPrevEl.addEventListener("click", () => scrollMainCarousel(-1));
carouselNextEl.addEventListener("click", () => scrollMainCarousel(1));

carouselViewportEl.addEventListener("scroll", () => {
  window.requestAnimationFrame(syncDotsWithScroll);
});

window.addEventListener("resize", syncDotsWithScroll);

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  sendChatMessage(buildOutgoingMessage());
});

resetChatEl.addEventListener("click", resetChat);

quickRepliesClearEl.addEventListener("click", () => {
  quickRepliesListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = false;
  });
});

addBubble(typeof t === "function" ? t("initialGreeting") : "Hi! Where do you want to eat, and any dietary restrictions or allergies? (Or say none.)", "assistant");

async function autofillLocationFromCoords(lat, lng) {
  if (locationEl.value.trim()) {
    return;
  }
  try {
    const res = await fetch(
      `/api/reverse-geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`
    );
    if (!res.ok) return;
    const data = await res.json();
    if (data.label) {
      locationEl.value = data.label;
      locationEl.setAttribute("title", "Filled from your approximate location — you can edit this.");
    }
  } catch {
    /* ignore */
  }
}

let locationAutocompleteTimer = null;
let locationAutocompleteHideTimer = null;

function hideLocationAutocomplete() {
  if (!locationAutocompleteEl || !locationEl) return;
  locationAutocompleteEl.classList.add("hidden");
  locationAutocompleteEl.innerHTML = "";
  locationEl.setAttribute("aria-expanded", "false");
}

function setupLocationAutocomplete() {
  if (!locationEl || !locationAutocompleteEl) return;

  locationEl.addEventListener("input", () => {
    const q = locationEl.value.trim();
    clearTimeout(locationAutocompleteTimer);
    if (q.length < 2) {
      hideLocationAutocomplete();
      return;
    }
    locationAutocompleteTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/place-autocomplete?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!res.ok || !data.predictions?.length) {
          hideLocationAutocomplete();
          return;
        }
        locationAutocompleteEl.innerHTML = "";
        data.predictions.forEach((p) => {
          const li = document.createElement("li");
          li.setAttribute("role", "option");
          li.className = "location-autocomplete-item";
          li.tabIndex = -1;
          li.textContent = p.description || "";
          li.addEventListener("mousedown", (e) => {
            e.preventDefault();
            locationEl.value = p.description || "";
            hideLocationAutocomplete();
            locationEl.focus();
          });
          locationAutocompleteEl.appendChild(li);
        });
        locationAutocompleteEl.classList.remove("hidden");
        locationEl.setAttribute("aria-expanded", "true");
      } catch {
        hideLocationAutocomplete();
      }
    }, 280);
  });

  locationEl.addEventListener("blur", () => {
    locationAutocompleteHideTimer = setTimeout(hideLocationAutocomplete, 200);
  });
  locationEl.addEventListener("focus", () => {
    clearTimeout(locationAutocompleteHideTimer);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideLocationAutocomplete();
  });
}

setupLocationAutocomplete();

if ("geolocation" in navigator) {
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      userCoords = { lat, lng };
      await autofillLocationFromCoords(lat, lng);
      addBubble("Location access enabled. I can now prioritize nearby restaurants.", "assistant");
    },
    () => {
      addBubble("Location access not granted. Please enter city/area manually above.", "assistant");
    },
    { enableHighAccuracy: false, timeout: 8000 }
  );
}

async function voteForRestaurant(placeId) {
  if (!liveSessionCode || !firebaseAuth?.currentUser) return;
  try {
    const res = await fetch(`/api/live-session/${liveSessionCode}/vote`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ place_id: placeId }),
    });
    if (res.ok) addBubble("Vote recorded!", "assistant");
    else addBubble("Could not record vote.", "assistant");
  } catch (e) {
    addBubble(`Vote failed: ${e.message}`, "assistant");
  }
}

async function updateLiveSessionRestaurants() {
  if (!liveSessionCode || !lastRestaurantList.length) return;
  try {
    await fetch(`/api/live-session/${liveSessionCode}/restaurants`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({
        restaurants: lastRestaurantList.map((r) => ({
          place_id: r.place_id,
          name: r.name,
          address: r.address,
          why_fit: r.why_fit,
          rating: r.rating,
          price_display: r.price_display,
          match_score: r.match_score,
          dish_highlight: r.dish_highlight,
        })),
      }),
    });
  } catch {
    /* ignore */
  }
}

function leaveLiveSession() {
  liveSessionCode = null;
  liveSessionLastHistoryLength = 0;
  if (liveSessionPollTimer) {
    clearInterval(liveSessionPollTimer);
    liveSessionPollTimer = null;
  }
  if (liveSessionCodeEl) {
    liveSessionCodeEl.classList.add("hidden");
    liveSessionCodeEl.textContent = "";
  }
  updateLobbyMembers([]);
  const lobbyEl = document.getElementById("live-session-lobby");
  if (lobbyEl) lobbyEl.classList.add("hidden");
  if (btnLeaveSessionEl) btnLeaveSessionEl.classList.add("hidden");
}

function syncChatFromLiveSession(history) {
  if (!Array.isArray(history) || history.length <= liveSessionLastHistoryLength) return;
  const bubbles = chatEl.querySelectorAll(".bubble");
  for (let i = bubbles.length; i < history.length; i++) {
    const msg = history[i];
    if (msg && msg.role && msg.content) addBubble(msg.content, msg.role);
  }
  liveSessionLastHistoryLength = history.length;
}

function updateLobbyMembers(members) {
  const listEl = document.getElementById("lobby-members-list");
  const lobbyEl = document.getElementById("live-session-lobby");
  if (!listEl || !lobbyEl) return;
  if (!members || !members.length) {
    lobbyEl.classList.add("hidden");
    return;
  }
  lobbyEl.classList.remove("hidden");
  listEl.innerHTML = "";
  members.forEach((m) => {
    const li = document.createElement("li");
    li.textContent = typeof m === "object" ? (m.displayName || m.uid || "?") : m;
    listEl.appendChild(li);
  });
}

function startLiveSessionPoll() {
  if (liveSessionPollTimer) clearInterval(liveSessionPollTimer);
  liveSessionPollTimer = setInterval(async () => {
    if (!liveSessionCode) return;
    try {
      const res = await fetch(`/api/live-session/${liveSessionCode}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.chatState?.history) syncChatFromLiveSession(data.chatState.history);
      if (data.members) updateLobbyMembers(data.members);
      if (data.restaurants?.length) {
        const hadNone = !lastRestaurantList.length;
        renderRestaurants(data.restaurants, data.votesWithDetails);
        if (hadNone && data.restaurants.length) lastRestaurantList = data.restaurants;
      }
    } catch {
      /* ignore */
    }
  }, 2500);
}

if (btnMicEl) {
  let recognition = null;
  let committedTranscript = "";
  let interimTranscript = "";

  if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    try {
      recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.maxAlternatives = 3;

      recognition.onresult = (e) => {
        if (!messageEl) return;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          const transcript = result[0]?.transcript?.trim() || "";
          if (!transcript) continue;
          if (result.isFinal) {
            committedTranscript = committedTranscript ? `${committedTranscript} ${transcript}` : transcript;
            interimTranscript = "";
          } else {
            interimTranscript = transcript;
          }
        }
        const full = committedTranscript + (interimTranscript ? ` ${interimTranscript}` : "");
        messageEl.value = full.trim();
        messageEl.dispatchEvent(new Event("input", { bubbles: true }));
      };

      recognition.onend = () => btnMicEl.classList.remove("recording");

      recognition.onerror = (e) => {
        btnMicEl.classList.remove("recording");
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          addBubble("Microphone access was denied. Check your browser permissions.", "assistant");
        } else if (e.error === "no-speech") {
          addBubble("No speech detected. Try again?", "assistant");
        } else if (e.error !== "aborted") {
          addBubble("Voice input error. Try Chrome or Edge if it keeps failing.", "assistant");
        }
      };

      recognition.onspeechstart = () => {
        committedTranscript = messageEl ? messageEl.value : "";
      };
    } catch (err) {
      recognition = null;
    }
  }

  btnMicEl.addEventListener("click", async () => {
    if (!recognition) {
      addBubble("Voice input isn't supported in this browser. Try Chrome or Edge.", "assistant");
      return;
    }
    if (btnMicEl.classList.contains("recording")) {
      try { recognition.stop(); } catch (_) {}
      return;
    }
    try {
      recognition.abort && recognition.abort();
    } catch (_) {}
    committedTranscript = messageEl ? messageEl.value : "";
    interimTranscript = "";
    btnMicEl.classList.add("recording");
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        stream.getTracks().forEach((t) => t.stop());
      }
    } catch (mediaErr) {
      if (mediaErr.name === "NotAllowedError" || mediaErr.name === "PermissionDeniedError") {
        btnMicEl.classList.remove("recording");
        addBubble("Microphone access was denied. Check your browser permissions.", "assistant");
        return;
      }
    }
    try {
      recognition.start();
    } catch (err) {
      btnMicEl.classList.remove("recording");
      if (err.name === "NotAllowedError" || err.name === "InvalidStateError") {
        addBubble("Microphone access was denied. Check your browser permissions.", "assistant");
      } else {
        addBubble("Couldn't start voice input. Try again.", "assistant");
      }
    }
  });
}

if (btnSaveLocationEl) {
  btnSaveLocationEl.addEventListener("click", saveLocationToProfile);
}

if (btnProfileEl) {
  btnProfileEl.addEventListener("click", async () => {
    if (!profileModalEl) return;
    try {
      const res = await fetch("/api/user/custom-preferences", { headers: await authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const p = data.customPreferences || {};
        const fav = document.getElementById("pref-favorite-cuisines");
        const avoid = document.getElementById("pref-avoid");
        const notes = document.getElementById("pref-notes");
        if (fav) fav.value = p.favoriteCuisines || "";
        if (avoid) avoid.value = p.avoid || "";
        if (notes) notes.value = p.notes || "";
      }
    } catch {
      /* ignore */
    }
    profileModalEl.classList.remove("hidden");
  });
}

if (btnCloseProfileEl) {
  btnCloseProfileEl.addEventListener("click", () => {
    if (profileModalEl) profileModalEl.classList.add("hidden");
  });
}

if (btnSavePreferencesEl) {
  btnSavePreferencesEl.addEventListener("click", async () => {
    if (!firebaseAuth?.currentUser) return;
    const fav = (document.getElementById("pref-favorite-cuisines") || {}).value || "";
    const avoid = (document.getElementById("pref-avoid") || {}).value || "";
    const notes = (document.getElementById("pref-notes") || {}).value || "";
    try {
      const res = await fetch("/api/user/custom-preferences", {
        method: "PUT",
        headers: await authHeaders(),
        body: JSON.stringify({
          customPreferences: { favoriteCuisines: fav, avoid, notes },
        }),
      });
      if (res.ok) {
        addBubble("Preferences saved.", "assistant");
        if (profileModalEl) profileModalEl.classList.add("hidden");
      }
    } catch (e) {
      addBubble(`Save failed: ${e.message}`, "assistant");
    }
  });
}

let _lobbyModalPending = null;
function showLobbyModal(onConfirm) {
  const modal = document.getElementById("lobby-modal");
  const input = document.getElementById("lobby-name-input");
  const confirmBtn = document.getElementById("lobby-modal-confirm");
  const cancelBtn = document.getElementById("lobby-modal-cancel");
  if (!modal || !input || !confirmBtn || !cancelBtn) return;
  _lobbyModalPending = onConfirm;
  input.value = firebaseAuth?.currentUser?.displayName?.split(" ")[0] || "";
  modal.classList.remove("hidden");
  input.focus();
}
function hideLobbyModal() {
  const modal = document.getElementById("lobby-modal");
  if (modal) modal.classList.add("hidden");
  _lobbyModalPending = null;
}

if (btnCreateSessionEl) {
  btnCreateSessionEl.addEventListener("click", async () => {
    if (!firebaseAuth?.currentUser) {
      addBubble("Sign in to create a group session.", "assistant");
      return;
    }
    showLobbyModal(async (displayName) => {
      try {
        const initialHistory = [];
        chatEl.querySelectorAll(".bubble").forEach((b) => {
          const role = b.classList.contains("user") ? "user" : "assistant";
          const text = b.querySelector("span")?.textContent?.trim();
          if (text) initialHistory.push({ role, content: text });
        });
        const res = await fetch("/api/live-session", {
          method: "POST",
          headers: await authHeaders(),
          body: JSON.stringify({
            restaurants: lastRestaurantList,
            display_name: displayName,
            chatState: {
              history: initialHistory,
              location: locationEl?.value?.trim() || null,
              location_range_miles: locationRangeEl ? parseInt(locationRangeEl.value, 10) : 10,
              stage_index: 0,
              readiness_score: 0,
              recommendations_started: false,
              last_place_ids: [],
              last_place_names: [],
              preferences: {},
            },
          }),
        });
        const data = await res.json();
        if (data.code) {
          liveSessionCode = data.code;
          sessionId = data.code;
          liveSessionLastHistoryLength = chatEl.querySelectorAll(".bubble").length;
          if (liveSessionCodeEl) {
            liveSessionCodeEl.textContent = `Session: ${data.code}`;
            liveSessionCodeEl.classList.remove("hidden");
          }
          if (btnLeaveSessionEl) btnLeaveSessionEl.classList.remove("hidden");
          addBubble(`Session created! Share code: ${data.code}`, "assistant");
          startLiveSessionPoll();
          const sessRes = await fetch(`/api/live-session/${data.code}`);
          if (sessRes.ok) {
            const sess = await sessRes.json();
            if (sess.members) updateLobbyMembers(sess.members);
          }
        }
      } catch (e) {
        addBubble(`Create failed: ${e.message}`, "assistant");
      }
    });
  });
}

if (btnJoinSessionEl && sessionCodeInputEl) {
  btnJoinSessionEl.addEventListener("click", async () => {
    const code = sessionCodeInputEl.value.trim().toUpperCase();
    if (!code) {
      addBubble("Enter a session code.", "assistant");
      return;
    }
    if (!firebaseAuth?.currentUser) {
      addBubble("Sign in to join a session.", "assistant");
      return;
    }
    showLobbyModal(async (displayName) => {
      try {
        const res = await fetch(`/api/live-session/${code}/join`, {
          method: "POST",
          headers: await authHeaders(),
          body: JSON.stringify({ display_name: displayName }),
        });
        if (res.ok) {
          liveSessionCode = code;
          sessionId = code;
          if (liveSessionCodeEl) {
            liveSessionCodeEl.textContent = `Session: ${code}`;
            liveSessionCodeEl.classList.remove("hidden");
          }
          if (btnLeaveSessionEl) btnLeaveSessionEl.classList.remove("hidden");
          addBubble("Joined session!", "assistant");
          startLiveSessionPoll();
          const sessRes = await fetch(`/api/live-session/${code}`);
          if (sessRes.ok) {
            const sess = await sessRes.json();
            if (sess.restaurants?.length) {
              renderRestaurants(sess.restaurants);
              lastRestaurantList = sess.restaurants;
            }
            if (sess.members) updateLobbyMembers(sess.members);
            if (sess.chatState?.history?.length) {
              chatEl.innerHTML = "";
              sess.chatState.history.forEach((msg) => addBubble(msg.content, msg.role));
              liveSessionLastHistoryLength = sess.chatState.history.length;
            } else {
              liveSessionLastHistoryLength = chatEl.querySelectorAll(".bubble").length;
            }
          }
        } else {
          addBubble("Session not found.", "assistant");
        }
      } catch (e) {
        addBubble(`Join failed: ${e.message}`, "assistant");
      }
    });
  });
}

if (btnLeaveSessionEl) {
  btnLeaveSessionEl.addEventListener("click", leaveLiveSession);
}

const lobbyModalConfirmEl = document.getElementById("lobby-modal-confirm");
const lobbyModalCancelEl = document.getElementById("lobby-modal-cancel");
const lobbyNameInputEl = document.getElementById("lobby-name-input");
if (lobbyModalConfirmEl && lobbyModalCancelEl && lobbyNameInputEl) {
  lobbyModalConfirmEl.addEventListener("click", () => {
    if (typeof _lobbyModalPending === "function") {
      const name = lobbyNameInputEl.value.trim() || "Guest";
      hideLobbyModal();
      _lobbyModalPending(name);
    }
  });
  lobbyModalCancelEl.addEventListener("click", hideLobbyModal);
}

initFirebaseClient();

if (tabSavedEl && tabVisitedEl && panelSavedEl && panelVisitedEl) {
  tabSavedEl.addEventListener("click", () => {
    tabSavedEl.classList.add("active");
    tabVisitedEl.classList.remove("active");
    panelSavedEl.classList.remove("hidden");
    panelVisitedEl.classList.add("hidden");
  });
  tabVisitedEl.addEventListener("click", () => {
    tabVisitedEl.classList.add("active");
    tabSavedEl.classList.remove("active");
    panelVisitedEl.classList.remove("hidden");
    panelSavedEl.classList.add("hidden");
  });
}

if (signInGoogleEl) {
  signInGoogleEl.addEventListener("click", async () => {
    if (!firebaseAuth) {
      addBubble(
        "Sign-in isn’t available: the server didn’t return a full Firebase config. Locally, set FIREBASE_WEB_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_APP_ID, and FIREBASE_MESSAGING_SENDER_ID in .env and restart. On Cloud Run, set the same variables on the service and redeploy.",
        "assistant"
      );
      return;
    }
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      try {
        await firebaseAuth.signInWithPopup(provider);
      } catch (popupErr) {
        const code = popupErr && popupErr.code;
        // Popups often blocked on mobile / embedded browsers; full-page redirect works on Cloud Run.
        if (
          code === "auth/popup-blocked" ||
          code === "auth/operation-not-supported-in-this-environment"
        ) {
          await firebaseAuth.signInWithRedirect(provider);
          return;
        }
        throw popupErr;
      }
    } catch (err) {
      addBubble(`Sign-in failed: ${err.message || err}`, "assistant");
    }
  });
}
if (signOutEl) {
  signOutEl.addEventListener("click", () => {
    firebaseAuth?.signOut();
  });
}

if (typeof initI18n === "function") initI18n();

const langSelectEl = document.getElementById("lang-select");
if (langSelectEl && typeof getLang === "function") {
  langSelectEl.value = getLang();
  langSelectEl.addEventListener("change", () => {
    if (typeof setLang === "function") setLang(langSelectEl.value);
  });
}
