🚀 **Live Demo:** [Smart Watchlist](https://smart-watchlist-1pv3.onrender.com)

# Smart Watchlist

A market watchlist that tracks what changed since you last checked, not just
current prices — with volatility-adjusted significance scoring, live updates,
and cross-device sync.

---

## Quick Start

**Requirements:** Node.js 18+

```bash
cd server
npm install
npm start
```

Open **http://localhost:8787**

1. Enter any username (no password required — see [Auth](#auth)) → **Continue**
2. Add symbols: `AAPL`, `TSLA`, `NVDA`, `META`, `BTC-USD`, `ETH-USD` (or others)
3. Watch prices update live over WebSocket
4. Click a row to mark it reviewed, or **Mark all reviewed** to clear the whole list
5. To test cross-device sync: open an incognito window, log in with the **same username** → same watchlist appears

No API keys needed. Market data is simulated in-process, so this runs fully offline.

To stop: `Ctrl+C`. To reset all data: delete `server/data/db.json`.

---

## What This Solves

Most watchlists show you prices and let you eyeball what changed. That
breaks down two ways:

- A calm stock moving 1.5% in a week is a big deal — but gets buried next to daily noise.
- A volatile stock moving 1.5% is nothing — but a fixed "alert at 2%" threshold either fires constantly or misses real outliers.

This app scores every move **relative to that symbol's own recent volatility**
(a z-score, not a flat %), so "meaningful" means something different — correctly — for SPY than for a small-cap.

---

## Core Features

| Feature | How it works |
|---|---|
| **Meaningful change detection** | Volatility-adjusted z-score vs. each symbol's own recent realized volatility, plus deterministic flags for 52-week high/low crossings and volume spikes |
| **Severity levels** | `notable` / `significant` / `major` — bucketed so it's scannable at a glance |
| **"Since you last checked" diff** | A real per-user, per-symbol snapshot (price, volume, day range) saved at the moment you last acknowledged it — not "today's change" |
| **Live updates** | WebSocket push with automatic reconnect + backoff |
| **Cross-device sync** | Same username → same server-side watchlist and snapshots, from any browser/device |
| **Stale/conflicting data handling** | Two simulated upstream sources per symbol reconcile on disagreement; missed updates are flagged `stale` rather than papered over |
| **Reviewed vs. seen** | Loading the page shows a diff; it doesn't silently clear it. You explicitly ack a row or ack-all |

---

## API Reference

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/session` | Log in / create user (`{ username }`) |
| `GET` | `/api/me` | Current user |
| `GET` | `/api/watchlist` | List items with live state + change-since-last-seen |
| `POST` | `/api/watchlist` | Add symbol (`{ symbol }`) |
| `DELETE` | `/api/watchlist/:symbol` | Remove symbol |
| `POST` | `/api/watchlist/:symbol/ack` | Mark one symbol reviewed (resets its baseline) |
| `POST` | `/api/watchlist/ack-all` | Mark everything reviewed |
| `GET` | `/api/symbols/search?q=` | Symbol search/autocomplete |
| `WS` | `/ws` | Live tick + significance-alert push |

---

## Project Structure

```
server/
  src/
    index.js         Entry point, wiring, periodic reconcile sweep
    store.js          Persistence: users, watchlists, "last seen" snapshots
    marketSim.js       Simulated market feed: dual-source, staleness, volatility regimes
    changeEngine.js    Significance scoring ("what counts as meaningful")
    wsHub.js           WebSocket fan-out of live ticks + alerts
    routes.js          REST API
    auth.js            Minimal cookie-based session
  data/db.json         Created on first run (gitignored)
client/
  index.html
  app.js               Framework-free UI logic
  style.css
```

---

## Key Design Decisions

**Significance is volatility-adjusted, not a flat threshold.**
Each symbol's recent realized volatility (stdev of returns) is the yardstick. A z-score of 2+ means "unusual for *this* symbol" — see `changeEngine.js`.

**"Since last checked" is a real per-user snapshot, not "today's change."**
Stored server-side per `(user, symbol)`, updated only on explicit ack — see `store.js`.

**Scales by distinct symbol watched, not by user count.**
A symbol only ticks while ≥1 user anywhere is watching it (`marketSim.reconcile`, driven off `store.getAllWatchedSymbols()`). 10,000 users watching AAPL = one feed, not 10,000. Deactivation is a periodic reconciliation sweep against the store, not manual subscribe/unsubscribe reference-counting across REST + WebSocket — that combination is a classic source of leaks and double-counts.

**Stale and conflicting data are surfaced, never hidden.**
Two simulated sources per symbol occasionally disagree (real vendors do); the fresher/available one wins deterministically, disagreements are logged, and a symbol with no recent update from either source is flagged `stale` rather than shown a fake-fresh price.

**Auth is a username claim, no password.**
Out of scope for this brief. The cookie carries a stable user ID that everything else is built against, so real auth (magic link/OAuth) is a drop-in replacement for `auth.js` alone — nothing else changes.

**No frontend framework.**
The server decides severity/diffs/staleness; the client just renders it. A build step would add ceremony without adding real interaction complexity at this scope.

**JSON-file store, not a database engine.**
Avoids a native dependency that might not compile in a constrained environment. Data volume/shape doesn't need a real DB yet — but `store.js` exposes the same functions a Postgres-backed version would, so swapping it later is a one-file change.

**Simulated market data, not a live API.**
No API key available in this environment. The simulator can be told to misbehave (volatility bursts, dropped ticks, source disagreement) on demand, which is arguably more useful for demoing resilience than a real feed you can't force to gap 4% on cue. Its interface (`ensureActive`, `getState`, `on('tick', ...)`) mirrors what a real provider adapter would expose, so replacing it is contained to `marketSim.js`.

<a id="auth"></a>

---

## Scaling Past a Single Server

This runs as a single process today (in-memory simulator state, JSON-file
store) — the right call for a prototype at this scope, wrong call past one
instance. Two swap points if it needed to run on more than one server:

1. **Market state/pub-sub → Redis.** Tick fan-out is an in-process EventEmitter today; a second instance wouldn't see ticks from the first. Redis pub/sub fixes that without touching `changeEngine.js` at all.
2. **Durable data → Postgres.** Users/watchlists/snapshots are small and relational — a good fit once multiple app servers need to read/write them concurrently.

---

## What's Next

- Real provider adapter (Finnhub/Polygon) behind the same `marketSim` interface
- Per-user configurable significance sensitivity (some want every `notable`, some only `major`)
- Email/push digest for users who don't open the app for days
