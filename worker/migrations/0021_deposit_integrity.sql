-- 🔒 Deposit integrity: make ONE on-chain deposit creditable to exactly ONE account.
--
-- Two check-then-act races could mint the same USDC twice (audit: worker
-- deposit double-mint, HIGH):
--   1. /pay/link-address read `SELECT … WHERE address = ? AND user_id != ?`
--      and then inserted — two concurrent links for the SAME sender address
--      both passed the read, so one address funded two accounts.
--   2. /pay/claim read `SELECT user_id FROM ledger WHERE kind='deposit' AND
--      ref = ?` and then inserted. The only DB backstop is idx_ledger_idem —
--      UNIQUE(user_id, kind, ref) — which is keyed BY USER, so the same tx
--      hash credited to two different user_ids violates nothing.
-- deposits.ts has promised a "global claimed_txs table" in its header comment
-- since PR2; it never existed. Both guards become real constraints here.

-- 1️⃣ One sender address → one account.
-- Pre-existing duplicates would make the unique index un-creatable, so unlink
-- the LATER rows first (keep the earliest claimant of each address). We NULL
-- the address instead of deleting the wallet row: the row carries chain/kind/
-- created and other code paths expect it to exist. An unlinked user can
-- re-link — and will now be told the address belongs to another account.
UPDATE wallets SET address = NULL
WHERE address IS NOT NULL
  AND rowid NOT IN (SELECT MIN(rowid) FROM wallets WHERE address IS NOT NULL GROUP BY address);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address) WHERE address IS NOT NULL;

-- 2️⃣ One deposit tx → one credit, across ALL users.
CREATE TABLE IF NOT EXISTS claimed_txs (
  tx_hash TEXT PRIMARY KEY,              -- lowercased 0x… 32-byte hash
  user_id TEXT NOT NULL,                 -- the one account that got the credit
  network TEXT,                          -- base | base-sepolia | tiny…
  created INTEGER DEFAULT (unixepoch())
);

-- Backfill from the credits already in the ledger so historical hashes stay
-- unclaimable. If the race already fired, the earliest row wins (OR IGNORE) —
-- the same account the old read-path would have reported as the claimer.
INSERT OR IGNORE INTO claimed_txs (tx_hash, user_id, network, created)
SELECT ref, user_id, REPLACE(COALESCE(counterparty, ''), 'chain:', ''), created
FROM ledger
WHERE kind = 'deposit' AND ref IS NOT NULL AND ref LIKE '0x%' AND LENGTH(ref) = 66
ORDER BY id;
