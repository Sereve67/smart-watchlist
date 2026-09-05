# Product Pitch 

Most watchlists show prices; this one shows what's worth your attention.
Every symbol is scored against your personal last-seen snapshot, not
today's open, using a volatility-adjusted z-score so a 1.5% move means
something different for SPY than for a small-cap - plus deterministic
flags for 52-week highs/lows and volume spikes. State is server-side per
user, so the same list and "since you checked" baseline follow you across
devices. The simulated feed deliberately misbehaves (dropped updates,
disagreeing sources) so staleness and conflicts are surfaced, not hidden.
Architecture scales by distinct symbol, not by user: one shared feed per
ticker regardless of watcher count.
