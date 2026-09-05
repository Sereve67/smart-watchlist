"use strict";

/**
 * Market data source.
 *
 * There's no live-market API key available in this environment, so this
 * module simulates one. It's deliberately built to *look and misbehave*
 * like a real feed, and it's written behind the same shape a real
 * provider adapter would have (subscribe/unsubscribe/getState/onTick),
 * so swapping in Finnhub/Polygon/IEX later means replacing this file,
 * not the rest of the system.
 *
 * Things this simulates on purpose, because a real system has to handle
 * them:
 *   1. Lazy computation - a symbol only "ticks" while at least one user
 *      is watching it (see subscribe/unsubscribe). This is the scaling
 *      lever: cost is O(distinct symbols watched), not O(users) or
 *      O(users x symbols). 10,000 users all watching AAPL is one feed,
 *      not 10,000.
 *   2. Two upstream sources per symbol that occasionally disagree
 *      (real vendors do). Reconciliation policy: prefer the fresher
 *      source; on a tie prefer primary; log every disagreement.
 *   3. Provider hiccups - a source can silently stop updating. We track
 *      per-source last-update time and mark the symbol `stale` once it
 *      exceeds STALE_THRESHOLD_MS, rather than serving a fake fresh
 *      price.
 *   4. Volatility regimes - most ticks are small drift/noise, but each
 *      symbol occasionally enters a short "event" burst (bigger moves +
 *      volume spike), which is what should actually trigger a
 *      "meaningful change" alert downstream.
 */

const EventEmitter = require("events");

const TICK_MS = 1500;
const STALE_THRESHOLD_MS = TICK_MS * 5; // no update in 7.5s -> stale
const RETURNS_WINDOW = 30; // ring buffer for realized volatility

const SEED_SYMBOLS = {
  AAPL: { price: 227.5, baseVol: 0.006 },
  MSFT: { price: 415.2, baseVol: 0.006 },
  GOOGL: { price: 168.4, baseVol: 0.007 },
  AMZN: { price: 186.3, baseVol: 0.008 },
  NVDA: { price: 118.7, baseVol: 0.014 },
  META: { price: 512.9, baseVol: 0.009 },
  TSLA: { price: 214.6, baseVol: 0.02 },
  NFLX: { price: 675.1, baseVol: 0.01 },
  AMD: { price: 141.2, baseVol: 0.016 },
  SPY: { price: 552.3, baseVol: 0.003 },
  "BTC-USD": { price: 62150, baseVol: 0.018 },
  "ETH-USD": { price: 2610, baseVol: 0.022 },
};

class MarketSim extends EventEmitter {
  constructor() {
    super();
    this.symbols = new Map(); // symbol -> state
    this.timers = new Map(); // symbol -> interval handle (only symbols actively ticking)
    this.conflictLog = []; // recent source disagreements (observability)
  }

  knownSymbols() {
    return Object.keys(SEED_SYMBOLS);
  }

  _initSymbol(symbol) {
    if (this.symbols.has(symbol)) return this.symbols.get(symbol);
    const seed = SEED_SYMBOLS[symbol] || {
      price: 50 + Math.random() * 200,
      baseVol: 0.01,
    };
    const now = Date.now();
    const state = {
      symbol,
      price: seed.price,
      prevClose: seed.price,
      dayOpen: seed.price,
      dayHigh: seed.price,
      dayLow: seed.price,
      volume: 0,
      avgVolume: 1_000_000 + Math.random() * 4_000_000,
      fiftyTwoWkHigh: seed.price * (1 + 0.15 + Math.random() * 0.1),
      fiftyTwoWkLow: seed.price * (1 - 0.15 - Math.random() * 0.1),
      returns: [], // ring buffer of recent log returns, for realized vol
      baseVol: seed.baseVol,
      regime: "normal", // "normal" | "event"
      regimeTicksLeft: 0,
      updatedAt: now,
      stale: false,
      // dual-source bookkeeping
      sources: {
        primary: { lastUpdate: now },
        secondary: { lastUpdate: now },
      },
      lastReconciledFrom: "primary",
    };
    this.symbols.set(symbol, state);
    return state;
  }

  getState(symbol) {
    return this.symbols.get(symbol) || null;
  }

  // Idempotent: make sure `symbol` is initialized and ticking. Safe to
  // call from many places (REST handlers, WS connect) without needing
  // to pair each call with a matching "unsubscribe" - see reconcile()
  // for how deactivation actually happens. This sidesteps a real bug
  // class: reference-counting subscribe/unsubscribe calls that
  // originate from two different subsystems (HTTP requests and
  // WebSocket lifecycles) is easy to get wrong (double-counts, leaks
  // on error paths, etc). A idempotent "ensure on" plus a periodic
  // "reconcile against source of truth" is simpler and self-healing.
  ensureActive(symbol) {
    this._initSymbol(symbol);
    this._startTicking(symbol);
    return this.symbols.get(symbol);
  }

  // Stop ticking one symbol immediately (used when a delete makes a
  // symbol unwatched by anyone, for prompt cleanup rather than waiting
  // for the next sweep).
  deactivate(symbol) {
    this._stopTicking(symbol);
  }

