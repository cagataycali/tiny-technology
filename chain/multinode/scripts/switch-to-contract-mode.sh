#!/usr/bin/env bash
#
# Hand validator selection over to TinyValidators — the moment chain 8470 stops
# having an operator-defined validator set and starts having a stake-defined one.
#
# Mechanically it is one genesis edit: a `transitions.qbft` entry that, at a
# future block, tells Besu to read validators from a contract instead of from
# block headers. Politically it is the whole point of the project: after this
# block, a stranger who stakes gets seated and nobody can stop it.
#
# ⚠️ EVERY node must carry the same transition BEFORE the transition block. A
# node still in header mode after its peers have switched computes a different
# validator set, so it rejects their blocks and forks. That's why the block is
# ~200 ahead (≈7 min at 2s) and why this script restarts all of them itself
# rather than leaving it to the operator to remember.
#
# ⚠️ THE KEY IS A TIMESTAMP, NOT A BLOCK NUMBER — see the long note by the
# `transitions` write below. Writing a block number here produced a chain that no
# outsider could ever sync while looking perfectly healthy from the inside (P5,
# design doc §5.1). This script is where that bug was born, so it is where the
# correct form is enforced.
#
# ⚠️ Does NOT touch the live 8469.
set -euo pipefail

HOME_DIR="${TINY_MULTINODE_HOME:-$HOME/.tiny-chain/multinode}"
GENESIS="$HOME_DIR/network/genesis.json"
DEPLOYMENT="$HOME_DIR/validators-deployment.json"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -f "$DEPLOYMENT" ]] || { echo "no $DEPLOYMENT — run deploy-validators.mjs first" >&2; exit 1; }
[[ -f "$GENESIS" ]] || { echo "no genesis at $GENESIS" >&2; exit 1; }

python3 - "$GENESIS" "$DEPLOYMENT" <<'PY'
import json, os, sys, shutil
genesis_path, deployment_path = sys.argv[1], sys.argv[2]
g = json.load(open(genesis_path))
d = json.load(open(deployment_path))

contract = d['validatorContract']
block = d['transitionBlock']

# ── The transition key: a TIMESTAMP whenever a time-based hardfork precedes it ──
#
# Besu registers each qbft fork as a ProtocolSpecAdapter keyed by this number, then
# adopts the MILESTONE TYPE of the nearest preceding hardfork
# (ProtocolScheduleBuilder.lambda$initSchedule$0 → floorEntry(key).milestoneType).
# With `shanghaiTime` in the genesis — which we need, PUSH0 — that floor is a TIME
# milestone, so besu reads this field as a unix timestamp no matter what we intend.
# A block number then means 1970: contract mode from block 1.
#
# Nothing complains. Nodes that already hold the pre-transition blocks never
# re-validate them, so the chain keeps producing and every insider check passes.
# The failure lands entirely on a NEWCOMER syncing from genesis, who is refused at
# block 1 ("Validators in extra data expected to be empty"), disconnected for
# BREACH_OF_PROTOCOL, and stalls at 0 forever. That is how a chain ends up
# unjoinable without anyone noticing — see design doc §5.1.
# Detect the condition rather than hardcoding it: any `*Time` hardfork key means the
# floor milestone can be time-based. (`shanghaiTime` is ours today; cancun/prague
# would be the same story.)
time_forks = [k for k in g['config'] if k.endswith('Time')]
if time_forks:
    # Convert "N blocks ahead" into "the timestamp N blocks from now", using the
    # configured block period. Overshooting is safe (the switch just happens later);
    # a value in the PAST would switch immediately and make every stored
    # pre-transition block invalid — the failure this whole note is about.
    import urllib.request
    req = urllib.request.Request(
        os.environ.get('TINY_MULTINODE_RPC', 'http://127.0.0.1:8601'),
        data=json.dumps({'jsonrpc': '2.0', 'id': 1,
                         'method': 'eth_getBlockByNumber', 'params': ['latest', False]}).encode(),
        headers={'content-type': 'application/json'})
    head = json.load(urllib.request.urlopen(req, timeout=10))['result']
    period = int(g['config']['qbft'].get('blockperiodseconds', 2))

    # The lead must be STRICTLY positive. `transitionBlock` was chosen when the
    # deployment happened, so by now the chain may well be past it — and clamping a
    # stale lead to 0 yields "the current head's timestamp", i.e. a transition at a
    # block that ALREADY EXISTS in header mode. Every node would then reject its own
    # stored block on the next restart. So floor the lead instead of the result: 30
    # blocks (≈1 min at 2s) is enough for stop-devnet/start-devnet below to finish
    # before the switch lands.
    MIN_LEAD_BLOCKS = 30
    ahead = block - int(head['number'], 16)
    if ahead < MIN_LEAD_BLOCKS:
        print(f'requested transition block {block} is {"past" if ahead < 0 else "too close to"} head '
              f'{int(head["number"], 16)}; using a {MIN_LEAD_BLOCKS}-block lead instead')
        ahead = MIN_LEAD_BLOCKS
    key = int(head['timestamp'], 16) + ahead * period
    print(f'genesis has time-based hardforks {time_forks}, so besu reads the transition key as a')
    print(f'TIMESTAMP: using {key} (~{ahead} blocks ≈ {ahead * period}s ahead) instead of block {block}.')
    block = key

# The genesis hash is derived from the genesis file. Changing `transitions` does
# NOT change it (it isn't part of the header), which is exactly why this can be
# applied to a running chain at all — but keep a backup: a genesis edit that DID
# change the hash would orphan every node's database with no way back.
shutil.copyfile(genesis_path, genesis_path + '.pre-contract-mode')

cfg = g['config']
existing = cfg.get('transitions', {}).get('qbft', [])
if any(t.get('validatorcontractaddress') for t in existing):
    print('already has a contract-mode transition — nothing to do')
    sys.exit(0)

# Verified against the shipped besu-config-26.7.0.jar. A TRANSITION needs BOTH
# keys — this is where I got it wrong first time and it cost a full debug cycle:
#
#   JsonQbftConfigOptions (the GENESIS qbft block) has only
#   `validatorcontractaddress`, and treats its mere presence as contract mode.
#   QbftFork (a TRANSITIONS entry) has a SECOND key, `validatorselectionmode`,
#   and without it the address is parsed and then ignored.
#
# The failure is silent in the worst way: besu logs nothing, the chain keeps
# producing blocks, and the contract can be seating validators nobody consults.
# The only symptom is that qbft_getValidatorsByBlockNumber disagrees with
# getValidators() — which is exactly what contract-mode-e2e.mjs asserts.
# Valid modes are 'blockheader' and 'contract' (QbftFork$VALIDATOR_SELECTION_MODE).
cfg.setdefault('transitions', {}).setdefault('qbft', []).append({
    'block': block,
    'validatorselectionmode': 'contract',
    'validatorcontractaddress': contract,
})
json.dump(g, open(genesis_path, 'w'), indent=2)
print(f'transition added: at block {block}, validators come from {contract}')
PY

echo
echo "restarting all nodes so every one of them knows about the transition…"
bash "$HERE/stop-devnet.sh"
sleep 3
bash "$HERE/start-devnet.sh"

echo
echo "watch it take effect:  node $HERE/contract-mode-e2e.mjs"
