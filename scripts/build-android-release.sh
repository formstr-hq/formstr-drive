#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION=$(node -e "const p=require('$PROJECT_DIR/package.json'); process.stdout.write(p.androidVersion)")

read -rsp "Keystore password: " PASSWORD
echo

export ANDROID_STORE_PASSWORD="$PASSWORD"
export ANDROID_KEY_PASSWORD="$PASSWORD"

cd "$PROJECT_DIR/android"
./gradlew assembleRelease -PkeystorePropertiesFile="$PROJECT_DIR/android/keystore.properties"

SRC="$PROJECT_DIR/android/app/build/outputs/apk/release/app-release.apk"
SHA=$(sha256sum "$SRC" | cut -c1-5)
APK_NAME="formstr-drive-${VERSION}-${SHA}.apk"
DEST="$PROJECT_DIR/$APK_NAME"
mv "$SRC" "$DEST"

echo "APK: $DEST"
