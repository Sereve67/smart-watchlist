"use strict";

const express = require("express");
const store = require("./store");
const marketSim = require("./marketSim");
const { computeChange } = require("./changeEngine");
const { requireAuth, login } = require("./auth");

const router = express.Router();

router.post("/session", login);

router.get("/me", requireAuth, (req, res) => {
  const user = store.getUser(req.userId);
  res.json({ userId: user.id, username: user.username });
});

router.get("/symbols/search", (req, res) => {
  const q = (req.query.q || "").toString().toUpperCase();
  const results = marketSim
    .knownSymbols()
    .filter((s) => s.includes(q))
    .slice(0, 8);
  res.json({ results });
});

function serializeState(state) {
  if (!state) return null;
  return {
    price: state.price,
    dayOpen: state.dayOpen,
    dayHigh: state.dayHigh,
    dayLow: state.dayLow,
    prevClose: state.prevClose,
    volume: Math.round(state.volume),
    avgVolume: Math.round(state.avgVolume),
    fiftyTwoWkHigh: Number(state.fiftyTwoWkHigh.toFixed(2)),
    fiftyTwoWkLow: Number(state.fiftyTwoWkLow.toFixed(2)),
    dayChangePct: (state.price - state.prevClose) / state.prevClose,
    regime: state.regime,
    stale: state.stale,
    updatedAt: state.updatedAt,
    reconciledFrom: state.lastReconciledFrom,
  };
}

// GET the watchlist with live state + "what changed since you last saw
// this" diff for every item. Deliberately does NOT update snapshots -
// viewing is not the same as acknowledging (see /ack below). This is
// what lets the UI show a "5 things changed since your last visit"
// banner rather than silently erasing the diff the instant the page loads.
router.get("/watchlist", requireAuth, (req, res) => {
  const watchlist = store.getWatchlist(req.userId);
  const items = Object.keys(watchlist).map((symbol) => {
    const state = marketSim.ensureActive(symbol); // idempotent: make sure it's ticking
    const snapshot = store.getSnapshot(req.userId, symbol);
    const change = computeChange(symbol, state, snapshot);
    return {
      symbol,
      addedAt: watchlist[symbol].addedAt,
      state: serializeState(state),
      change,
    };
  });
  res.json({ items });
});

router.post("/watchlist", requireAuth, (req, res) => {
  const symbol = (req.body?.symbol || "").toString().trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  if (symbol.length > 12) return res.status(400).json({ error: "invalid symbol" });

  store.addToWatchlist(req.userId, symbol);
  const state = marketSim.ensureActive(symbol);
  // First time seeing it: snapshot immediately so the item doesn't show
  // a spurious "changed" diff against a baseline that never existed.
  if (!store.getSnapshot(req.userId, symbol)) {
    store.setSnapshot(req.userId, symbol, state);
  }
  res.status(201).json({ symbol, state: serializeState(state) });
});

router.delete("/watchlist/:symbol", requireAuth, (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const removed = store.removeFromWatchlist(req.userId, symbol);
  // Only stop ticking if nobody else is watching it anymore - it's a
  // shared feed, not one per user (see marketSim.reconcile).
  if (removed && !store.getAllWatchedSymbols().has(symbol)) {
    marketSim.deactivate(symbol);
  }
  res.json({ removed });
});

// Mark one item as reviewed: snapshot its current live state as the new
// baseline for future "what changed" comparisons.
// Uses ensureActive() rather than getState() so this still works right
// after a server restart, before any GET /watchlist has re-initialized
// the (in-memory, intentionally non-persisted) market simulator state
// for this symbol - acking shouldn't depend on load order.
router.post("/watchlist/:symbol/ack", requireAuth, (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const watchlist = store.getWatchlist(req.userId);
  if (!watchlist[symbol]) return res.status(404).json({ error: "not on watchlist" });
  const state = marketSim.ensureActive(symbol);
  store.setSnapshot(req.userId, symbol, state);
  res.json({ ok: true });
});

router.post("/watchlist/ack-all", requireAuth, (req, res) => {
  const watchlist = store.getWatchlist(req.userId);
  for (const symbol of Object.keys(watchlist)) {
    const state = marketSim.ensureActive(symbol);
    store.setSnapshot(req.userId, symbol, state);
  }
  res.json({ ok: true });
});

module.exports = router;
