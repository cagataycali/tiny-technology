#!/bin/bash
# push-ota.sh — ship the current ios/ tree to tiny.technology/ios (OTA).
#
#   1. Read CURRENT_PROJECT_VERSION from project.yml (bump it BEFORE running)
#   2. xcodegen + Release archive + export (same recipe as auto-enroll.sh)
#   3. Sync manifest.plist bundle-version to the build number
#   4. Commit public/ios/ + push — Vercel serves it; the in-app Updater
#      (Update.swift) shows the install banner on devices within ~15min
#
# Usage: ios/scripts/push-ota.sh [commit message]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO/ios"

BUILD=$(grep -E '^\s*CURRENT_PROJECT_VERSION:' project.yml | head -1 | sed 's/[^0-9]//g')
[ -z "$BUILD" ] && { echo "CURRENT_PROJECT_VERSION not found in project.yml"; exit 1; }
echo "📦 Building OTA build ${BUILD}…"

xcodegen generate >/dev/null
xcodebuild -project Tiny.xcodeproj -scheme Tiny -destination 'generic/platform=iOS' \
  -configuration Release -allowProvisioningUpdates \
  -derivedDataPath /tmp/tiny-ota archive -archivePath /tmp/tiny-ota/Tiny.xcarchive 2>&1 | tail -1 \
  || { echo "❌ archive failed — rerun without the pipe for details"; exit 1; }

# Your Apple Developer Team ID (Membership page). Required — exports are
# team-scoped, so there is no meaningful default.
[ -z "${OTA_TEAM_ID:-}" ] && { echo "❌ set OTA_TEAM_ID to your Apple Developer Team ID"; exit 1; }

cat > /tmp/tiny-ota-export.plist << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>debugging</string>
  <key>teamID</key><string>${OTA_TEAM_ID}</string>
  <key>compileBitcode</key><false/>
</dict></plist>
PLIST

rm -rf /tmp/tiny-ota-ipa
# Stale local profiles are the recurring export killer (e.g. a profile
# predating a newly-registered device). On failure: wipe + one retry —
# -allowProvisioningUpdates regenerates them with the current device set.
if ! xcodebuild -exportArchive -archivePath /tmp/tiny-ota/Tiny.xcarchive \
  -exportPath /tmp/tiny-ota-ipa -exportOptionsPlist /tmp/tiny-ota-export.plist \
  -allowProvisioningUpdates 2>&1 | tail -1; then
  echo "⚠️  export failed — wiping cached provisioning profiles and retrying…"
  rm -rf ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/* \
         ~/Library/MobileDevice/Provisioning\ Profiles/* 2>/dev/null || true
  xcodebuild -project Tiny.xcodeproj -scheme Tiny -destination 'generic/platform=iOS' \
    -configuration Release -allowProvisioningUpdates -derivedDataPath /tmp/tiny-ota build 2>&1 | tail -1
  xcodebuild -exportArchive -archivePath /tmp/tiny-ota/Tiny.xcarchive \
    -exportPath /tmp/tiny-ota-ipa -exportOptionsPlist /tmp/tiny-ota-export.plist \
    -allowProvisioningUpdates 2>&1 | tail -1 \
    || { echo "❌ export failed twice — inspect manually"; exit 1; }
fi
[ -f /tmp/tiny-ota-ipa/Tiny.ipa ] || { echo "❌ no IPA produced"; exit 1; }

PUBLIC_IOS="$REPO/web/public/ios"
mkdir -p "$PUBLIC_IOS"
cp /tmp/tiny-ota-ipa/Tiny.ipa "$PUBLIC_IOS/Tiny.ipa"

# Generate the OTA manifest fresh — it is deployment state, not source, so a
# clean clone has none. OTA_BASE_URL is where YOUR web deployment serves
# /ios/Tiny.ipa; BUNDLE_ID must match what the archive was signed as.
OTA_BASE_URL="${OTA_BASE_URL:-https://tiny.technology}"
BUNDLE_ID="${BUNDLE_ID:-technology.tiny.app}"
cat > "$PUBLIC_IOS/manifest.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>items</key>
	<array>
		<dict>
			<key>assets</key>
			<array>
				<dict>
					<key>kind</key>
					<string>software-package</string>
					<key>url</key>
					<string>${OTA_BASE_URL}/ios/Tiny.ipa</string>
				</dict>
			</array>
			<key>metadata</key>
			<dict>
				<key>bundle-identifier</key>
				<string>${BUNDLE_ID}</string>
				<key>bundle-version</key>
				<string>${BUILD}</string>
				<key>kind</key>
				<string>software</string>
				<key>title</key>
				<string>tiny</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>
PLIST

cd "$REPO"
git add -f web/public/ios/Tiny.ipa web/public/ios/manifest.plist
# --only: a bare `git commit` records the ENTIRE shared index — concurrent
# sessions stage work in this repo constantly, and build 49 silently swept a
# staged deletion of a public APK into its publish commit, 404ing the Android
# OTA manifest. Commit exactly our two artifacts.
git commit --only web/public/ios/Tiny.ipa --only web/public/ios/manifest.plist \
  -m "${1:-ios: OTA build $BUILD}" || { echo "nothing to commit"; exit 0; }
git push
echo "🚀 OTA build $BUILD staged — devices see the banner once your deploy serves ${OTA_BASE_URL}/ios"
