#!/bin/bash
# build-on-device.sh — build & install the tiny iOS app on YOUR device, one shot.
#
# For contributors who are NOT on the core Apple team: this script
#   1. finds your connected iPhone/iPad (devicectl)
#   2. finds your Apple Development team (or use DEVELOPMENT_TEAM=XXXXXXXXXX)
#   3. retargets every bundle id / app group / keychain group from
#      technology.tiny.* to a prefix unique to your team (App IDs are
#      globally unique at Apple — you can't provision someone else's)
#   4. builds the Tiny scheme signed with your team, installs it over the
#      cable, and launches it
#
# Usage:            ios/scripts/build-on-device.sh
# Env overrides:    DEVICE_ID=<udid>            pick a device explicitly
#                   DEVELOPMENT_TEAM=ABCDE12345 pick a team explicitly
#                   BUNDLE_PREFIX=dev.me.tiny   custom bundle-id prefix
#                   SKIP_RETARGET=1             keep technology.tiny.* ids
#                                               (core-team members only)
#
# The retarget edits tracked files IN PLACE (pbxproj, plists, entitlements,
# a few .swift files that hold the app-group string). Don't commit them —
# undo with:  git -C "$(git rev-parse --show-toplevel)" checkout -- ios
set -euo pipefail

# The Apple team that owns the upstream `technology.tiny.*` App IDs. Empty in
# the open-source tree: every contributor's build retargets to their own
# bundle-id prefix (step 3), which is what you want — your team cannot
# provision the upstream App IDs. Upstream maintainers export CORE_TEAM (or
# SKIP_RETARGET=1) to keep the shipping identifiers.
CORE_TEAM="${CORE_TEAM:-}"
IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$IOS_DIR"

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. preflight ────────────────────────────────────────────────────────────
command -v xcodebuild >/dev/null || die "xcodebuild not found — install Xcode from the App Store"
case "$(xcode-select -p)" in
  *CommandLineTools*) die "xcode-select points at the Command Line Tools, not Xcode.
  Fix:  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" ;;
esac

# ── 1. device ───────────────────────────────────────────────────────────────
say "Looking for a connected iPhone/iPad…"
DEVJSON="$(mktemp)"; trap 'rm -f "$DEVJSON"' EXIT
xcrun devicectl list devices --json-output "$DEVJSON" >/dev/null 2>&1 \
  || die "devicectl failed — is Xcode 15+ installed and opened at least once?"

# lines: <identifier>\t<connected|paired>\t<name> (<os>), connected first
DEVICES="$(python3 - "$DEVJSON" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
rows = []
for d in data.get("result", {}).get("devices", []):
    hw, dp, cp = (d.get(k, {}) for k in
                  ("hardwareProperties", "deviceProperties", "connectionProperties"))
    if hw.get("platform") != "iOS":
        continue
    state = "connected" if cp.get("tunnelState") == "connected" else "paired"
    rows.append((0 if state == "connected" else 1, d["identifier"], state,
                 f'{dp.get("name","?")} ({hw.get("deviceType","?")}, iOS {dp.get("osVersionNumber","?")})'))
rows.sort()
for _, ident, state, label in rows:
    print(f"{ident}\t{state}\t{label}")
PY
)"

if [ -n "${DEVICE_ID:-}" ]; then
  DEV_LABEL="$DEVICE_ID (DEVICE_ID override)"
else
  [ -n "$DEVICES" ] || die "No iPhone/iPad known to this Mac.
  Plug the device in with a cable, unlock it, tap 'Trust This Computer',
  and enable Settings → Privacy & Security → Developer Mode (reboot), then rerun."
  FIRST="$(printf '%s\n' "$DEVICES" | head -1)"
  [ "$(printf '%s' "$FIRST" | cut -f2)" = "connected" ] || die "Devices are paired but none is connected right now:
