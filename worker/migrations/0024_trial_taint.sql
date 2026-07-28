-- 🧪→💵 TRIAL TAINT: the third real-value exit (loop item c-f's last prerequisite).
--
-- c-d closed withdrawals and /pay/spend: both real-value exits subtract a user's
-- own unspent TRIAL deposits (Sepolia faucet USDC, and the self-hosted chain's
-- TinyUSDC which we mint outright) from what they may take out. Both derive the
-- exclusion from ONE shared fragment so a new trial network can't leave one open.
--
-- But the exclusion keys on `user_id` AND `kind='deposit'`, and there is a path
-- that moves value to a DIFFERENT user under a different kind:
--
--   A mints/faucets trial USDC → claims it → invokes B's paid tiny with it
--   → B receives `invoke_credit`, which nothing excludes → B withdraws REAL USDC
--
-- Two accounts (both free) launder minted money into a payout. It was bounded
-- only by TRIAL_CAP_MICRO ($1 lifetime) — which is precisely the constant the
-- gamified faucet (c-f) exists to raise. So it must close BEFORE the cap moves.
--
-- The fix is taint propagation: when a paid invocation is funded by trial
-- balance, record that many micro-USDC as tainted ON THE PAYEE, and add the
-- tainted total to the same shared exclusion fragment both exits already embed.
-- Trial money then stays spendable inside the economy (the point of a trial) and
-- can never leave it, however many hops it takes — a payee's taint counts toward
-- the taint they pass on, so relaying through a third account gains nothing.
--
-- Why its own table and not a ledger kind — the same reason migration 0022 gave
-- for reputation: balance is `SUM(delta_micro)` over ALL kinds at five
-- money-critical sites, so any row here would inflate every balance, guard and
-- reported figure. Taint is an ANNOTATION on money that already moved, not a
-- movement. It must not be summable as currency.
--
-- Deliberately conservative, exactly like the deposit term it joins: A's trial
-- deposit total is unchanged by spending it (the exclusion can't tell WHICH
-- dollars left), so the same value is excluded from A and from B. That
-- over-excludes rather than under-excludes — the platform never loses real USDC,
-- and no user is ever charged real money for it.
CREATE TABLE IF NOT EXISTS trial_taint (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,             -- who received trial-funded value
  micro   INTEGER NOT NULL,          -- positive taint; reversals are negative rows
  kind    TEXT NOT NULL,             -- invoke | refund
  ref     TEXT NOT NULL,             -- the invocation id that carried it
  created INTEGER DEFAULT (unixepoch())
);
-- Every exit sums this per user on every guarded write — it cannot table-scan.
CREATE INDEX IF NOT EXISTS idx_trial_taint_user ON trial_taint(user_id);
-- One taint row per (user, kind, ref): a retried /pay/invoke with the same ref
-- is already an idempotent no-op on the ledger, and must be one here too or a
-- retry would double-taint the payee. Enforced by the DB rather than a preceding
-- SELECT — the shape migration 0021 had to fix for deposits (a read a concurrent
-- writer can't see is not a guard). The `kind` split is what lets /pay/refund
-- write a compensating NEGATIVE row under the SAME ref without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_taint_idem ON trial_taint(user_id, kind, ref);
