#!/usr/bin/env bash
# sync-check.sh — drift report between this repo and the upstream working repo.
#
# Maintainer tool: compares this tree against the upstream checkout's COMMITTED
# HEAD (never its working tree — sibling agents keep in-flight, sometimes
# user-gated work there). Without an upstream checkout it exits 2, which is
# the expected outcome for everyone who isn't the maintainer.
#
# Usage: scripts/sync-check.sh [/path/to/upstream-checkout]
#
# Hard-won rules this script encodes (see the migration ledger):
#   • Always `git -C "$SOURCE"` — a bare `git show HEAD:` run from inside THIS
#     repo compares the repo to itself and reports all-clean.
#   • A per-file diff over files present in BOTH trees misses files that are
#     NEW at upstream HEAD — port those first or the port won't compile.
#   • Deliberate template divergences are pinned below; a DIFF hit on one of
#     them is expected and suppressed. Everything else is real drift.
set -euo pipefail

SOURCE="${1:-$HOME/tinyai-id}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$SOURCE/.git" ] || { echo "no upstream checkout at $SOURCE (pass its path)"; exit 2; }

# Files this repo deliberately changed for open-sourcing (template hygiene,
# layout fixes, scrubbed fixtures). Extend when a cycle adds one ON PURPOSE.
DELIBERATE='README\.md$|BETA_PIPELINE\.md$|project\.yml$|project\.pbxproj$|auto-enroll\.sh$|build-on-device\.sh$|push-ota\.sh$|ContinuityTest\.kt$|NormalizeTinySlugTest\.kt$|pay-e2e\.mjs$|settle-policy\.mjs$|wrangler\.toml$|worker/package(-lock)?\.json$|worker/config\.ts$|0029_endpoint_devices\.sql$|worker/src/index\.ts$'
JUNK='\.gradle|/build/|node_modules|\.wrangler'

# SCRUB — the mechanical part of open-sourcing, applied to every upstream blob
# BEFORE comparing (the port applies the same rules, so a scrubbed file is not
# drift). The rules are a sed script kept OUTSIDE the repo ($SYNC_SCRUB,
# default ~/.tiny/sync-scrub.sed): they name the private hostnames, SSIDs and
# fixture values they replace, so committing them would publish exactly what
# they exist to remove. Without the file nothing is scrubbed and every
# substituted fixture reports as DIFF — loud, not wrong. Binaries pass through
# untouched (sed would eat their bytes).
SCRUB="${SYNC_SCRUB:-$HOME/.tiny/sync-scrub.sed}"
BINARY='\.(png|jpe?g|gif|ico|webp|heic|pdf|mp4|mov|wav|mp3|ipa|apk|aab|jar|woff2?|ttf|otf|glb|stl|zip|p12|mobileprovision|bin|dat)$'
scrub() { # scrub <path>
  if [ ! -f "$SCRUB" ] || echo "$1" | grep -qiE "$BINARY"; then cat; return; fi
  sed -f "$SCRUB"
}

drift=0

scan() { # scan <upstream-git-dir> <upstream-prefix> <local-prefix>
  local src="$1" pre="$2" loc="$3" f local_path rel spec
  # git rejects '' as a pathspec — an empty prefix means the repo root, and a
  # scan that silently lists nothing reports CLEAN, which is worse than a crash.
  spec="${pre:-.}"
  local listed=0
  while IFS= read -r f; do
    listed=1
    rel="${f#"$pre"}"
    local_path="$HERE/$loc$rel"
    if [ ! -f "$local_path" ]; then
      echo "NEW-AT-HEAD: $loc$rel"
      drift=1
    elif ! git -C "$src" show "HEAD:$f" 2>/dev/null | scrub "$f" | diff -q - "$local_path" >/dev/null 2>&1; then
      if echo "$loc$rel" | grep -qE "$DELIBERATE"; then
        : # pinned divergence — expected
      else
        echo "DIFF: $loc$rel"
        drift=1
      fi
    fi
  done < <(git -C "$src" ls-tree -r HEAD --name-only -- "$spec" | grep -vE "$JUNK")
  if [ "$listed" -eq 0 ]; then
    echo "✗ scan of '$loc' listed ZERO files — the comparison did not run"
    drift=1
  fi
}

echo "── ios / android / chain (same paths upstream)"
for area in ios/ android/ chain/; do scan "$SOURCE" "$area" "$area"; done

echo "── worker (upstream: its own repo at chatgpt-plugin-tinyai/)"
if [ -d "$SOURCE/chatgpt-plugin-tinyai/.git" ]; then
  scan "$SOURCE/chatgpt-plugin-tinyai" "" "worker/"
else
  echo "  (skipped — no worker repo at $SOURCE/chatgpt-plugin-tinyai)"
fi

echo "── web is checked by CI + its own suite; upstream web lives at the repo"
echo "   root there and was restructured here — compare app/ lib/ components/ manually."

if [ "$drift" -eq 0 ]; then
  echo "✓ no unexplained drift against upstream HEAD"
else
  echo "✗ drift found — port from upstream HEAD (git -C \"$SOURCE\" show HEAD:<file>), never from its working tree"
fi
exit "$drift"
