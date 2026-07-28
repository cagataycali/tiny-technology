-- 💸 Self-serve withdrawals (fully automatic — no human approval).
-- State machine: pending → paid | failed(refunded). The ledger debit
-- happens ATOMICALLY with the pending row; a failed broadcast refunds.
CREATE TABLE IF NOT EXISTS withdrawals (
  id           TEXT PRIMARY KEY,           -- uuid
  user_id      TEXT NOT NULL,
  amount_micro INTEGER NOT NULL,           -- gross (incl. fee)
  fee_micro    INTEGER NOT NULL DEFAULT 0,
  to_address   TEXT NOT NULL,              -- the user's LINKED address only
  network      TEXT NOT NULL DEFAULT 'base',
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed
  tx_hash      TEXT,
  error        TEXT,
  created      INTEGER DEFAULT (unixepoch()),
  updated      INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, created);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
