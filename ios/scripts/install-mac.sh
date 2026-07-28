#!/usr/bin/env bash
# install-mac.sh — build the Mac Catalyst app (Release) and install it to
# /Applications, so the Mac app launches from Spotlight/Dock and survives
# DerivedData cleans. The Mac twin of push-ota.sh's job: this is how a new
# build reaches the machine (the OTA updater is deliberately silent under
# Catalyst — Update.swift).
set -euo pipefail
cd "$(dirname "$0")/.."

DEST='platform=macOS,variant=Mac Catalyst,arch=arm64'

xcodebuild -project Tiny.xcodeproj -scheme Tiny -configuration Release \
  -destination "$DEST" -allowProvisioningUpdates build

APP=$(xcodebuild -project Tiny.xcodeproj -scheme Tiny -configuration Release \
  -destination "$DEST" -showBuildSettings 2>/dev/null |
  awk -F' = ' '/ BUILT_PRODUCTS_DIR/{d=$2} / FULL_PRODUCT_NAME/{n=$2} END{print d"/"n}')
[ -d "$APP" ] || { echo "built app not found: $APP" >&2; exit 1; }

# Replace a running copy in place; ditto preserves signatures/xattrs
pkill -f "Tiny.app/Contents/MacOS/Tiny" 2>/dev/null || true
sleep 1
rm -rf /Applications/Tiny.app
ditto "$APP" /Applications/Tiny.app

open /Applications/Tiny.app
echo "Installed /Applications/Tiny.app (build $(defaults read /Applications/Tiny.app/Contents/Info CFBundleVersion))"
