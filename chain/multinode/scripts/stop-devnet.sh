#!/usr/bin/env bash
#
# Stop the 8470 devnet. Kills ONLY pids this repo's start-devnet.sh recorded —
# never a pattern-match on "besu", because a pkill would be indiscriminate and
# this machine also runs the live 8469 services under launchd.
set -euo pipefail

HOME_DIR="${TINY_MULTINODE_HOME:-$HOME/.tiny-chain/multinode}"
stopped=0

for pidfile in "$HOME_DIR"/node*.pid; do
  [[ -f "$pidfile" ]] || continue
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    stopped=$((stopped + 1))
    echo "stopped $(basename "$pidfile" .pid) (pid $pid)"
  fi
  rm -f "$pidfile"
done

echo "$stopped node(s) stopped"
