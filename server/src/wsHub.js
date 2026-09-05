"use strict";

/**
 * Live push layer.
 *
 * One WebSocket connection per browser tab. Each connection is tagged
 * with the user's watchlist symbols; on every simulated tick we fan the
 * update out only to connections that actually care about that symbol
 * (not a broadcast-to-everyone). We also compute significance on the
 * fly for *already-acknowledged* items so a user actively looking at
 * their list gets a live "this just became significant" nudge, which is
 * a different thing from the "changed since you were last here" diff
 * computed on load (see routes.js) - one is a live alert, the other is
 * a return-visit summary.
 *
 * Scaling note: this hub is single-process (an in-memory Map of
 * sockets). Running multiple server instances behind a load balancer
 * would need a shared pub/sub (Redis) so a tick handled by instance A
 * still reaches a client connected to instance B. The marketSim/hub
 * boundary here is drawn so that swap is localized to this file.
 */

const WebSocket = require("ws");
const url = require("url");
const cookie = require("cookie");
const store = require("./store");
const marketSim = require("./marketSim");
const { computeChange } = require("./changeEngine");
const { COOKIE_NAME } = require("./auth");

function setup(server) {
  const wss = new WebSocket.Server({ noServer: true });

  // userId -> Set<ws>
  const userConnections = new Map();
  // symbol -> Set<ws> (only connections currently watching it)
  const symbolConnections = new Map();

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = url.parse(req.url);
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const cookies = cookie.parse(req.headers.cookie || "");
    const userId = cookies[COOKIE_NAME];
    const user = userId && store.getUser(userId);
    if (!user) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = userId;
      ws.watchedSymbols = new Set();
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    if (!userConnections.has(ws.userId)) userConnections.set(ws.userId, new Set());
    userConnections.get(ws.userId).add(ws);

    // On connect, subscribe this socket to everything currently on the
    // user's watchlist (server-authoritative - client doesn't tell us
    // what to watch, it just reflects what's in the store).
    const watchlist = store.getWatchlist(ws.userId);
    for (const symbol of Object.keys(watchlist)) {
      watchSymbolForConnection(ws, symbol);
    }

    ws.on("message", (raw) => {
      // Only message we accept from the client: "I just added/removed a
      // symbol elsewhere, please (un)watch it on this socket too."
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "watch" && typeof msg.symbol === "string") {
          watchSymbolForConnection(ws, msg.symbol);
        } else if (msg.type === "unwatch" && typeof msg.symbol === "string") {
          unwatchSymbolForConnection(ws, msg.symbol);
        }
      } catch {
        // ignore malformed client messages rather than dropping the connection
      }
    });

    ws.on("close", () => {
      for (const symbol of ws.watchedSymbols) {
        symbolConnections.get(symbol)?.delete(ws);
      }
      userConnections.get(ws.userId)?.delete(ws);
      // Note: we deliberately don't deactivate the simulator here. This
      // socket closing doesn't mean nobody watches the symbol anymore -
      // another tab, another user, or a pending REST session might. The
      // periodic reconcile() sweep (see index.js) is the single source
      // of truth for when a symbol should stop ticking.
    });

    ws.send(JSON.stringify({ type: "hello" }));
  });

  function watchSymbolForConnection(ws, symbol) {
    if (ws.watchedSymbols.has(symbol)) return;
    ws.watchedSymbols.add(symbol);
    marketSim.ensureActive(symbol); // idempotent; see marketSim.reconcile for shutdown
    if (!symbolConnections.has(symbol)) symbolConnections.set(symbol, new Set());
    symbolConnections.get(symbol).add(ws);
  }

  function unwatchSymbolForConnection(ws, symbol) {
    if (!ws.watchedSymbols.has(symbol)) return;
    ws.watchedSymbols.delete(symbol);
    symbolConnections.get(symbol)?.delete(ws);
  }

  marketSim.on("tick", (symbol, state) => {
    const conns = symbolConnections.get(symbol);
    if (!conns || conns.size === 0) return;

    for (const ws of conns) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      const tickMsg = {
        type: "tick",
        symbol,
        price: state.price,
        dayHigh: state.dayHigh,
        dayLow: state.dayLow,
        volume: Math.round(state.volume),
        stale: state.stale,
        updatedAt: state.updatedAt,
      };
      ws.send(JSON.stringify(tickMsg));

      // Live significance nudge against this user's *acknowledged*
      // snapshot - lets an open tab surface "this just went significant"
      // without the user needing to refresh.
      const snapshot = store.getSnapshot(ws.userId, symbol);
      if (snapshot) {
        const change = computeChange(symbol, state, snapshot);
        if (change && (change.severity === "significant" || change.severity === "major")) {
          ws.send(JSON.stringify({ type: "alert", change }));
        }
      }
    }
  });

  return wss;
}

module.exports = { setup };
