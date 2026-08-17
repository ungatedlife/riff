#!/usr/bin/env bash
# Cut a Riff release: bump the version everywhere, commit, tag, push.
# CI takes it from there — builds, signs, and publishes the update.
#
# Usage: ./scripts/release.sh [patch|minor|major]   (default: patch)
set -euo pipefail

BUMP="${1:-patch}"
cd "$(dirname "$0")/.."

command -v cargo >/dev/null 2>&1 || source "$HOME/.cargo/env"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree not clean — commit or stash first." >&2
  exit 1
fi

CURRENT=$(node -p "require('./package.json').version")
IFS=. read -r MAJ MIN PAT <<< "$CURRENT"
case "$BUMP" in
  patch) PAT=$((PAT + 1)) ;;
  minor) MIN=$((MIN + 1)); PAT=0 ;;
  major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
  *) echo "Usage: release.sh [patch|minor|major]" >&2; exit 1 ;;
esac
NEXT="$MAJ.$MIN.$PAT"

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json'));
pkg.version = '$NEXT';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
const confPath = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(fs.readFileSync(confPath));
conf.version = '$NEXT';
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
"
perl -pi -e "s/^version = \"\Q$CURRENT\E\"/version = \"$NEXT\"/" src-tauri/Cargo.toml
(cd src-tauri && cargo check --quiet)  # refresh Cargo.lock

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v$NEXT"
git tag "v$NEXT"
git push origin main --tags

echo "v$NEXT tagged and pushed — CI is building the release."
echo "Installed copies pick it up on their next launch."