  // Source-of-truth reconciliation: given the full set of symbols any
  // user is currently watching (from the store), start ticking anything
  // missing and stop ticking anything nobody watches anymore. Called
  // immediately after mutations and on a periodic sweep as a safety net
  // against any missed cleanup (e.g. a crashed request mid-flight).
  reconcile(activeSymbols) {
    for (const symbol of activeSymbols) this.ensureActive(symbol);
    for (const symbol of this.timers.keys()) {
      if (!activeSymbols.has(symbol)) this._stopTicking(symbol);
    }
  }

  _startTicking(symbol) {
    if (this.timers.has(symbol)) return;
    const handle = setInterval(() => this._tick(symbol), TICK_MS);
    if (handle.unref) handle.unref();
    this.timers.set(symbol, handle);
  }

  _stopTicking(symbol) {
    const handle = this.timers.get(symbol);
    if (handle) clearInterval(handle);
    this.timers.delete(symbol);
  }

  _tick(symbol) {
    const state = this.symbols.get(symbol);
    if (!state) return;
    const now = Date.now();

    // --- simulate provider hiccups: each source independently has a
    // small chance of missing this tick entirely (network blip, vendor
    // outage). We never fabricate a price for a missed update.
    const primaryOk = Math.random() > 0.03; // ~3% miss rate
    const secondaryOk = Math.random() > 0.05;

    // --- occasionally enter/continue a volatility "event" regime, the
    // thing that should actually read as a meaningful change downstream.
    if (state.regimeTicksLeft > 0) {
      state.regimeTicksLeft -= 1;
      if (state.regimeTicksLeft === 0) state.regime = "normal";
    } else if (Math.random() < 0.006) {
      state.regime = "event";
      state.regimeTicksLeft = 4 + Math.floor(Math.random() * 8);
    }

    const vol = state.regime === "event" ? state.baseVol * 5 : state.baseVol;
    const drift = state.regime === "event" ? (Math.random() - 0.45) * vol : 0;

    const computeCandidate = (jitter) => {
      const shock = (Math.random() - 0.5) * 2 * vol + drift;
      const logReturn = shock + jitter;
      return {
        price: Math.max(0.01, state.price * (1 + logReturn)),
        logReturn,
      };
    };

    // Two independent "vendor" readings that usually agree closely.
    const primary = primaryOk ? computeCandidate(0) : null;
    const secondary = secondaryOk ? computeCandidate((Math.random() - 0.5) * vol * 0.15) : null;

    if (primary) state.sources.primary.lastUpdate = now;
    if (secondary) state.sources.secondary.lastUpdate = now;

    // --- reconciliation: prefer the fresher/available source; if both
    // are available and disagree by more than a small tolerance, log it
    // (this is where you'd page someone / flip to a third source in
    // production) but still resolve deterministically so the UI never
    // blocks on a data disagreement.
    let chosen = null;
    let chosenFrom = null;
    if (primary && secondary) {
      const disagreementPct = Math.abs(primary.price - secondary.price) / primary.price;
      if (disagreementPct > 0.004) {
        this._logConflict(symbol, primary.price, secondary.price, disagreementPct);
      }
      chosen = primary; // primary wins ties/small disagreements
      chosenFrom = "primary";
    } else if (primary) {
      chosen = primary;
      chosenFrom = "primary";
    } else if (secondary) {
      chosen = secondary;
      chosenFrom = "secondary";
    }

    if (!chosen) {
      // Both sources missed this tick entirely - leave price untouched,
      // just let staleness bookkeeping below reflect it.
      this._refreshStaleFlag(state, now);
      return;
    }

    const volumeThisTick = Math.max(
      0,
      state.avgVolume / (86400 / (TICK_MS / 1000)) * (state.regime === "event" ? 4 + Math.random() * 4 : 0.5 + Math.random())
    );

    state.price = Number(chosen.price.toFixed(2));
    state.dayHigh = Math.max(state.dayHigh, state.price);
    state.dayLow = Math.min(state.dayLow, state.price);
    state.fiftyTwoWkHigh = Math.max(state.fiftyTwoWkHigh, state.price);
    state.fiftyTwoWkLow = Math.min(state.fiftyTwoWkLow, state.price);
    state.volume += volumeThisTick;
    state.returns.push(chosen.logReturn);
    if (state.returns.length > RETURNS_WINDOW) state.returns.shift();
    state.lastReconciledFrom = chosenFrom;
    state.updatedAt = now;
    this._refreshStaleFlag(state, now);

    this.emit("tick", symbol, state);
  }

  _refreshStaleFlag(state, now) {
    state.stale = now - state.updatedAt > STALE_THRESHOLD_MS;
  }

  _logConflict(symbol, p1, p2, pct) {
    const entry = { symbol, primary: p1, secondary: p2, pct, at: Date.now() };
    this.conflictLog.push(entry);
    if (this.conflictLog.length > 200) this.conflictLog.shift();
  }

  // Realized volatility (stdev of recent log returns) - the yardstick
  // the change engine uses so a 1% move means something different for
  // SPY than it does for a meme-volatile name.
  realizedVol(symbol) {
    const state = this.symbols.get(symbol);
    if (!state || state.returns.length < 3) return null;
    const r = state.returns;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length;
    return Math.sqrt(variance) || null;
  }
}

module.exports = new MarketSim();
