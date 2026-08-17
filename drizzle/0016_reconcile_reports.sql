-- The most recent reconciliation pass per worker. A current-state cache, not a
-- history: drift that persists is the same finding reported again, and keeping
-- every repetition would grow without bound while telling the operator nothing
-- the latest row does not.
CREATE TABLE IF NOT EXISTS reconcile_reports (
  worker_id TEXT PRIMARY KEY NOT NULL REFERENCES workers(id),
  ran_at INTEGER NOT NULL,
  clean INTEGER NOT NULL DEFAULT 1,
  findings TEXT NOT NULL,
  errors TEXT,
  -- Hash of the actionable findings. Without it a single dead container would
  -- notify the operator every five minutes for as long as it stayed dead.
  fingerprint TEXT
);
