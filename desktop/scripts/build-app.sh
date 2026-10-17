#!/bin/bash
set -euo pipefail
desktop_root="$(cd "$(dirname "$0")/.." && pwd)"
swift build --package-path "$desktop_root" --configuration release
binary_dir="$(swift build --package-path "$desktop_root" --configuration release --show-bin-path)"
bundle="$desktop_root/dist/MessageGuard.app"
mkdir -p "$bundle/Contents/MacOS"
cp "$binary_dir/MessageGuard" "$bundle/Contents/MacOS/MessageGuard"
cp "$desktop_root/Info.plist" "$bundle/Contents/Info.plist"
codesign --force --sign - "$bundle"
printf 'Built %s\n' "$bundle"
