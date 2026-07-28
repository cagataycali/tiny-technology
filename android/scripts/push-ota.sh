#!/usr/bin/env bash
# Publish an OTA update for the tiny Android app — the analog of ios/scripts/push-ota.sh.
# Builds a release APK, stages it + manifest.json into the web app's public/android/,
# ready to deploy with the site. The app polls /android/manifest.json every 15 min
# foregrounded and offers the update in-app.
#
# Usage: scripts/push-ota.sh [notes]
set -euo pipefail

cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"

NOTES="${1:-}"
PUBLIC_DIR="../web/public/android"

VERSION_CODE=$(grep 'versionCode = ' app/build.gradle.kts | grep -o '[0-9]\+')
VERSION_NAME=$(grep 'versionName = ' app/build.gradle.kts | sed 's/.*"\(.*\)".*/\1/')

echo "Building tiny $VERSION_NAME ($VERSION_CODE)…"
./gradlew :app:assembleRelease -q

mkdir -p "$PUBLIC_DIR"
cp app/build/outputs/apk/release/app-release.apk "$PUBLIC_DIR/tiny-$VERSION_CODE.apk"

# Manifest sha256 → Updater verifies the downloaded bytes before the system
# installer sees them (older app builds ignore the extra field).
SHA256=$(shasum -a 256 "$PUBLIC_DIR/tiny-$VERSION_CODE.apk" | cut -d' ' -f1)

cat > "$PUBLIC_DIR/manifest.json" <<EOF
{
  "versionCode": $VERSION_CODE,
  "versionName": "$VERSION_NAME",
  "url": "${OTA_BASE_URL:-https://tiny.technology}/android/tiny-$VERSION_CODE.apk",
  "sha256": "$SHA256",
  "notes": "$NOTES"
}
EOF

echo "Staged: $PUBLIC_DIR/tiny-$VERSION_CODE.apk + manifest.json"
echo "Deploy the web app to publish. Devices see the update within 15 min of foregrounding."
