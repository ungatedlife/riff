#!/bin/bash
#
# Makes the copy of Riff that other people can install and that keeps itself up to date.
#
#   ./scripts/release.sh minor      raise the version (patch | minor | major), then build it
#   ./scripts/release.sh build      build the version that is already in package.json
#   ./scripts/release.sh publish    put the finished build on GitHub, where copies of Riff look
#
# Building does five things, and nothing leaves this Mac while it does:
#   1. builds Riff and signs it with your Developer ID (the certificate for apps given out
#      outside the App Store),
#   2. sends it to Apple to be checked ("notarized"), so it opens on any Mac without a warning,
#   3. wraps it in a disk image, Riff-<version>.dmg: open it and drag Riff onto Applications,
#   4. packs the same app as Riff.app.tar.gz, which is what a copy of Riff downloads to update
#      itself, and signs it with Riff's update key,
#   5. writes latest.json, the short note that copies of Riff read to find out there is a
#      newer one.
# Everything lands in src-tauri/target/release-copy/out (a folder Syncthing and git both skip).
#
# Publishing pushes main and a tag for the version to GitHub and makes a release there with
# those files. Copies of Riff read
#   https://github.com/ungatedlife/riff/releases/latest/download/latest.json
# so the newest release is the one they take.
#
# What it needs on this Mac:
#   - Xcode, signed in to your Apple developer account. Xcode does the signing and talks to
#     Apple, so no password is asked for.
#   - Riff's update key at ~/.tauri/riff-updater.key. A copy of Riff only takes an update
#     signed with it. It lives on this Mac only: copy it to the other one before releasing
#     from there, and keep a spare somewhere safe. If it is lost, no copy can be updated.
#   - gh, the GitHub command, signed in (for publish).
#
# This build is for Apple silicon Macs. For Intel as well: `rustup target add
# x86_64-apple-darwin`, then build with `--target universal-apple-darwin` and list
# darwin-x86_64 in latest.json too.

set -euo pipefail
cd "$(dirname "$0")/.."
command -v cargo >/dev/null 2>&1 || source "$HOME/.cargo/env"

STEP="${1:-}"
REPO="ungatedlife/riff"
KEY="$HOME/.tauri/riff-updater.key"
WORK="src-tauri/target/release-copy"
OUT="$WORK/out"

version() { node -p "require('./package.json').version"; }

raise_version() {
    if [[ -n "$(git status --porcelain)" ]]; then
        echo "There are uncommitted changes. Commit them first, then run this again." >&2
        exit 1
    fi
    local current next maj min pat
    current=$(version)
    IFS=. read -r maj min pat <<< "$current"
    case "$1" in
        patch) pat=$((pat + 1)) ;;
        minor) min=$((min + 1)); pat=0 ;;
        major) maj=$((maj + 1)); min=0; pat=0 ;;
    esac
    next="$maj.$min.$pat"
    node -e "
const fs = require('fs');
for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
  const json = JSON.parse(fs.readFileSync(file));
  json.version = '$next';
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}"
    perl -pi -e "s/^version = \"\Q$current\E\"/version = \"$next\"/" src-tauri/Cargo.toml
    (cd src-tauri && cargo check --quiet) # brings Cargo.lock along
    npm install --package-lock-only --silent # and package-lock.json
    git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
    git commit -qm "Release v$next"
    echo "→ Riff is now $next (committed, not pushed)."
}

