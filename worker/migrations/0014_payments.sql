-- 💸 Payments (docs/payments-x402-erc8004.md PR1): ledger-core, chain-at-edges.
-- Balances live HERE (micro-USDC, 1e6 = $1); the chain is only the settlement
-- layer at deposit/withdraw/x402 boundaries (later PRs).

-- One wallet row per user, created lazily at first payment touch.
CREATE TABLE IF NOT EXISTS wallets (
  user_id     TEXT PRIMARY KEY,
  address     TEXT,                       -- deposit address (PR2+); NULL in ledger phase
  chain       TEXT DEFAULT 'eip155:8453', -- CAIP-2, Base
  kind        TEXT DEFAULT 'ledger',      -- ledger | smart_account (PR5)
  created     INTEGER DEFAULT (unixepoch())
);

-- Append-only ledger. Balance = SUM(delta_micro). Every money movement is a
-- row; refunds are compensating rows, never deletes.
CREATE TABLE IF NOT EXISTS ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  delta_micro  INTEGER NOT NULL,          -- +credit / -debit, micro-USDC
  kind         TEXT NOT NULL,             -- deposit | invoke_debit | invoke_credit | platform_fee | withdrawal | refund | admin_credit
  ref          TEXT,                      -- invocation id / tx hash / job id
  counterparty TEXT,                      -- other user_id or 'platform'
  created      INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created);
-- Idempotency: one debit/credit per (kind, ref, user) — retried /pay/invoke
-- calls with the same invocation id can never double-charge.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idem ON ledger(user_id, kind, ref) WHERE ref IS NOT NULL;

-- Prices: owners monetize tinys and forged tools. resource is
-- 'tiny:<name>' or 'tool:<owner_login>/<tool_name>'.
CREATE TABLE IF NOT EXISTS prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    TEXT NOT NULL,
  resource    TEXT NOT NULL UNIQUE,
  price_micro INTEGER NOT NULL,           -- per invocation
  active      INTEGER DEFAULT 1,
  created     INTEGER DEFAULT (unixepoch()),
  updated     INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_prices_owner ON prices(owner_id);
