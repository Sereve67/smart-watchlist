"use strict";

/**
 * Session handling.
 *
 * This is intentionally minimal: claim a username, get a cookie, that
 * cookie is your identity. No passwords, no OAuth. That's a scope
 * decision, not an oversight - the brief is about the watchlist/change
 * system, not building auth. The cookie carries a stable userId, and
 * everything downstream (watchlist, snapshots) is keyed on that userId,
 * so plugging in real auth (magic link / OAuth / password) later only
 * means replacing how userId gets set here - the rest of the app doesn't
 * change. This is also what gives "state persists across devices": log
 * in with the same username on a second device/browser and the server
 * resolves it to the same userId, so the same watchlist and snapshots
 * appear there too.
 */

const { v4: uuid } = require("uuid");
const store = require("./store");

const COOKIE_NAME = "swid";

function attachSession(req, res, next) {
  const existing = req.cookies[COOKIE_NAME];
  if (existing && store.getUser(existing)) {
    req.userId = existing;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: "not signed in" });
  next();
}

function login(req, res) {
  const { username } = req.body || {};
  if (!username || typeof username !== "string" || !username.trim()) {
    return res.status(400).json({ error: "username required" });
  }
  const user = store.getOrCreateUser(username, uuid());
  res.cookie(COOKIE_NAME, user.id, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 90,
  });
  res.json({ userId: user.id, username: user.username });
}

module.exports = { attachSession, requireAuth, login, COOKIE_NAME };
