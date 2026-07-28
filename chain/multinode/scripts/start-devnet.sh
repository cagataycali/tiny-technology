#!/usr/bin/env bash
#
# Start the 4-node QBFT devnet for chain 8470.
#
# This is the thing anvil could never be: four independent processes that peer
# over devp2p, run consensus, and each hold a full copy of the chain. Node 1 is
# the bootnode only in the sense that it's the one whose enode the others are
# told about — it has no special authority (QBFT round-robins the proposer).
#
# ⚠️ Does NOT touch the live chain 8469: different ports, different data dirs,
# different chain id. Production settles on 8469 and must keep doing so.
#
# Ports (node N):  RPC 8600+N   P2P 30400+N
set -euo pipefail

HOME_DIR="${TINY_MULTINODE_HOME:-$HOME/.tiny-chain/multinode}"
NETWORK="$HOME_DIR/network"
GENESIS="$NETWORK/genesis.json"
BESU="${BESU_BIN:-$HOME/.tiny-chain/besu/besu-26.7.0/bin/besu}"
LOGS="$HOME_DIR/logs"
NODES="${TINY_MULTINODE_NODES:-4}"

# Besu 26.7.0 needs Java 25+; openjdk@21 fails with UnsupportedClassVersionError.
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@26}"

[[ -f "$GENESIS" ]] || { echo "no genesis — run scripts/gen-network.sh first" >&2; exit 1; }
mkdir -p "$LOGS"

rpc_port() { echo $((8600 + $1)); }
p2p_port() { echo $((30400 + $1)); }

start_node() {
  local n="$1" extra="${2:-}"
  local dir="$HOME_DIR/node$n"
  [[ -d "$dir/data" ]] || { echo "node$n has no data dir — re-run gen-network.sh" >&2; exit 1; }
  # --sync-mode FULL: a devnet has no snap servers, and we WANT every node to
  # hold and verify all history — that's the participation claim being built.
  # --min-gas-price 0 pairs with the genesis zeroBaseFee: free gas, still metered
  # by gas limit (design doc §0.1).
  "$BESU" \
    --data-path="$dir/data" \
    --genesis-file="$GENESIS" \
    --node-private-key-file="$dir/data/key" \
    --p2p-port="$(p2p_port "$n")" \
    --p2p-host=127.0.0.1 \
    --rpc-http-enabled \
    --rpc-http-port="$(rpc_port "$n")" \
    --rpc-http-host=127.0.0.1 \
    --rpc-http-api=ETH,NET,WEB3,QBFT,ADMIN,TXPOOL \
    --host-allowlist='*' \
    --min-gas-price=0 \
    --sync-mode=FULL \
    --data-storage-format=BONSAI \
    $extra \
    > "$LOGS/node$n.log" 2>&1 &
  echo $! > "$HOME_DIR/node$n.pid"
  echo "node$n started (pid $(cat "$HOME_DIR/node$n.pid"), rpc $(rpc_port "$n"), p2p $(p2p_port "$n"))"
}

# Node 1 first, so we can read its enode and hand it to the rest as a bootnode.
start_node 1

echo "waiting for node1 to publish its enode…"
ENODE=""
for _ in $(seq 1 60); do
  ENODE=$(curl -s --max-time 2 -X POST "http://127.0.0.1:$(rpc_port 1)" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"net_enode","params":[]}' 2>/dev/null \
    | sed -n 's/.*"result":"\([^"]*\)".*/\1/p') || true
  [[ -n "$ENODE" ]] && break
  sleep 1
done
[[ -n "$ENODE" ]] || { echo "node1 never came up — see $LOGS/node1.log" >&2; exit 1; }
echo "bootnode: $ENODE"

for n in $(seq 2 "$NODES"); do
  start_node "$n" "--bootnodes=$ENODE"
done

echo
echo "devnet up: $NODES nodes, chain 8470. Logs: $LOGS/"
echo "verify:  node chain/multinode/scripts/devnet-e2e.mjs"
echo "stop:    bash chain/multinode/scripts/stop-devnet.sh"
