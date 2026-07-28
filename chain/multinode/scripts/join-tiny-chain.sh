#!/usr/bin/env bash
#
# join-tiny-chain.sh — run a full node on tiny chain 8470. One command, no
# permission, no key from us.
#
# This is the script that makes the word "participate" true at tier 1 of the
# design doc's table (§6): sync every block, verify all of it yourself, serve your
# own RPC. It needs nothing from the operators of this chain — no allowlist entry,
# no invitation, no stake, no signup. If it ever does, the chain has stopped being
# open and this file is where that regression should show up first.
#
# What it deliberately does NOT do:
#
#   • It does not make you a VALIDATOR. That is a separate, also-permissionless
#     step (stake >= MIN_STAKE, then rotate()) and it is gated on something this
#     script cannot give you: the stake asset. Conflating the two would be the
#     dishonest version of "anyone can participate" — see `--print-validator-steps`.
#   • It does not copy a key from the network operators. It GENERATES your node
#     key locally, because a joiner handed one of our keys is not a peer, it is a
#     remote-controlled instance of us.
#
# Usage:
#   bash join-tiny-chain.sh                      # join with defaults
#   bash join-tiny-chain.sh --home ~/my-tiny     # your own data directory
#   bash join-tiny-chain.sh --rpc-port 9545      # pick your RPC port
#   bash join-tiny-chain.sh --bootnodes enode://…  # override the bootnode list
#   bash join-tiny-chain.sh --print-validator-steps   # what becoming a validator takes
#   bash join-tiny-chain.sh --dry-run            # print the besu command, run nothing
#
# Environment: TINY_JOIN_HOME, TINY_JOIN_RPC_PORT, TINY_JOIN_P2P_PORT,
# TINY_JOIN_BOOTNODES, TINY_JOIN_GENESIS, TINY_JOIN_JDK_HINT, BESU_BIN.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_GENESIS="$HERE/../genesis-8470.json"
BOOTNODES_FILE="$HERE/../bootnodes-8470.txt"

JOIN_HOME="${TINY_JOIN_HOME:-$HOME/.tiny-chain/joiner}"
RPC_PORT="${TINY_JOIN_RPC_PORT:-8545}"
P2P_PORT="${TINY_JOIN_P2P_PORT:-30303}"
BOOTNODES="${TINY_JOIN_BOOTNODES:-}"
GENESIS="${TINY_JOIN_GENESIS:-$REPO_GENESIS}"
# Our own install path is a FALLBACK, not the definition of "installed". If the
# joiner has besu on PATH, that is the one they installed and the one they expect to
# run — and the failure message below has always told them PATH was enough, while
# the script only ever looked in OUR directory. Same class as the JAVA_HOME bug: a
# documented behaviour with no implementation. Precedence: BESU_BIN, then PATH, then
# our layout.
BESU="${BESU_BIN:-}"
if [[ -z "$BESU" ]]; then
  BESU="$(command -v besu 2>/dev/null || true)"
fi
BESU="${BESU:-$HOME/.tiny-chain/besu/besu-26.7.0/bin/besu}"
DRY_RUN=0
FOREGROUND=1

