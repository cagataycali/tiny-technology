-- 🏅 Reputation: earned standing, NOT money.
--
-- The user's ask: "we can just give people reputation when they follow each
-- other" — so the login walls can loosen for people the network vouches for
-- (docs/e2e-gaps-report-2026-07-25.md §2).
--
-- Why a separate table instead of a `reputation` ledger kind (the report's own
-- first suggestion): balance is `SUM(delta_micro)` over ALL kinds, at five
-- money-critical sites — payments.ts balanceOf + the two invoke overdraft
-- guards, and the withdrawal debit + its withdrawable figure. A reputation row
-- in `ledger` would inflate every one of them, and the withdrawal exclusion
-- (which filters on kind='deposit' AND counterparty) wouldn't even catch it, so
-- reputation would become withdrawable real USDC. Points are not currency; they
-- do not belong in the append-only money ledger.
--
-- Append-only like the ledger, for the same reason: a score you can audit beats
-- a counter you can only trust. `ref` makes every grant idempotent —
-- follow/unfollow/re-follow farming is a no-op for free.
CREATE TABLE IF NOT EXISTS reputation (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  points  INTEGER NOT NULL,           -- positive grant (revocations are negative rows)
  kind    TEXT NOT NULL,              -- follow_received | follow_given | …
  ref     TEXT NOT NULL,              -- idempotency key, e.g. follow:<follower>:<target>
  created INTEGER DEFAULT (unixepoch())
);
-- Score = SUM(points). Reading it per profile must not scan the table.
CREATE INDEX IF NOT EXISTS idx_reputation_user ON reputation(user_id);
-- One grant per (user, kind, ref) — the whole anti-farming guard, enforced by
-- the DB rather than by a read-then-write (the shape migration 0021 had to fix
-- for deposits: a SELECT the concurrent writer can't see is not a guard).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reputation_idem ON reputation(user_id, kind, ref);
