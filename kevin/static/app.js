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

let sessionId = null;
let firebaseAuth = null;
let userCoords = null;
/** After user picks a restaurant, chat input is disabled until Reset. */
let chatEnded = false;
let lastRestaurantList = [];
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
        const title = document.createElement("span");
        title.className = "history-item-title";
        title.textContent = item.name || "Restaurant";
        li.appendChild(title);
        if (item.summary) {
          const sm = document.createElement("span");
          sm.className = "history-item-meta";
          sm.textContent = item.summary.length > 80 ? `${item.summary.slice(0, 80)}…` : item.summary;
          li.appendChild(sm);
        }
        if (item.recordedAt) {
          const dt = document.createElement("span");
          dt.className = "history-item-date";
          dt.textContent = formatRecordDate(item.recordedAt);
          li.appendChild(dt);
        }
        listSavedEl.appendChild(li);
      });
    }
    if (listVisitedEl) {
      listVisitedEl.innerHTML = "";
      visited.forEach((item) => {
        const li = document.createElement("li");
        const title = document.createElement("span");
        title.className = "history-item-title";
        title.textContent = item.name || "Restaurant";
        li.appendChild(title);
        if (item.recordedAt) {
          const dt = document.createElement("span");
          dt.className = "history-item-date";
          dt.textContent = formatRecordDate(item.recordedAt);
          li.appendChild(dt);
        }
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
  } else {
    signInGoogleEl.classList.remove("hidden");
    signOutEl.classList.add("hidden");
    authUserLabelEl.textContent = "";
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

async function initFirebaseClient() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    const fb = cfg.firebase;
    if (!firebaseConfigReady(fb)) {
      if (signInGoogleEl) signInGoogleEl.disabled = true;
      return;
    }
    firebase.initializeApp(fb);
    firebaseAuth = firebase.auth();
    firebaseAuth.onAuthStateChanged((user) => {
      updateAuthUI(user);
      refreshSidebarLists();
    });
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
  try {
    const res = await fetch("/api/restaurants/save", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(restaurantPayload(r)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      addBubble(data.error || "Could not save.", "assistant");
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
  try {
    await fetch("/api/restaurants/visit", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(restaurantPayload(r)),
    });
    refreshSidebarLists();
  } catch {
    /* optional */
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
        message: trimmed,
        location: locationEl.value.trim(),
        user_lat: userCoords ? userCoords.lat : null,
        user_lng: userCoords ? userCoords.lng : null,
        client_timezone: getClientTimezone(),
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      addBubble(`Error: ${data.error || "Unknown error"}`, "assistant");
      return;
    }

    sessionId = data.session_id;
    addBubble(data.reply, "assistant");
    updateLocalTimeDisplay(data.local_time_display || "");
    renderRestaurants(data.top_options || data.restaurants);
    renderQuickReplies(data.quick_replies);
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
  addBubble(
    "Hi! Where do you want to eat, and any dietary restrictions or allergies? (Or say none.)",
    "assistant"
  );
}

function addBubble(text, role) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = text;
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

function renderRestaurants(restaurants) {
  lastRestaurantList = Array.isArray(restaurants) ? restaurants : [];
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
    rank.textContent = index === 0 ? "Best match" : `#${index + 1} pick`;
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
        img.src = `/api/place-photo?ref=${encodeURIComponent(ref)}`;
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
      website.textContent = "Website";
      card.appendChild(website);
    }

    if (r.maps_url) {
      const maps = document.createElement("a");
      maps.href = r.maps_url;
      maps.target = "_blank";
      maps.rel = "noreferrer";
      maps.style.marginLeft = "10px";
      maps.textContent = "Google Maps";
      card.appendChild(maps);
    }

    const actionsRow = document.createElement("div");
    actionsRow.className = "restaurant-actions-row";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-save-restaurant";
    saveBtn.textContent = "Save for later";
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
      selectBtn.textContent = selected ? "Selected" : "Not chosen";
      selectBtn.disabled = true;
      selectBtn.classList.toggle("btn-select-restaurant--muted", !selected);
    } else {
      selectBtn.textContent = "Choose this place";
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
    card.appendChild(actionsRow);

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

addBubble(
  "Hi! Where do you want to eat, and any dietary restrictions or allergies? (Or say none.)",
  "assistant"
);

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
      addBubble("Firebase is not configured on the server. Add Firebase keys to .env.", "assistant");
      return;
    }
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await firebaseAuth.signInWithPopup(provider);
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