$(printf '%s\n' "$DEVICES" | awk -F'\t' '{print "  - "$3" ["$2"]"}')
  Plug one in (cable is the reliable path) and rerun, or set DEVICE_ID=<id>."
  DEVICE_ID="$(printf '%s' "$FIRST" | cut -f1)"
  DEV_LABEL="$(printf '%s' "$FIRST" | cut -f3)"
  N_CONN="$(printf '%s\n' "$DEVICES" | awk -F'\t' '$2=="connected"' | wc -l | tr -d ' ')"
  if [ "$N_CONN" -gt 1 ]; then
    say "Multiple connected devices — picked the first. Override with DEVICE_ID=<id>:
$(printf '%s\n' "$DEVICES" | awk -F'\t' '$2=="connected"{print "    "$1"  "$3}')"
  fi
fi
say "Device: $DEV_LABEL"

# ── 2. team ─────────────────────────────────────────────────────────────────
TEAM="${DEVELOPMENT_TEAM:-}"
if [ -z "$TEAM" ]; then
  TEAM="$(security find-certificate -c "Apple Development" -p 2>/dev/null \
          | openssl x509 -noout -subject 2>/dev/null \
          | sed -nE 's/.*OU ?= ?([A-Z0-9]{10}).*/\1/p' | head -1)"
fi
[ -n "$TEAM" ] || die "No Apple Development certificate found and DEVELOPMENT_TEAM is unset.
  In Xcode: Settings → Accounts → add your Apple ID → Manage Certificates →
  '+' → Apple Development. Then rerun (or rerun with DEVELOPMENT_TEAM=<your team id>)."
say "Signing team: $TEAM"

# ── 3. bundle-id retarget ───────────────────────────────────────────────────
APP_ID="technology.tiny.app"
if [ "$TEAM" = "$CORE_TEAM" ] || [ -n "${SKIP_RETARGET:-}" ]; then
  say "Core team / SKIP_RETARGET — keeping technology.tiny.* bundle ids"
else
  PREFIX="${BUNDLE_PREFIX:-dev.t$(printf '%s' "$TEAM" | tr '[:upper:]' '[:lower:]').tiny}"
  APP_ID="${PREFIX}.app"
  say "Retargeting bundle ids: technology.tiny.* → ${PREFIX}.* (your team can't provision the upstream App IDs)"
  grep -rIl --exclude-dir=build --exclude-dir=scripts --exclude='*.md' 'technology\.tiny' . \
    | while IFS= read -r f; do sed -i '' "s/technology\\.tiny/${PREFIX}/g" "$f"; done
  say "Tracked files were edited in place — don't commit; undo later with: git checkout -- ios"
fi

# ── 4. regenerate project (optional) + build ────────────────────────────────
if command -v xcodegen >/dev/null; then
  say "xcodegen generate"
  xcodegen generate >/dev/null
else
  say "xcodegen not installed — using the committed Tiny.xcodeproj (fine)"
fi

say "Building (first run also creates signing certs/profiles — may prompt for your login keychain)…"
xcodebuild -project Tiny.xcodeproj -scheme Tiny \
  -destination "id=${DEVICE_ID}" \
  -configuration Debug \
  -derivedDataPath build/device \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" \
  build

APP_PATH="build/device/Build/Products/Debug-iphoneos/Tiny.app"
[ -d "$APP_PATH" ] || die "Build finished but $APP_PATH is missing"

# ── 5. install + launch ─────────────────────────────────────────────────────
say "Installing on the device (keep it unlocked)…"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH"

say "Launching…"
xcrun devicectl device process launch --device "$DEVICE_ID" "$APP_ID" >/dev/null 2>&1 \
  || say "Couldn't auto-launch (device locked, or the developer isn't trusted yet).
  On the device: Settings → General → VPN & Device Management → trust your developer, then open 'tiny'."

say "Done — 'tiny' ($APP_ID) is on $DEV_LABEL"