# ⚠️ Besu 26.7.0 is compiled for Java 25+ (class file 69.0). Java 21 fails with
# UnsupportedClassVersionError, and the error names neither Java nor a version in
# its first line — worth stating up front rather than letting a joiner debug it.
#
# ⚠️⚠️ WHAT THIS LINE USED TO BE, AND WHY IT WAS A JOINER-ONLY BUG:
#
#     export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@26}"
#
# That is a HOMEBREW-ON-MACOS path, and it EXPORTS it. On any machine without that
# exact directory — every Linux host, every macOS box using Temurin/sdkman/asdf,
# every CI runner — the default was not "fall back to whatever java you have": besu's
# own launcher (bin/besu, lines 84-102) branches on `[ -n "$JAVA_HOME" ]` FIRST and
# only consults PATH in the `else`. A set-but-nonexistent JAVA_HOME therefore takes
# the invalid-directory `die` path, exit 1, printing
#
#     ERROR: JAVA_HOME is set to an invalid directory: /opt/homebrew/opt/openjdk@26
#
# to a joiner who never set JAVA_HOME and has a perfectly good Java 26 on PATH. So
# the script ACTIVELY BROKE the case it was meant to help, and it named OUR path in
# the error — the reader's only reasonable conclusion is that joining requires
# Homebrew, i.e. that the chain is macOS-only. Measured both directions on this box:
# bad JAVA_HOME + good java on PATH ⇒ exit 1 die; JAVA_HOME unset + same PATH ⇒
# `besu/v26.7.0/osx-aarch_64/openjdk-java-26`, exit 0.
#
# ⚠️ It works HERE, which is the whole shape of the defect. Every other script in
# this directory (gen-network.sh, start-devnet.sh) carries the same line and is
# correct to: they only ever run on the operators' machine. This one is the ONLY
# file in the tree a stranger executes, so it is the only one where a local path is
# a bug — the same "two callers share a mechanism, check whether they share its
# WARRANT" rule as web-ui c70.
#
# So: respect a JAVA_HOME the joiner set, otherwise defer to PATH (besu's own
# fallback), and only reach for a local hint if PATH has no java at all. A hint is
# used ONLY when it exists, because exporting a path that doesn't is precisely the
# bug above.
#
# ⚠️ And the predicate is "does java RUN", not `command -v java`. macOS ships a
# /usr/bin/java STUB that exists, is executable, and satisfies `command -v` while
# having no runtime behind it: `java -version` exits 1 with "Unable to locate a Java
# Runtime". Trusting the lookup hands besu that stub, and besu's version probe
# (`awk /version/` over its output) then reads an empty string and dies with
#
#     Unable to determine Java version
#
# which names neither Java's absence nor a path — strictly less debuggable than the
# bug I was fixing. Measured on this box: stub `java -version` ⇒ exit 1, real ⇒ 0.
have_java() { java -version >/dev/null 2>&1; }
if [[ -z "${JAVA_HOME:-}" ]] && ! have_java; then
  for hint in "${TINY_JOIN_JDK_HINT:-}" \
              /opt/homebrew/opt/openjdk@26 /opt/homebrew/opt/openjdk \
              /usr/lib/jvm/java-26-openjdk-amd64 /usr/lib/jvm/default-java; do
    if [[ -n "$hint" && -x "$hint/bin/java" ]]; then
      export JAVA_HOME="$hint"
      break
    fi
  done
  # Still nothing. Say so HERE, naming Java and the version, rather than letting
  # besu's launcher report it as an indeterminate version or an invalid directory.
  if [[ -z "${JAVA_HOME:-}" ]]; then
    echo "✗ no working Java found (java -version failed and no JDK at the usual paths)." >&2
    echo "  besu 26.7.0 needs Java 25+. Install a JDK, then either put it on PATH or" >&2
    echo "  set JAVA_HOME=/path/to/jdk (or TINY_JOIN_JDK_HINT=/path/to/jdk)." >&2
    exit 1
  fi
fi

# ⚠️ If this node peers and matches the genesis hash but never leaves block 0, the
# problem is NOT your network — you are being refused our chain. Check:
#
#     grep -E 'Invalid block|ValidationRule' "$JOIN_HOME/logs/joiner.log" | head
#
# A "Validators in extra data expected to be empty" line means the genesis qbft
# transition is being read as a 1970 timestamp, so contract-mode header rules get
# applied to early blockheader-mode blocks. See the _transitions_comment in
# genesis-8470.json. That bug shipped in our own genesis once: it is invisible to
# nodes that already hold the blocks, so the first person it can possibly hurt is
# a newcomer syncing from genesis.

