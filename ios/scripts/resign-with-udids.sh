#!/bin/bash
# resign-with-udids.sh — pull enrolled UDIDs, remind to register, rebuild IPA.
#
# Apple offers no public API for device registration on a standard account
# (App Store Connect API can do it with an API key: set ASC_KEY_ID/ASC_ISSUER_ID
# and this script will register devices automatically via the ASC API).
#
# Usage: ./resign-with-udids.sh [session-cookie]
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "📱 Enrolled UDIDs (from tiny.technology KV):"
UDIDS=$(curl -s "https://tiny.technology/api/udid?list=1" -H "Cookie: ${1:-}" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for row in d.get('devices', []):
    meta = row.get('meta') or {}
    print(f\"  {row['udid']}  ({meta.get('product','?')} iOS {meta.get('version','?')})\")
    print(row['udid'], file=sys.stderr)
" 2>/tmp/udids.txt)
echo "$UDIDS"

if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -f "${ASC_KEY_PATH:-}" ]; then
  echo "🔑 Registering via App Store Connect API…"
  while read -r udid; do
    [ -z "$udid" ] && continue
    xcrun altool 2>/dev/null || true  # placeholder: use asc-api curl below
    # POST /v1/devices {name, platform: IOS, udid}
    JWT=$(python3 - <<PY
import jwt, time, os
print(jwt.encode({"iss": os.environ["ASC_ISSUER_ID"], "exp": int(time.time())+600, "aud": "appstoreconnect-v1"},
      open(os.environ["ASC_KEY_PATH"]).read(), algorithm="ES256", headers={"kid": os.environ["ASC_KEY_ID"]}))
PY
)
    curl -s -X POST https://api.appstoreconnect.apple.com/v1/devices \
      -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
      -d "{\"data\":{\"type\":\"devices\",\"attributes\":{\"name\":\"enrolled-$udid\",\"platform\":\"IOS\",\"udid\":\"$udid\"}}}" | head -c 200
    echo
  done < /tmp/udids.txt
else
  echo ""
  echo "⚠️  No ASC API key configured (ASC_KEY_ID/ASC_ISSUER_ID/ASC_KEY_PATH)."
  echo "   Register the UDIDs manually: https://developer.apple.com/account/resources/devices/list"
  read -p "Press enter once devices are registered in the portal…"
fi

echo "🔨 Rebuilding + re-signing (profile refresh picks up new devices)…"
cd ios
xcodebuild -project Tiny.xcodeproj -scheme Tiny -destination 'generic/platform=iOS' \
  -configuration Release -allowProvisioningUpdates \
  -derivedDataPath /tmp/tiny-archive archive -archivePath /tmp/tiny-archive/Tiny.xcarchive | tail -1
xcodebuild -exportArchive -archivePath /tmp/tiny-archive/Tiny.xcarchive \
  -exportPath /tmp/tiny-ipa -exportOptionsPlist /tmp/tiny-export.plist -allowProvisioningUpdates | tail -1
cp /tmp/tiny-ipa/Tiny.ipa ../public/ios/Tiny.ipa
cd ..
echo "✅ public/ios/Tiny.ipa updated — commit + push to ship."