build() {
    local VERSION TEAM APP ARCHIVE SIGNATURE
    VERSION=$(version)

    [[ -f "$KEY" ]] || { echo "Riff's update key is not at $KEY. See the top of this script." >&2; exit 1; }
    TEAM=$(security find-identity -v -p codesigning | sed -n 's/.*"Developer ID Application: .*(\(.*\))".*/\1/p' | head -1)
    [[ -n "$TEAM" ]] || { echo "No Developer ID Application certificate in this Mac's Keychain." >&2; exit 1; }

    rm -rf "$WORK"
    mkdir -p "$WORK" "$OUT"

    echo "→ Building Riff $VERSION… this takes a few minutes."
    npm run --silent tauri build -- --bundles app \
        --config '{"bundle":{"macOS":{"signingIdentity":"Developer ID Application"}}}' \
        > "$WORK/build.log" 2>&1 || { tail -25 "$WORK/build.log"; echo "Build failed. See $WORK/build.log"; exit 1; }
    APP="src-tauri/target/release/bundle/macos/Riff.app"

    # Xcode sends an app to Apple from an "archive": a folder with the app inside and a
    # note saying what it is. Riff is not built by Xcode, so this makes that folder by hand.
    ARCHIVE="$WORK/Riff.xcarchive"
    mkdir -p "$ARCHIVE/Products/Applications"
    ditto "$APP" "$ARCHIVE/Products/Applications/Riff.app"
    cat > "$ARCHIVE/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>ApplicationProperties</key>
	<dict>
		<key>ApplicationPath</key>
		<string>Applications/Riff.app</string>
		<key>CFBundleIdentifier</key>
		<string>media.ungated.riff</string>
		<key>CFBundleShortVersionString</key>
		<string>$VERSION</string>
		<key>CFBundleVersion</key>
		<string>$VERSION</string>
		<key>SigningIdentity</key>
		<string>Developer ID Application</string>
		<key>Team</key>
		<string>$TEAM</string>
	</dict>
	<key>ArchiveVersion</key>
	<integer>2</integer>
	<key>CreationDate</key>
	<date>$(date -u "+%Y-%m-%dT%H:%M:%SZ")</date>
	<key>Name</key>
	<string>Riff</string>
	<key>SchemeName</key>
	<string>Riff</string>
</dict>
</plist>
PLIST
    cat > "$WORK/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>developer-id</string>
	<key>destination</key>
	<string>upload</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>$TEAM</string>
</dict>
</plist>
PLIST

    echo "→ Sending it to Apple…"
    xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$WORK/export.plist" \
        -exportPath "$WORK/upload" -allowProvisioningUpdates \
        > "$WORK/export.log" 2>&1 || { grep -iE "error" "$WORK/export.log" | head -20; echo "Sending failed. See $WORK/export.log"; exit 1; }

    echo "→ Waiting for Apple's answer (usually a few minutes)…"
    for try in $(seq 1 40); do
        if xcodebuild -exportNotarizedApp -archivePath "$ARCHIVE" -exportPath "$WORK/app" > "$WORK/notarized.log" 2>&1; then
            break
        fi
        if [[ "$try" == 40 ]]; then echo "Apple has not answered after 20 minutes. See $WORK/notarized.log"; exit 1; fi
        sleep 30
    done
    APP="$WORK/app/Riff.app"
    spctl -a -vv "$APP" 2>&1 | grep -q "Notarized Developer ID" || { echo "Apple did not approve this build. See $WORK/notarized.log"; exit 1; }

    # A plain disk image: Riff, and a shortcut to Applications to drag it onto.
    echo "→ Making the disk image…"
    mkdir -p "$WORK/dmg"
    ditto "$APP" "$WORK/dmg/Riff.app"
    ln -s /Applications "$WORK/dmg/Applications"
    hdiutil create -volname "Riff" -srcfolder "$WORK/dmg" -format UDZO -ov "$OUT/Riff-$VERSION.dmg" > /dev/null
    codesign --sign "Developer ID Application" --timestamp "$OUT/Riff-$VERSION.dmg"

    # The update: the same approved app, packed, and signed with the update key. A copy of
    # Riff only takes an update whose signature matches the public key built into it.
    echo "→ Packing and signing the update…"
    COPYFILE_DISABLE=1 tar -czf "$OUT/Riff.app.tar.gz" -C "$WORK/app" Riff.app
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npx tauri signer sign --private-key-path "$KEY" "$OUT/Riff.app.tar.gz" > "$WORK/sign.log" 2>&1 \
        || { cat "$WORK/sign.log"; echo "Could not sign the update with $KEY."; exit 1; }
    SIGNATURE=$(cat "$OUT/Riff.app.tar.gz.sig")
    cat > "$OUT/latest.json" <<JSON
{
  "version": "$VERSION",
  "notes": "Riff $VERSION",
  "pub_date": "$(date -u "+%Y-%m-%dT%H:%M:%SZ")",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIGNATURE",
      "url": "https://github.com/$REPO/releases/download/v$VERSION/Riff.app.tar.gz"
    }
  }
}
JSON

    # Leave one Riff on this Mac besides the installed one: the finished files in out/.
    # Spare copies of the app in build folders can end up answering riff:// links.
    rm -rf "$WORK/app" "$WORK/dmg" "$WORK/upload" "$ARCHIVE" src-tauri/target/release/bundle

    echo "→ Ready, in $(pwd)/$OUT:"
    ls -1 "$OUT" | sed 's/^/     /'
    echo "  Nothing has left this Mac. When you are ready: ./scripts/release.sh publish"
}

publish() {
    local VERSION
    VERSION=$(version)
    for file in "Riff-$VERSION.dmg" Riff.app.tar.gz Riff.app.tar.gz.sig latest.json; do
        [[ -f "$OUT/$file" ]] || { echo "$OUT/$file is missing. Run ./scripts/release.sh build first." >&2; exit 1; }
    done
    grep -q "\"version\": \"$VERSION\"" "$OUT/latest.json" \
        || { echo "The build in $OUT is not version $VERSION. Run ./scripts/release.sh build first." >&2; exit 1; }
    [[ "$(git symbolic-ref --short HEAD)" == "main" ]] || { echo "Releases go out from main." >&2; exit 1; }
    [[ -z "$(git status --porcelain)" ]] || { echo "There are uncommitted changes. Commit them first." >&2; exit 1; }

    echo "→ Pushing main and the v$VERSION tag to GitHub…"
    if git rev-parse -q --verify "refs/tags/v$VERSION" > /dev/null; then
        [[ "$(git rev-parse "v$VERSION^{commit}")" == "$(git rev-parse HEAD)" ]] \
            || { echo "A v$VERSION tag already exists on a different commit. Raise the version instead." >&2; exit 1; }
    else
        git tag "v$VERSION"
    fi
    git push --quiet origin main
    git push --quiet origin "v$VERSION"

    echo "→ Making the release…"
    gh release create "v$VERSION" --repo "$REPO" --title "Riff $VERSION" \
        --notes "Download Riff-$VERSION.dmg, open it, and drag Riff onto Applications. Copies of Riff already installed update themselves. For Apple silicon Macs." \
        "$OUT/Riff-$VERSION.dmg" "$OUT/Riff.app.tar.gz" "$OUT/Riff.app.tar.gz.sig" "$OUT/latest.json"
    echo "→ Riff $VERSION is out: https://github.com/$REPO/releases/tag/v$VERSION"
}

case "$STEP" in
    patch | minor | major) raise_version "$STEP"; build ;;
    build) build ;;
    publish) publish ;;
    *) sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
