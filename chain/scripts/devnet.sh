#!/usr/bin/env bash
# Long-running tiny-chain devnet. Deterministic accounts (anvil's default test
# mnemonic), steady 2s blocks so the worker's MIN_CONFIRMATIONS=3 deposit check
# (chatgpt-plugin-tinyai/src/deposits.ts:39) clears in ~6s without traffic.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
exec anvil \
  --chain-id "${TINY_CHAIN_ID:-31337}" \
  --port "${TINY_CHAIN_PORT:-8545}" \
  --block-time 2