print_validator_steps() {
  cat <<'STEPS'
Becoming a VALIDATOR (separate from running a node, and also permissionless):

  1. Hold at least MIN_STAKE of the chain's TinyUSDC. This is the honest
     bottleneck: nobody can be a validator without the stake asset, and this
     script cannot give it to you.
  2. approve(TinyValidators, amount) then stake(amount) on TinyValidators.
  3. Call rotate() yourself at an epoch boundary. Not us — you. If it needed our
     key, the chain would not be open.
  4. You are seated if you are in the top MAX_VALIDATORS by stake. Entry is
     permissionless; SEATS are capped, because QBFT is O(n^2) in messages.

Two things to know before staking, stated plainly:

  • Your stake is currently a DEPOSIT, not a bond. Equivocation is adjudicated
    on-chain (TinySlashing convicts, permanently and publicly), but nothing burns
    stake yet: TinyValidators has no slashing hook and no admin to add one, so
    enforcement needs a registry swap. Until that ships, do not let anyone —
    including us — describe this stake as slashable.
  • unstake() returns it in full after the unbonding period. Leaving works; that
    is tested, not assumed.
STEPS
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home) JOIN_HOME="$2"; shift 2 ;;
    --rpc-port) RPC_PORT="$2"; shift 2 ;;
    --p2p-port) P2P_PORT="$2"; shift 2 ;;
    --bootnodes) BOOTNODES="$2"; shift 2 ;;
    --genesis) GENESIS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --background) FOREGROUND=0; shift ;;
    --print-validator-steps) print_validator_steps; exit 0 ;;
    # ⚠️ This was `sed -n '2,32p'`, a HARDCODED range, and it had already gone
    # stale: line 29 was `set -euo pipefail`, so --help printed shell code —
    # `set -euo pipefail`, `HERE=$(cd ...)`, `REPO_GENESIS=...` — as if it were
    # documentation. A line number is a claim about a file's shape that no edit to
    # the file can invalidate loudly (c47's rule), and the very first thing that
    # touched this header re-broke it. Derived instead: the header is exactly the
    # leading run of `#` lines after the shebang, so it cannot drift again.
    -h|--help) sed -n '2,/^[^#]/p' "${BASH_SOURCE[0]}" | sed '/^[^#]/d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "✗ $*" >&2; exit 1; }

[[ -f "$GENESIS" ]] || fail "no genesis at $GENESIS"
[[ -x "$BESU" ]] || fail "besu not found at $BESU
  Install Hyperledger Besu 26.7.0+ and either put it on PATH as \$BESU_BIN or pass BESU_BIN=…
  A joiner needs besu specifically: the chain runs QBFT, which geth/anvil cannot follow."

# The bootnode list is data, not code, so it lives in a file a joiner can read and
# audit rather than being buried in this script. Comment lines and blanks are
# skipped so it can explain itself.
#
# ⚠️ INLINE comments are stripped too (c27). The old `grep -vE '^\s*(#|$)'` only
# dropped WHOLE comment lines, so `<enode> # frankfurt` — the shape the file's own
# header invites — was handed to besu WITH the comment text attached, and besu
# rejects the WHOLE list, so one annotation costs a joiner every bootnode.
#
# ⚠️ And an EMPTY element is dropped, not merely whitespace-trimmed. `tr` turns the
# separators into newlines so that a trailing comma, a `#`-only line and a CRLF `\r`
# all collapse to a blank line that `grep -v` removes — the old pipeline handed besu
# `enode://…,` verbatim for a file ending in a comma, and besu parses the empty tail
# as a peer and rejects the argument. The file is hand-edited data, so a trailing
# comma is not a hypothetical.
#
# This must stay equivalent to classifyBootnodes() in lib/chain/join.ts — same
# inputs, same enode set. That is not a hope: the differential tests in
# tests/chain-join.test.ts EXECUTE this script under --dry-run and compare its
# --bootnodes= argument against the TS parser on identical bytes, including the real
# bootnodes-8470.txt. Two parsers with one documented format need a test that can
# see them disagree; before c27 they disagreed three ways.
#
# ⚠️⚠️ `|| true` IS LOAD-BEARING, and it fixes a silent exit-1 that predates c27.
# `grep -v` returns 1 when it filters out EVERY line, and under `set -euo pipefail`
# a non-zero status anywhere in this pipeline aborts the script AT THIS LINE — so a
# bootnodes file holding only comments (which is exactly what a fresh checkout has
# once the loopback enode is removed, and what the file's own header invites while
# waiting for a routable address) exited 1 with ZERO bytes on stdout AND stderr.
# Measured on the pre-c27 script: exit=1, stdout=0, stderr=0. The `fail "no
# bootnodes: pass --bootnodes enode://…"` line three lines below — written for
# precisely this case, and the only thing that tells a joiner what to do about it —
# was UNREACHABLE. An empty result is a legitimate parse outcome, not a pipeline
# error; the emptiness is diagnosed by the `[[ -n ]]` check, which can only run if
# this line is allowed to succeed.
if [[ -z "$BOOTNODES" && -f "$BOOTNODES_FILE" ]]; then
  BOOTNODES="$(sed 's/#.*$//' "$BOOTNODES_FILE" \
    | tr ',\r' '\n\n' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | grep -vE '^$' \
    | paste -sd, - || true)"
