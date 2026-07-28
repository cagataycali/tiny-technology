#!/usr/bin/env bash
# The real Node tray server ↔ the real Swift TrayController.
#
# Not part of `swift test`: it needs `npm run build` output and a Node process,
# and a unit suite that silently depends on both is a unit suite that fails for
# reasons unrelated to the code under test. Run it when either side of the
# protocol changes:  menubar/xlang/check.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
sock="/tmp/tiny-xlang-$$.sock"
driver="$(mktemp -t xlang-driver)"

cleanup() {
  [[ -n "${server_pid:-}" ]] && kill "$server_pid" 2>/dev/null || true
  rm -f "$sock" "$driver"
}
trap cleanup EXIT

if [[ ! -f "$root/dist/tray.js" ]]; then
  echo "xlang: $root/dist/tray.js is missing — run npm run build first" >&2
  exit 1
fi

# One module, no import: SwiftPM links TinyMenuKit into its executable rather
# than leaving an archive to link against.
swiftc -O -o "$driver" "$here/../Sources/TinyMenuKit/"*.swift "$here/main.swift"

node "$here/fixture-daemon.mjs" "$sock" &
server_pid=$!

for _ in $(seq 1 50); do
  [[ -S "$sock" ]] && break
  sleep 0.1
done
if [[ ! -S "$sock" ]]; then
  echo "xlang: the fixture never bound $sock" >&2
  exit 1
fi

"$driver" "$sock"
