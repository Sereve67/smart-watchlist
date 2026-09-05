"use strict";

/**
 * Frontend is deliberately framework-free: this is a small, mostly
 * server-driven view (server computes significance, diffs, staleness -
 * the client just renders state and reflects user actions). A build
 * step would add friction without buying much here. If this grew real
 * interaction complexity (drag-reorder, multi-pane layouts) React would
 * earn its place; for a list that mostly reflects server state, it
 * doesn't yet.
 */

const state = {
  items: new Map(), // symbol -> item (state + change), server-shaped
  sparkHistory: new Map(), // symbol -> array of recent prices (client-side only, for the trend line)
  ws: null,
  wsBackoffMs: 500,
  hasBannerShown: false,
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

async function boot() {
  try {
    const me = await api("/me");
    showMain(me);
  } catch {
    showLogin();
  }
}

function showLogin() {
  el("login-screen").classList.remove("hidden");
  el("main-screen").classList.add("hidden");
}

function showMain(me) {
  el("login-screen").classList.add("hidden");
  el("main-screen").classList.remove("hidden");
  el("user-badge").textContent = me.username;
  loadSymbolSuggestions();
  loadWatchlist();
  connectWs();
}

el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = el("username-input").value.trim();
  if (!username) return;
  try {
    const me = await api("/session", { method: "POST", body: { username } });
    showMain(me);
  } catch (err) {
    alert(err.message);
  }
});

// ---------------------------------------------------------------------
// Watchlist load + render
// ---------------------------------------------------------------------

async function loadSymbolSuggestions() {
  try {
    const { results } = await api("/symbols/search?q=");
    const datalist = el("symbol-suggestions");
    datalist.innerHTML = results.map((s) => `<option value="${s}"></option>`).join("");
  } catch {
    /* non-critical */
  }
}

async function loadWatchlist() {
  const { items } = await api("/watchlist");
  state.items.clear();
  for (const item of items) {
    if (item.change && !item.change.isNew) item.lastSeenPrice = item.change.snapshotPrice;
    state.items.set(item.symbol, item);
  }
  renderList();
  renderChangeBanner();
}

function renderChangeBanner() {
  const changed = [...state.items.values()].filter(
    (i) => i.change && !i.change.isNew && i.change.severity !== "none"
  );
  const banner = el("change-banner");
  if (changed.length === 0 || state.hasBannerShown) {
    banner.classList.add("hidden");
    return;
  }
  const majorCount = changed.filter((i) => i.change.severity === "major").length;
  const names = changed
    .slice(0, 4)
    .map((i) => i.symbol)
    .join(", ");
  const more = changed.length > 4 ? ` +${changed.length - 4} more` : "";
  banner.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = `${changed.length} item${changed.length > 1 ? "s" : ""} changed since your last visit${
    majorCount ? ` (${majorCount} major)` : ""
  }: ${names}${more}`;
  const btn = document.createElement("button");
  btn.className = "secondary";
  btn.textContent = "Dismiss";
  btn.onclick = () => {
    banner.classList.add("hidden");
    state.hasBannerShown = true;
  };
  banner.appendChild(text);
  banner.appendChild(btn);
  banner.classList.remove("hidden");
}

function fmtPct(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const pct = (x * 100).toFixed(2);
  return `${x >= 0 ? "+" : ""}${pct}%`;
}

function directionClass(x) {
  if (x === null || x === undefined) return "flat";
  if (x > 0.0005) return "up";
  if (x < -0.0005) return "down";
  return "flat";
}

