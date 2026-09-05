"use strict";

/**
 * "What actually deserves my attention?"
 *
 * The obvious watchlist shows raw % change and lets the user eyeball it.
 * The problem: a flat 2% move means something totally different for SPY
 * (a calm index, 2% is a big day) than for a name whose normal daily
 * noise is 4-5%. A fixed threshold ("alert if move > 2%") is either
 * noisy for volatile names or numb for calm ones.
 *
 * So significance here is volatility-adjusted: we compare the move
 * since the user's last-seen snapshot to that symbol's own recent
 * realized volatility (a rolling z-score), not to a magic constant.
 * On top of that we layer a few discrete, unambiguous triggers that are
 * meaningful regardless of volatility: crossing a 52-week high/low, and
 * an unusual volume ratio.
 */

const marketSim = require("./marketSim");

const SEVERITY = { NONE: "none", NOTABLE: "notable", SIGNIFICANT: "significant", MAJOR: "major" };

function computeChange(symbol, liveState, snapshot) {
  if (!liveState) return null;

  if (!snapshot) {
    // First time this user has ever watched this symbol - nothing to
    // diff against yet. Not "no change", just "no baseline".
    return {
      symbol,
      severity: SEVERITY.NONE,
      isNew: true,
      pctSinceLastSeen: null,
      zScore: null,
      tags: [],
      stale: liveState.stale,
    };
  }

  const pctSinceLastSeen = (liveState.price - snapshot.price) / snapshot.price;
  const realizedVol = marketSim.realizedVol(symbol);
  // Fallback vol for symbols with too little tick history yet - use the
  // symbol's configured base volatility rather than divide-by-zero into
  // an artificially huge z-score.
  const vol = realizedVol || liveState.baseVol || 0.01;
  const zScore = vol > 0 ? pctSinceLastSeen / vol : 0;

  const volumeRatio = snapshot.volume != null && liveState.avgVolume
    ? Math.max(0, liveState.volume - snapshot.volume) / (liveState.avgVolume * 0.02 || 1)
    : 0;

  const tags = [];
  const crossedFiftyTwoHigh =
    liveState.price >= liveState.fiftyTwoWkHigh && snapshot.price < snapshot.fiftyTwoWkHigh;
  const crossedFiftyTwoLow =
    liveState.price <= liveState.fiftyTwoWkLow && snapshot.price > snapshot.fiftyTwoWkLow;
  if (crossedFiftyTwoHigh) tags.push("52w-high");
  if (crossedFiftyTwoLow) tags.push("52w-low");
  if (volumeRatio >= 2) tags.push("volume-spike");
  if (Math.abs(zScore) >= 2) tags.push(pctSinceLastSeen > 0 ? "outsized-gain" : "outsized-drop");
  if (liveState.stale) tags.push("stale-data");

  let severity = SEVERITY.NONE;
  if (crossedFiftyTwoHigh || crossedFiftyTwoLow || Math.abs(zScore) >= 3 || volumeRatio >= 5) {
    severity = SEVERITY.MAJOR;
  } else if (Math.abs(zScore) >= 2 || volumeRatio >= 3) {
    severity = SEVERITY.SIGNIFICANT;
  } else if (Math.abs(zScore) >= 1 || volumeRatio >= 2) {
    severity = SEVERITY.NOTABLE;
  }

  return {
    symbol,
    severity,
    isNew: false,
    snapshotPrice: snapshot.price,
    pctSinceLastSeen,
    zScore: Number(zScore.toFixed(2)),
    volumeRatio: Number(volumeRatio.toFixed(2)),
    tags,
    stale: liveState.stale,
    sinceMs: Date.now() - snapshot.seenAt,
  };
}

module.exports = { computeChange, SEVERITY };
