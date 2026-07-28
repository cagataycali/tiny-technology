-- 🤖 Endpoint devices (docs/endpoint-devices-vision-2026-07-25.md phase 1).
--
-- Until now every device DIALED IN: it held a `tind_` token, heartbeat every
-- 30s and polled the relay mailbox. A robot/printer running its own always-on
-- dashboard behind WebAuthn (neon/scout/printer.example.com) can't do that — it
-- is a server, not a client. So `kind='endpoint'` inverts the direction: tiny
-- dials OUT to `url` carrying `secret` as a bearer token.
--
-- Purely additive: two nullable columns on the existing table, so pull-mode
-- devices are untouched and the 20-device cap / revoke / capabilities model is
-- shared. `token_hash` stays NOT NULL at the schema level (D1 can't drop the
-- constraint without a table rebuild); endpoint rows store the sentinel
-- '' — they have no inbound token because nothing ever authenticates INTO them.
--
-- `secret` is a bearer credential at rest. It is never returned by any list or
-- get route — the same rule the per-tiny MCP `headers` follow.

ALTER TABLE devices ADD COLUMN url TEXT;
ALTER TABLE devices ADD COLUMN secret TEXT;