function renderList() {
  const list = el("list");
  const empty = el("empty-state");
  list.innerHTML = "";

  const symbols = [...state.items.keys()].sort();
  if (symbols.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const header = document.createElement("div");
  header.className = "row-header";
  header.innerHTML = `<span>Symbol</span><span>Trend</span><span>Price</span><span>Today</span><span>Since you checked</span><span>Flags</span><span></span>`;
  list.appendChild(header);

  for (const symbol of symbols) {
    list.appendChild(renderRow(symbol));
  }
}

function renderRow(symbol) {
  const item = state.items.get(symbol);
  const row = document.createElement("div");
  row.className = "row";
  row.id = `row-${symbol}`;

  const symEl = document.createElement("div");
  symEl.className = "symbol";
  symEl.textContent = symbol;

  const sparkEl = document.createElement("div");
  sparkEl.className = "spark";
  sparkEl.innerHTML = renderSparkline(symbol);

  const priceEl = document.createElement("div");
  priceEl.className = "price";
  priceEl.textContent = item.state ? item.state.price.toFixed(2) : "—";

  const dayChangeEl = document.createElement("div");
  dayChangeEl.className = "day-change " + directionClass(item.state?.dayChangePct);
  dayChangeEl.textContent = item.state ? fmtPct(item.state.dayChangePct) : "—";

  const sinceSeenEl = document.createElement("div");
  const pct = item.change?.pctSinceLastSeen;
  sinceSeenEl.className = "since-seen " + directionClass(pct);
  sinceSeenEl.textContent = item.change?.isNew ? "new" : fmtPct(pct);

  const badgesEl = document.createElement("div");
  badgesEl.className = "badges";
  badgesEl.innerHTML = renderBadges(item);

  const removeEl = document.createElement("button");
  removeEl.className = "remove-btn";
  removeEl.title = "Remove";
  removeEl.textContent = "×";
  removeEl.onclick = () => removeSymbol(symbol);

  row.append(symEl, sparkEl, priceEl, dayChangeEl, sinceSeenEl, badgesEl, removeEl);
  row.addEventListener("click", (e) => {
    if (e.target === removeEl) return;
    ackSymbol(symbol);
  });
  row.title = "Click to mark reviewed";
  return row;
}

function renderBadges(item) {
  if (!item.change) return "";
  const badges = [];
  if (item.change.isNew) badges.push(`<span class="badge new">new</span>`);
  if (item.change.severity && item.change.severity !== "none") {
    badges.push(`<span class="badge ${item.change.severity}">${item.change.severity}</span>`);
  }
  if (item.change.stale) badges.push(`<span class="badge stale">stale</span>`);
  for (const tag of item.change.tags || []) {
    if (tag === "stale-data") continue;
    badges.push(`<span class="badge notable">${tag}</span>`);
  }
  return badges.join("");
}

function pushSparkPoint(symbol, price) {
  const hist = state.sparkHistory.get(symbol) || [];
  hist.push(price);
  if (hist.length > 24) hist.shift();
  state.sparkHistory.set(symbol, hist);
}

function renderSparkline(symbol) {
  const hist = state.sparkHistory.get(symbol);
  if (!hist || hist.length < 2) {
    return `<svg viewBox="0 0 100 26" preserveAspectRatio="none"></svg>`;
  }
  const min = Math.min(...hist);
  const max = Math.max(...hist);
  const range = max - min || 1;
  const stepX = 100 / (hist.length - 1);
  const points = hist
    .map((p, i) => {
      const x = (i * stepX).toFixed(2);
      const y = (24 - ((p - min) / range) * 22).toFixed(2);
      return `${x},${y}`;
    })
    .join(" ");
  const trendUp = hist[hist.length - 1] >= hist[0];
  const color = trendUp ? "var(--gain)" : "var(--loss)";
  return `<svg viewBox="0 0 100 26" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------

el("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = el("add-input");
  const symbol = input.value.trim().toUpperCase();
  if (!symbol) return;
  input.value = "";
  try {
    await api("/watchlist", { method: "POST", body: { symbol } });
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "watch", symbol }));
    }
    await loadWatchlist();
  } catch (err) {
    showToast(err.message, "major");
  }
});

async function removeSymbol(symbol) {
  await api(`/watchlist/${encodeURIComponent(symbol)}`, { method: "DELETE" });
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "unwatch", symbol }));
  }
  state.items.delete(symbol);
  state.sparkHistory.delete(symbol);
  renderList();
}

async function ackSymbol(symbol) {
  await api(`/watchlist/${encodeURIComponent(symbol)}/ack`, { method: "POST" });
  const item = state.items.get(symbol);
  if (item && item.change) {
    item.change = { ...item.change, severity: "none", isNew: false, pctSinceLastSeen: 0, tags: [] };
    item.lastSeenPrice = item.state?.price ?? item.lastSeenPrice;
    renderList();
  }
}

el("ack-all-btn").addEventListener("click", async () => {
  await api("/watchlist/ack-all", { method: "POST" });
  await loadWatchlist();
  state.hasBannerShown = true;
  el("change-banner").classList.add("hidden");
});

// ---------------------------------------------------------------------
// Live updates over WebSocket, with reconnect + backoff
// ---------------------------------------------------------------------

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    setConnStatus("live");
    state.wsBackoffMs = 500;
  };

  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (msg.type === "tick") handleTick(msg);
    else if (msg.type === "alert") handleAlert(msg.change);
  };

  ws.onclose = () => {
    setConnStatus("down");
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  setTimeout(() => {
    connectWs();
  }, state.wsBackoffMs);
  state.wsBackoffMs = Math.min(state.wsBackoffMs * 2, 15000);
}

function setConnStatus(mode) {
  const elm = el("conn-status");
  elm.classList.remove("live", "down");
  if (mode === "live") {
    elm.textContent = "live";
    elm.classList.add("live");
  } else {
    elm.textContent = "reconnecting…";
    elm.classList.add("down");
  }
}

function handleTick(msg) {
  const item = state.items.get(msg.symbol);
  pushSparkPoint(msg.symbol, msg.price);
  if (!item) return; // not currently on this user's rendered list

  const prevPrice = item.state?.price ?? msg.price;
  item.state = {
    ...item.state,
    price: msg.price,
    dayHigh: msg.dayHigh,
    dayLow: msg.dayLow,
    volume: msg.volume,
    stale: msg.stale,
    updatedAt: msg.updatedAt,
    dayChangePct: item.state?.prevClose ? (msg.price - item.state.prevClose) / item.state.prevClose : 0,
  };
  // Recompute the "since you last checked" delta client-side against the
  // same baseline price the server gave us, so it updates live without
  // a full re-fetch on every tick.
  if (item.change && !item.change.isNew && item.lastSeenPrice != null) {
    item.change.pctSinceLastSeen = (msg.price - item.lastSeenPrice) / item.lastSeenPrice;
  }
  if (item.lastSeenPrice == null) item.lastSeenPrice = prevPrice;

  const row = document.getElementById(`row-${msg.symbol}`);
  if (row) {
    row.replaceWith(renderRow(msg.symbol));
    const fresh = document.getElementById(`row-${msg.symbol}`);
    fresh.classList.add("flash");
    setTimeout(() => fresh.classList.remove("flash"), 600);
  }
}

function handleAlert(change) {
  if (!change) return;
  showToast(
    `${change.symbol}: ${change.severity} move (${fmtPct(change.pctSinceLastSeen)}) since you last checked`,
    change.severity
  );
}

function showToast(message, severity) {
  const root = el("toast-root");
  const toast = document.createElement("div");
  toast.className = "toast " + (severity === "major" ? "major" : "");
  toast.textContent = message;
  root.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

boot();
