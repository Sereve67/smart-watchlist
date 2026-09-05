"use strict";

const http = require("http");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");

const { attachSession } = require("./auth");
const routes = require("./routes");
const wsHub = require("./wsHub");
const store = require("./store");
const marketSim = require("./marketSim");

const PORT = process.env.PORT || 8787;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(attachSession);

app.use("/api", routes);

// Serve the static frontend from the sibling /client directory.
const clientDir = path.join(__dirname, "..", "..", "client");
app.use(express.static(clientDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(clientDir, "index.html"));
});

// Basic error boundary so a route throwing doesn't crash the process.
app.use((err, req, res, next) => {
  console.error("[unhandled]", err);
  res.status(500).json({ error: "internal error" });
});

const server = http.createServer(app);
wsHub.setup(server);

server.listen(PORT, () => {
  console.log(`Smart Watchlist server running on http://localhost:${PORT}`);
});

// Safety-net sweep: reconcile which symbols the simulator should be
// ticking against what's actually on someone's watchlist. Catches any
// drift from missed cleanup paths (crashed request, process restart
// picking up persisted watchlists, etc). Cheap and idempotent, so a
// generous interval is fine.
const reconcileTimer = setInterval(() => {
  marketSim.reconcile(store.getAllWatchedSymbols());
}, 30_000);
reconcileTimer.unref();

// On boot, immediately activate every symbol already on someone's
// persisted watchlist rather than waiting for the first GET request.
marketSim.reconcile(store.getAllWatchedSymbols());
