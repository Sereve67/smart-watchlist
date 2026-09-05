"use strict";

/**
 * Persistence layer.
 *
 * Design decision: this is a JSON-file-backed store, not Postgres/SQLite.
 * For a system of this scope (a watchlist, not a trading ledger) the data
 * is small, low-write-volume, and doesn't need relational joins or a
 * native DB driver that might fail to compile in a sandboxed environment.
 *
 * Everything is accessed through this module's functions, never through
 * raw file reads elsewhere. That means swapping this for Postgres/Redis
 * later is a one-file change, not a rewrite. In a real deployment with
 * many users and devices, this is the first thing to replace:
 *   - users/watchlist_items/snapshots -> Postgres (durable, relational)
 *   - symbol_state (hot, ephemeral)   -> Redis (shared across server
 *                                        instances, sub-ms reads)
 *
 * Concurrency: a single in-process write queue serializes writes and we
 * write-to-temp-then-rename so a crash mid-write can't corrupt the file
 * (no torn writes, no partial JSON).
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

function emptyDb() {
  return {
    users: {}, // userId -> { id, username, createdAt }
    usernames: {}, // lowercase username -> userId (uniqueness index)
    watchlists: {}, // userId -> { symbol -> { addedAt } }
    snapshots: {}, // userId -> { symbol -> lastSeenState }
  };
}

let db = emptyDb();
let writeQueue = Promise.resolve();
let dirty = false;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      db = raw.trim() ? JSON.parse(raw) : emptyDb();
    }
  } catch (err) {
    // Corrupt or unreadable file: don't crash the server, start fresh
    // but keep the broken file around for forensics.
    console.error("[store] failed to load db.json, starting fresh:", err.message);
    if (fs.existsSync(DATA_FILE)) {
      fs.renameSync(DATA_FILE, DATA_FILE + `.corrupt.${Date.now()}`);
    }
    db = emptyDb();
  }
}

function persistNow() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE); // atomic on POSIX
  dirty = false;
}

// Serialize + debounce writes so bursts of API calls don't hammer disk.
function scheduleWrite() {
  dirty = true;
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          if (dirty) persistNow();
          resolve();
        }, 50);
      })
  );
}

load();
process.on("SIGINT", () => {
  if (dirty) persistNow();
  process.exit(0);
});
process.on("SIGTERM", () => {
  if (dirty) persistNow();
  process.exit(0);
});

// ---- Users -----------------------------------------------------------

function getOrCreateUser(username, id) {
  const key = username.trim().toLowerCase();
  if (!key) throw new Error("username required");
  let userId = db.usernames[key];
  if (userId && db.users[userId]) return db.users[userId];

  userId = id;
  const user = { id: userId, username: username.trim(), createdAt: Date.now() };
  db.users[userId] = user;
  db.usernames[key] = userId;
  db.watchlists[userId] = db.watchlists[userId] || {};
  db.snapshots[userId] = db.snapshots[userId] || {};
  scheduleWrite();
  return user;
}

function getUser(userId) {
  return db.users[userId] || null;
}

// ---- Watchlist ---------------------------------------------------------

function getWatchlist(userId) {
  return db.watchlists[userId] || {};
}

function addToWatchlist(userId, symbol) {
  db.watchlists[userId] = db.watchlists[userId] || {};
  if (!db.watchlists[userId][symbol]) {
    db.watchlists[userId][symbol] = { addedAt: Date.now() };
    scheduleWrite();
  }
  return db.watchlists[userId][symbol];
}

function removeFromWatchlist(userId, symbol) {
  if (db.watchlists[userId] && db.watchlists[userId][symbol]) {
    delete db.watchlists[userId][symbol];
    if (db.snapshots[userId]) delete db.snapshots[userId][symbol];
    scheduleWrite();
    return true;
  }
  return false;
}

// All symbols any user is watching - drives which symbols the market
// simulator actually needs to compute ticks for (see marketSim.js).
function getAllWatchedSymbols() {
  const set = new Set();
  for (const uid of Object.keys(db.watchlists)) {
    for (const sym of Object.keys(db.watchlists[uid])) set.add(sym);
  }
  return set;
}

// ---- Snapshots ("what the user last saw") -----------------------------
// This is the core of "what changed since I last checked": for every
// (user, symbol) pair we remember the market state at the moment the
// user last acknowledged it. The change engine diffs live state against
// this snapshot.

function getSnapshot(userId, symbol) {
  return (db.snapshots[userId] && db.snapshots[userId][symbol]) || null;
}

function setSnapshot(userId, symbol, state) {
  db.snapshots[userId] = db.snapshots[userId] || {};
  db.snapshots[userId][symbol] = {
    price: state.price,
    volume: state.volume,
    dayHigh: state.dayHigh,
    dayLow: state.dayLow,
    fiftyTwoWkHigh: state.fiftyTwoWkHigh,
    fiftyTwoWkLow: state.fiftyTwoWkLow,
    seenAt: Date.now(),
  };
  scheduleWrite();
}

module.exports = {
  getOrCreateUser,
  getUser,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getAllWatchedSymbols,
  getSnapshot,
  setSnapshot,
};