fi
[[ -n "$BOOTNODES" ]] || fail "no bootnodes: pass --bootnodes enode://… or populate $BOOTNODES_FILE"

mkdir -p "$JOIN_HOME/data"

# YOUR key, generated locally on first run. besu makes one itself if the file is
# absent; being explicit about it is the point — this is the line that proves a
# joiner is a peer and not a copy of one of our nodes.
if [[ ! -f "$JOIN_HOME/data/key" ]]; then
  echo "… no node key at $JOIN_HOME/data/key — besu will generate YOUR OWN on first start"
fi

CHAIN_ID="$(grep -o '"chainId"[[:space:]]*:[[:space:]]*[0-9]*' "$GENESIS" | head -1 | grep -o '[0-9]*$')"
echo "tiny chain $CHAIN_ID — joining as a full node"
echo "  genesis    $GENESIS"
echo "  data       $JOIN_HOME/data"
echo "  rpc        http://127.0.0.1:$RPC_PORT"
echo "  p2p        $P2P_PORT"
echo "  bootnodes  $BOOTNODES"
echo

# --sync-mode=FULL is not a default worth inheriting: it is the participation
# claim. A snap-synced node trusts someone else's state root; a FULL node
# re-executes every block and can contradict us. That is the whole point of
# letting strangers run nodes.
CMD=(
  "$BESU"
  --data-path="$JOIN_HOME/data"
  --genesis-file="$GENESIS"
  --bootnodes="$BOOTNODES"
  --p2p-port="$P2P_PORT"
  --rpc-http-enabled
  --rpc-http-port="$RPC_PORT"
  --rpc-http-host=127.0.0.1
  --rpc-http-api=ETH,NET,WEB3,QBFT,TXPOOL
  --host-allowlist='*'
  --min-gas-price=0
  --sync-mode=FULL
  --data-storage-format=BONSAI
)

if [[ "$DRY_RUN" == 1 ]]; then
  printf '%q ' "${CMD[@]}"; echo
  exit 0
fi

if [[ "$FOREGROUND" == 1 ]]; then
  echo "starting (ctrl-c to stop). Verify from another shell with:"
  echo "  node chain/multinode/scripts/joiner-e2e.mjs"
  echo
  exec "${CMD[@]}"
else
  mkdir -p "$JOIN_HOME/logs"
  "${CMD[@]}" > "$JOIN_HOME/logs/joiner.log" 2>&1 &
  echo $! > "$JOIN_HOME/joiner.pid"
  echo "started in background (pid $(cat "$JOIN_HOME/joiner.pid")), log $JOIN_HOME/logs/joiner.log"
  echo "stop with: kill \$(cat $JOIN_HOME/joiner.pid)"
fi
