#!/usr/bin/env bash
#
# Generate the 8470 QBFT genesis + 4 validator keypairs.
#
# Writes to $TINY_MULTINODE_HOME (default ~/.tiny-chain/multinode), NOT into the
# repo: these are private keys. The genesis itself is public and gets copied back
# into the repo by hand once it's stable (P5 publishes it for outside joiners).
#
# Idempotent-by-refusal: it will NOT overwrite an existing network, because
# regenerating keys silently would orphan every node's data directory and the
# chain would appear to halt for reasons nobody could see. Pass --force to redo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$HERE/../qbft-config.json"
HOME_DIR="${TINY_MULTINODE_HOME:-$HOME/.tiny-chain/multinode}"
OUT="$HOME_DIR/network"
BESU="${BESU_BIN:-$HOME/.tiny-chain/besu/besu-26.7.0/bin/besu}"

# ⚠️ Besu 26.7.0 is compiled for Java 25+ (class file 69.0). openjdk@21 — which the
# rest of this repo uses — dies with UnsupportedClassVersionError. Both JDKs are
# keg-only here, so neither is on PATH by default.
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@26}"

if [[ "${1:-}" == "--force" ]]; then
  rm -rf "$OUT"
elif [[ -d "$OUT" ]]; then
  echo "network already generated at $OUT (pass --force to regenerate — this ORPHANS existing node data)" >&2
  exit 0
fi

[[ -x "$BESU" ]] || { echo "besu not found at $BESU — see docs/multinode-tiny-chain-design.md §1" >&2; exit 1; }

mkdir -p "$HOME_DIR"
"$BESU" operator generate-blockchain-config \
  --config-file="$CONFIG" \
  --to="$OUT" \
  --private-key-file-name=key.priv \
  --public-key-file-name=key.pub 2>&1 | grep -vE '^WARNING' || true

[[ -f "$OUT/genesis.json" ]] || { echo "genesis was not generated" >&2; exit 1; }

# besu emits keys under keys/<0xADDRESS>/; give the nodes stable ordinal names so
# scripts and log lines can refer to "node 1" instead of a 40-hex address.
i=0
for d in "$OUT"/keys/*/; do
  i=$((i + 1))
  node="$HOME_DIR/node$i"
  mkdir -p "$node/data"
  cp "$d/key.priv" "$node/data/key"
  cp "$d/key.pub" "$node/data/key.pub"
  basename "$d" > "$node/address"
done

echo "generated $i validators + genesis at $OUT"
echo "chain id: $(grep -o '"chainId"[^,]*' "$OUT/genesis.json" | head -1)"
