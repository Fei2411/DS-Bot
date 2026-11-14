#!/bin/sh
# Builds the iOS app signed for App Store Connect and, with --upload, sends it to
# TestFlight. The App Store Connect API key signs the archive through Xcode's automatic
# signing, so no certificate or profile is kept in the repository.
#
#   DS_BOT_APPLE_TEAM_ID   Apple Developer team id (10 characters)
#   APPLE_API_KEY          path to AuthKey_<KEYID>.p8
#   APPLE_API_KEY_ID       the key's id (10 characters)
#   APPLE_API_ISSUER       the key's issuer id (UUID)
#
#   sh scripts/ios-archive.sh            archive and export build/export/DSBot.ipa
#   sh scripts/ios-archive.sh --upload   export, then upload the .ipa to App Store Connect
#
# What to prepare (account, App ID, App Store Connect record, API key) and the failure
# guide are in docs/plans/2026-11-13-ios-release.md. Nothing here prints or stores the key.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"

missing=''
[ -n "${DS_BOT_APPLE_TEAM_ID:-}" ] || missing="$missing DS_BOT_APPLE_TEAM_ID"
[ -n "${APPLE_API_KEY:-}" ] || missing="$missing APPLE_API_KEY"
[ -n "${APPLE_API_KEY_ID:-}" ] || missing="$missing APPLE_API_KEY_ID"
[ -n "${APPLE_API_ISSUER:-}" ] || missing="$missing APPLE_API_ISSUER"
if [ -n "$missing" ]; then
  echo "ios-archive: not set:$missing" >&2
  echo "ios-archive: the Apple account is not set up yet; docs/plans/2026-11-13-ios-release.md lists what to prepare." >&2
  exit 2
fi
if [ ! -f "$APPLE_API_KEY" ]; then
  echo "ios-archive: APPLE_API_KEY is not a file: $APPLE_API_KEY" >&2
  exit 2
fi

upload=0
for arg in "$@"; do
  case "$arg" in
    --upload) upload=1 ;;
    *) echo "ios-archive: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

echo "ios-archive: generating the iOS project"
npx expo prebuild --platform ios --no-install
(cd ios && pod install)

# Automatic signing creates the App Store profile from the API key; the method says
# App Store Connect (TestFlight), and the team comes from the environment.
mkdir -p ios/build
cat > ios/build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$DS_BOT_APPLE_TEAM_ID</string>
</dict>
</plist>
PLIST

echo "ios-archive: archiving (automatic signing with the App Store Connect key)"
xcodebuild -workspace ios/DSBot.xcworkspace -scheme DSBot -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath ios/build/DSBot.xcarchive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$APPLE_API_KEY" \
  -authenticationKeyID "$APPLE_API_KEY_ID" \
  -authenticationKeyIssuerID "$APPLE_API_ISSUER" \
  archive

echo "ios-archive: exporting the .ipa"
rm -rf ios/build/export
xcodebuild -exportArchive \
  -archivePath ios/build/DSBot.xcarchive \
  -exportPath ios/build/export \
  -exportOptionsPlist ios/build/ExportOptions.plist \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$APPLE_API_KEY" \
  -authenticationKeyID "$APPLE_API_KEY_ID" \
  -authenticationKeyIssuerID "$APPLE_API_ISSUER"

ipa=$(ls ios/build/export/*.ipa 2>/dev/null | head -1)
if [ -z "$ipa" ]; then
  echo "ios-archive: no .ipa in ios/build/export" >&2
  exit 1
fi
echo "ios-archive: $ipa"

if [ "$upload" -eq 1 ]; then
  echo "ios-archive: uploading to App Store Connect (TestFlight)"
  xcrun altool --upload-app --type ios -f "$ipa" \
    --apiKey "$APPLE_API_KEY_ID" \
    --apiIssuer "$APPLE_API_ISSUER" \
    --p8-file-path "$APPLE_API_KEY"
fi
