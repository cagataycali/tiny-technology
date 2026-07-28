#!/bin/bash
# auto-enroll.sh — fully automatic beta pipeline. Runs hourly (devduck scheduler).
#
#   1. Pull enrolled UDIDs from tiny.technology (machine-auth)
#   2. Diff against ~/.tiny-enrolled-udids (already-shipped set)
#   3. New UDIDs?  → register via ASC API (needs ASC_KEY_ID/ASC_ISSUER_ID/ASC_KEY_PATH)
#                  → rebuild + re-sign the IPA (fresh profile includes them)
#                  → commit + push web/public/ios/Tiny.ipa (Vercel ships it)
#   4. No ASC key? → just report the pending UDIDs and exit 0
#
# Env: ENROLL_SECRET (required), OTA_TEAM_ID (required for the rebuild),
#      ASC_* (optional but needed for zero-touch),
#      TINY_REPO (optional — defaults to the checkout this script lives in)
set -euo pipefail
REPO="${TINY_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
STATE="$HOME/.tiny-enrolled-udids"
touch "$STATE"

[ -z "${ENROLL_SECRET:-}" ] && { echo "ENROLL_SECRET not set"; exit 1; }

UDIDS=$(curl -sf "https://tiny.technology/api/udid?list=1" -H "x-enroll-key: $ENROLL_SECRET" \
  | python3 -c "import json,sys; [print(r['udid']) for r in json.load(sys.stdin).get('devices',[])]")

NEW=$(comm -13 <(sort "$STATE") <(echo "$UDIDS" | sort) | grep -v '^$' || true)
if [ -z "$NEW" ]; then
  echo "✅ No new devices ($(wc -l < "$STATE" | tr -d ' ') already enrolled)"
  exit 0
fi

echo "🆕 New devices:"; echo "$NEW"

if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -f "${ASC_KEY_PATH:-/nonexistent}" ]; then
  echo "🔑 Registering via App Store Connect API…"
  while read -r udid; do
    [ -z "$udid" ] && continue
    JWT=$(python3 - <<PY
import jwt, time, os
print(jwt.encode({"iss": os.environ["ASC_ISSUER_ID"], "exp": int(time.time())+600, "aud": "appstoreconnect-v1"},
      open(os.environ["ASC_KEY_PATH"]).read(), algorithm="ES256", headers={"kid": os.environ["ASC_KEY_ID"]}))
PY
)
    RESP=$(curl -s -X POST https://api.appstoreconnect.apple.com/v1/devices \
      -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
      -d "{\"data\":{\"type\":\"devices\",\"attributes\":{\"name\":\"beta-$udid\",\"platform\":\"IOS\",\"udid\":\"$udid\"}}}")
    # 201 = registered, 409 = already exists — both fine
    echo "$RESP" | grep -q '"errors"' && echo "$RESP" | head -c 300 || echo "  ✓ $udid"
  done <<< "$NEW"

  echo "🔨 Rebuilding IPA with refreshed profile…"
  cd "$REPO/ios"
  xcodebuild -project Tiny.xcodeproj -scheme Tiny -destination 'generic/platform=iOS' \
    -configuration Release -allowProvisioningUpdates \
    -derivedDataPath /tmp/tiny-archive archive -archivePath /tmp/tiny-archive/Tiny.xcarchive 2>&1 | tail -1
  [ -z "${OTA_TEAM_ID:-}" ] && { echo "set OTA_TEAM_ID to your Apple Developer Team ID"; exit 1; }
  cat > /tmp/tiny-export.plist << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>debugging</string>
  <key>teamID</key><string>${OTA_TEAM_ID}</string>
  <key>compileBitcode</key><false/>
</dict></plist>
PLIST
  xcodebuild -exportArchive -archivePath /tmp/tiny-archive/Tiny.xcarchive \
    -exportPath /tmp/tiny-ipa -exportOptionsPlist /tmp/tiny-export.plist -allowProvisioningUpdates 2>&1 | tail -1
  cp /tmp/tiny-ipa/Tiny.ipa "$REPO/web/public/ios/Tiny.ipa"

  cd "$REPO"
  git add -f web/public/ios/Tiny.ipa
  git commit -m "ios: auto-enroll $(echo "$NEW" | wc -l | tr -d ' ') new beta device(s) — re-signed IPA" || true
  git push
  echo "$UDIDS" | sort > "$STATE"
  echo "🚀 Shipped — new devices can install from tiny.technology/ios"
else
  echo "⚠️ ASC API key missing (ASC_KEY_ID/ASC_ISSUER_ID/ASC_KEY_PATH)"
  echo "   Pending manual registration: https://developer.apple.com/account/resources/devices/list"
fi
