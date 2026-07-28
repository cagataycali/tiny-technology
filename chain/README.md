# tiny-chain — run your own EVM chain for the closed-loop economy

tiny's payment system speaks [x402](https://www.x402.org) with an EIP-3009 USDC.
On a public chain you don't own the token, so you can't mint credits, run faucets,
or reward activity at the source. This directory is the chain you *do* own: a
self-hosted EVM network plus a USDC-compatible token you control 1:1, so the whole
payment loop — faucet drips, per-message charges, P2P transfers, settlement — runs
closed-loop with full authority.

## Layout

| Piece | File(s) | Purpose |
|---|---|---|
| Devnet node | `scripts/devnet.sh` | anvil, chain-id `TINY_CHAIN_ID` (default 31337), 2s blocks |
| Token | `contracts/TinyUSDC.sol` | EIP-3009 USDC: domain `{name:"USDC", version:"2"}`, 6 decimals, owner-mintable |
| Deploy | `scripts/deploy.mjs` | deploys the token, writes `deployment.json` |
| Facilitator | `facilitator/server.mjs` | x402 `POST /verify` + `/settle`, `GET /supported` + `/healthz`; port `FACILITATOR_PORT` (default 8546) |
| RPC proxy | `rpc-proxy.mjs` + `raw-tx-guard.mjs` | the only surface you expose publicly — method allowlist + dev-key signer screening |
| Settle policy | `settle-policy.mjs` | the facilitator only settles payments addressed to *your* payee (`X402_PAY_TO`) |
| Backups | `backup.mjs`, `scripts/backup.mjs` | snapshot/rotate/verify the node's state file |
| Dev keys | `dev-keys.mjs` | the one list of anvil's published test keys, used by every guard |
| Multi-validator | `multinode/` | QBFT (besu) track: joinable validator set, staking registry, genesis tooling |

## Quickstart

```bash
# prerequisite: foundry (curl -L https://foundry.paradigm.xyz | bash && foundryup)
cd chain
npm install
npm run e2e        # scratch anvil on :8547 → deploy → EIP-3009 round-trip → teardown

# long-running devnet:
npm run devnet     # :8545, deterministic anvil test accounts
npm run compile && npm run deploy && npm run smoke
```

Other end-to-end suites: `e2e:facilitator`, `e2e:faucet`, `e2e:proxy`,
`e2e:authproof`, `e2e:backup` (see `package.json`). Unit tests for the guards
live in the web app's suite: `web/tests/{rpc-proxy,settle-policy,dev-keys,chain-backup}.test.ts`.

## Why the contract looks like this

- **EIP-3009 `transferWithAuthorization` is non-negotiable** — the x402 payer
  (`web/lib/x402/payer.ts`) signs exactly that typed data; both the `(v,r,s)` and
  packed-`bytes(65)` overloads are implemented because viem emits packed
  signatures and facilitators differ in what they forward.
- **Domain `name:"USDC"`, `version:"2"`** matches the payer's spec-default
  fallback, so challenges that omit `extra.name` still verify.
- **6 decimals**: 1 token unit == 1 micro-USDC — the worker ledger's micro
  integers map 1:1, no conversion layer.
- **`mint()` is owner-only**: the deployer key is the monetary authority; the
  faucet mints against it. The owner is fixed **at deploy time** with no revoke —
  which is why the dev-key guard below treats the deployer key as the most
  dangerous value in the repo.

## 🔑 The published dev keys — and why two defaults refuse to run

anvil (and hardhat, and ganache) derive their accounts from a **published**
mnemonic (`test test … junk`), printed in anvil's own startup banner. Those keys
are not secrets and never were. But they make comfortable *defaults*, and **a
missing env is easy to guard while a wrong default reads as configured**:

- **`scripts/deploy.mjs` refuses to deploy with a dev key** — before any RPC, so
  a refusal leaves no half-deployed token. Deploying with anvil #0 would hand the
  token's monetary authority to a keypair the entire internet has, permanently;
  the only remedy would be a new token and a balance migration.
- **`facilitator/server.mjs` exits at startup** if `FACILITATOR_RELAYER_KEY` is
  unset or a dev key. The relayer only pays gas and holds no USDC by design, so
  the damage is bounded — but it signs the transactions that settle everyone's
  payments, so anyone could drain its ETH and stall settlement.

`dev-keys.mjs` holds the one list (keys + derived addresses). For local e2e runs
the scratch anvil genuinely uses these accounts, so the scripts set
`TINY_CHAIN_ALLOW_DEV_KEYS=1` themselves. Opt-**in**, never opt-out — the safe
state must be the one you get by doing nothing.

⚠️ **`deployment.json` is not a scratch file.** The facilitator reads its token
address from it at startup, and it's gitignored so git cannot restore it. The e2e
scripts deploy with `write: false` for exactly this reason — don't let a
throwaway run overwrite a live chain's record.

## Going public: what to expose, and what screens it

Bind the node itself to `127.0.0.1`. The only thing a tunnel (cloudflared, ngrok,
your reverse proxy) should expose is:

