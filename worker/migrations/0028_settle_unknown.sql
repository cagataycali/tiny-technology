-- 🔍 THE OTHER HALF OF THE UNKNOWN — the RECEIVER's unreconciled money.
--
-- c46–c50 closed the PAYER side: a submitted-but-unconfirmed settlement no
-- longer reverses the payer's debit (0025), the escaped instrument is nameable
-- (0026), and a per-minute resolver retires it settled-or-refunded (0027). The
-- payer's exposure is now bounded.
--
-- The receiver's is not, and it fails in the OPPOSITE direction. When our own
-- x402 door (app/api/x402/chat/<slug>) gets `settlement: unknown` back from the
-- facilitator, it returns 402 and **credits nobody**:
--
--   settlePayment → {ok:false, settlement:'unknown', txHash:<submitted hash>}
--   route         → `if (!settled.ok) return json({…, settlement}, 402)`
--
-- Step 4 ("credit the owner in the ledger, keyed by settlement tx") is never
-- reached. So if that transaction then confirms — which is the LIKELY outcome; it
-- was signed, accepted and broadcast, we merely failed to see the receipt inside
-- 60s — the payer's USDC lands at X402_PAY_TO and the tiny's owner is never paid
-- for a request that really was paid for. Not a leak: a silent creator-earnings
-- loss, and the exact failure `durableWrite` exists to prevent one line further
-- down the same function. The only trace today is a `console.error` carrying the
-- hash and nothing else — no payer, no nonce, no slug, no price, no network — so
-- even a human cannot replay it from the log. This table is that trace, made
-- queryable and complete.
--
-- ⚠️ WHY THE RECEIVER'S RESOLVER CANNOT REUSE THE PAYER'S QUESTION. c50 resolves
-- with `authorizationState(payer, nonce) → bool`. On this side that boolean is
-- NOT sufficient, and using it would MINT:
--
--   authorizationState is set to true by BOTH code paths that consume a nonce —
--   _transferWithAuthorization (TinyUSDC.sol:151, money moves) and
--   cancelAuthorization (TinyUSDC.sol:128, money does NOT move).
--
-- For the payer that ambiguity is harmless in the safe direction: true ⟹ don't
-- refund ⟹ we keep our own float. For the receiver, true ⟹ credit the owner
-- plus the platform fee out of USDC that, on a cancel, never arrived — inventing
-- balance from a bit that means "spent OR voided". A wrong answer here is a mint,
-- not a leak, which is why this migration records the row and c52 (not this
-- cycle) writes the resolver that reads PROOF OF VALUE:
--
--   AuthorizationUsed(authorizer, nonce)     emitted ONLY on transfer (line 152)
--   AuthorizationCanceled(authorizer, nonce) emitted ONLY on cancel   (line 129)
--
-- Two distinct events for the one boolean — the log says which happened when the
-- bit cannot. Both `eth_getLogs` and `eth_getTransactionReceipt` are on the
-- public proxy's allowlist (chain/rpc-proxy.mjs), so either is askable, and the
-- receipt is only usable when a hash exists (c48: a hash can exist for a tx that
-- never reached a node, and the transport-failure branch of settlePayment reports
-- `unknown` with no hash at all).
--
-- 🔍 SO THE ROW IS WRITTEN COMPLETE, ON THE FIRST TRY. The payer side needed
-- three migrations because 0025 recorded the fact, 0026 the identity it stopped
-- one field short of, and 0027 the terminal state without which the queue could
-- never drain. Every one of those columns is here from the start:
--
--   payer, nonce        the instrument's identity — the hash-free question
--   tx_hash             the submitted settlement, when one exists: the receipt
--                       question AND the ref the credit must be keyed by, so a
--                       reconciled credit is idempotent against the credit the
--                       live request would have written
--   network             CAIP-2 we matched. authorizationState/getLogs are
--                       PER-CHAIN; the network must come from the instrument,
--                       never from a deployment default
--   slug, price_micro   who gets credited and how much: /pay/credit + /pay/invoke
--                       need exactly these two plus the payer and the ref
--   value_micro         what the payer actually SIGNED for. Not decoration: the
--                       resolver must credit against the value that moved, and a
--                       payload may authorize more than the price
--   valid_before        the signed deadline. Same licence as 0026: before it,
--                       absence on-chain means "not yet"; after it, the contract's
--                       own require (TinyUSDC.sol:144) makes absence a verdict
--   resolved/resolution the terminal mark (0027's lesson) — the SETTLED outcome
--                       writes ledger rows under a DIFFERENT ref key, and the
--                       not-settled outcome writes nothing at all, so without
--                       these the queue never drains and its depth stops being
--                       the alarm
--
-- ⚠️ payer + nonce are NOT NULL, and that is an invariant rather than a wish:
-- `unknown` is only reachable AFTER the facilitator answered `isValid: true` on a
-- payload we successfully base64/JSON-decoded, so a verified authorization is in
-- hand at every call site. The endpoint rejects a mark without them (400) instead
-- of storing a half-set — the opposite of /pay/spend-sent, deliberately: there the
-- mark ITSELF was the safety fact and had to be written even with bad identity,
-- because a refused mark left a bearer-instrument guard unarmed. Here the row has
-- no purpose except to be resolved, so an unresolvable row is not a safety net;
-- it is a queue entry nobody can ever retire. The caller keeps its
-- `x402-reconcile` log line either way.
--
-- PRIMARY KEY (payer, nonce) — the instrument, not the hash. A hash may be absent
-- (transport failure) or may not be the only submission of the same authorization,
-- while (payer, nonce) is unique by EIP-3009's own single-use rule. ON CONFLICT DO
-- NOTHING at the write site: a client that retries the same signed payload must
-- not produce two rows that could each credit the owner once.
--
-- No backfill: past unknowns exist only as log lines and cannot be recovered into
-- rows with any confidence. Grep `x402-reconcile` for those.
CREATE TABLE IF NOT EXISTS settle_unknown (
  payer       TEXT NOT NULL,             -- authorization.from (lowercased)
  nonce       TEXT NOT NULL,             -- authorization.nonce, bytes32
  tx_hash     TEXT,                      -- submitted settlement, when we saw one
  slug        TEXT NOT NULL,             -- the tiny that was paid for
  price_micro INTEGER NOT NULL,          -- what the 402 challenge demanded
  value_micro INTEGER,                   -- what the payload authorized
  network     TEXT,                      -- CAIP-2 of the chain to ask
  pay_to      TEXT,                      -- where the authorization pointed
  valid_before INTEGER,                  -- the signed deadline
  created     INTEGER DEFAULT (unixepoch()),
  resolved    INTEGER,                   -- terminal mark (unixepoch)
  resolution  TEXT,                      -- 'credited' | 'not_settled' | 'cancelled'
  PRIMARY KEY (payer, nonce)
);
-- The resolver's access pattern, on a per-minute cron across every payment ever
-- taken: "which unknowns are still open, oldest first?" Without this it table-
-- scans, and the scan grows with lifetime volume rather than with the backlog.
CREATE INDEX IF NOT EXISTS idx_settle_unknown_open ON settle_unknown(resolved, created);