- **`rpc-proxy.mjs`** — a method **allowlist** in front of the node.
  `eth_sendRawTransaction` is allowed deliberately: a raw transaction arrives
  already signed, so the caller must hold a key. On any public chain that ends
  the argument — but here ten of the keys are *published*, and anvil funds each
  with 10,000 ETH, while `web3_clientVersion` (allowlisted, because wallets ask)
  advertises `anvil/vX` to anyone probing. Finding the endpoint is finding the
  keys. Nothing can be stolen (`mint` is owner-only, the dev accounts hold no
  token) — but it would be a free, unauthenticated, permanent **write channel**
  into your state file. So **`raw-tx-guard.mjs`** recovers each raw transaction's
  signer and rejects the published ten with `-32003`. It *fails open* when the
  signer can't be recovered: a proxy is not a validator, and a transaction type
  your viem can't parse yet must still reach the node.
- **`facilitator/server.mjs`** — its `/verify` and `/settle` take
  `paymentRequirements` (including `payTo`) from the request body, and every
  signature check can pass *for a payment that has nothing to do with your
  deployment*. The unasked question isn't "is this authorization valid" but "is
  it **ours**". **`settle-policy.mjs`** screens `requirement.payTo` against
  **`X402_PAY_TO`** — the *same* env the x402 receiver advertises in its 402
  challenge (comma-separated to allow a rotation overlap; one fact, one env — a
  separate copy would drift in the direction where real payments fail and
  strangers' still settle). Unset is a startup refusal.

## 💾 Backups — the state file is the only copy of every balance

The node's state file (`~/.tiny-chain/state`) holds every faucet drip's backing
reserve and every settled payment. Snapshot it:

```bash
npm run backup                       # snapshot + rotate
node scripts/backup.mjs --list       # what you hold
node scripts/backup.mjs --verify <f> # read one back
```

Snapshots land in `~/.tiny-chain/backups` (`TINY_CHAIN_BACKUP_DIR`), newest 24
kept (`TINY_CHAIN_BACKUP_KEEP`), named `tiny-chain-<utc>-blk<n>.json` so
lexicographic order is time order. Hard-won properties, verified against anvil 1.7.1:

- **A corrupt state file is a dead chain, not a degraded one** — anvil refuses to
  boot on a `--state` it can't parse, and there is no start-empty-and-carry-on mode.
- **`anvil_dumpState` returns gzipped hex, and `--load-state` refuses a gzipped
  file** — so the naïve backup produces something that cannot be restored, and you
  find out on the worst day. `decodeDump()` gunzips so the stored form is the one
  anvil will load.
- **A backup that overwrites a good copy with a worse one is a delete** — if the
  node comes back empty at block 0, a faithful rotation would replicate that empty
  chain over every good copy, on schedule. `regressionRefusal()` refuses any
  candidate below the highest block held, and every snapshot is parsed *from disk*
  before its `.partial` name is renamed into place.
- **Restore is deliberately manual** (booting on an older state silently rewinds
  every balance): stop the node, keep the broken state file as evidence, copy the
  chosen snapshot into place, restart.
- `anvil_dumpState` is **not** on the public allowlist and must not be — backups
  talk to the node's loopback port directly.

## Env contract

```bash
PAYMENTS_NETWORK=tiny
TINY_CHAIN_ID=31337                          # pick your own for a durable network
TINY_CHAIN_RPC_URL=http://127.0.0.1:8545     # public: your tunnel, e.g. https://chain.example.com
TINY_CHAIN_USDC_ADDRESS=<from deployment.json>
X402_FACILITATOR_URL=http://127.0.0.1:8546   # facilitator/server.mjs — REQUIRED here
X402_PAY_TO=<your receiving address>         # also read by the facilitator (payee screen) — REQUIRED
TINY_CHAIN_DEPLOYER_KEY=<generate your own>  # TinyUSDC owner — the mint authority
FACILITATOR_RELAYER_KEY=<generate your own>  # gas only; REQUIRED (no safe default)
```

⚠️ **`X402_FACILITATOR_URL` is not optional on a self-hosted chain.** The
receiver delegates verify+settle to a facilitator, and the spec-default public
facilitator can only settle base + base-sepolia — it has no RPC for your chain
and no knowledge of your token. Leave it unset and every paid tiny fails closed
with 424 "x402 payments not configured" instead of quoting a 402 nothing can
redeem. Resolver + rules: `web/lib/x402/facilitator.ts`.

## The faucet — where the minting authority is actually spent

Two halves, because only one of them can hold a key:

- The **worker** (`/pay/faucet`) grants the ledger credit: one drip per user per
  UTC day, inside a reputation-scaled lifetime ceiling.
- The **web app** (`/api/wallet/faucet`, holds `TINY_CHAIN_DEPLOYER_KEY`) mints
  the matching TinyUSDC into the deposit address so the credit is backed 1:1.

**Ledger first, mint second** — deliberately. A mint with no ledger row is
unbacked in reverse: tokens nobody was credited for, and retries inflate supply.
A credit whose mint failed is bounded, reported (`reserve_backed:false`) and
harmless, because trial credit is not withdrawable. `npm run e2e:faucet` guards
one specific hazard: the web route carries a hand-written `mint(address,uint256)`
ABI fragment (it can't import the forge artifact), and a drifted fragment would
revert silently while drips kept succeeding — the script mints through the
route's exact fragment against a real deployment and proves mint is owner-only.

## Multi-validator track (`multinode/`)

Everything above runs a single anvil node, which is perfect for one operator.
`multinode/` holds the QBFT (besu) track for a participant-joinable network:
genesis + bootnode tooling, a staking/registry contract with slashing, validator
attendance and set-health policies, and a documented genesis-transition plan
(`genesis-transition-plan.mjs`). Its e2e suites live in `multinode/scripts/`.
Treat it as a working reference rather than a turnkey product — read the policies
before running a real validator set.
