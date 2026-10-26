#!/bin/sh
# Builds "Ava Brain.app" (macos/launcher.c and macos/Info.plist, ad-hoc signed) into a folder, by default Ava
# Brain's data folder, and prints the path of its program. The LaunchAgent runs Ava Brain through it, so macOS
# ties Calendar (and any other) permission to "Ava Brain" instead of to whichever node Homebrew installed last.
#
# An existing app with the same CFBundleVersion is kept as it is: macOS ties permissions to the exact binary,
# so rebuilding it for nothing would make macOS ask again. Bump CFBundleVersion to ship a changed launcher.
# Needs the Xcode Command Line Tools; exits 2 without them, so the installer can fall back to plain node.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/macos"
DEST="${1:-${AVI_BRAIN_HOME:-$HOME/Library/Application Support/Avi Brain}}"
APP="$DEST/Ava Brain.app"
EXE="$APP/Contents/MacOS/ava-brain"

version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$1" 2>/dev/null || true; }

if [ -x "$EXE" ] && [ "$(version "$APP/Contents/Info.plist")" = "$(version "$SRC/Info.plist")" ] &&
  codesign --verify "$APP" 2>/dev/null; then
  printf '%s\n' "$EXE"
  exit 0
fi

# /usr/bin/cc exists without the tools too, and running it opens Apple's install dialog: ask first
if ! xcode-select -p >/dev/null 2>&1; then
  echo "The Xcode Command Line Tools are not installed (xcode-select --install), so Ava Brain.app was not built." >&2
  exit 2
fi

if [ ! -d "$DEST" ]; then
  mkdir -p "$DEST"
  chmod 700 "$DEST"
fi
WORK="$(mktemp -d "$DEST/.launcher.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BUILT="$WORK/Ava Brain.app"
mkdir -p "$BUILT/Contents/MacOS"
cp "$SRC/Info.plist" "$BUILT/Contents/Info.plist"
# One binary for Apple Silicon and Intel; the native one alone if this toolchain cannot make both
cc -O2 -Wall -mmacosx-version-min=11.0 -arch arm64 -arch x86_64 -o "$BUILT/Contents/MacOS/ava-brain" "$SRC/launcher.c" 2>/dev/null ||
  cc -O2 -Wall -mmacosx-version-min=11.0 -o "$BUILT/Contents/MacOS/ava-brain" "$SRC/launcher.c"
codesign --force --sign - --identifier com.avicopilot.brain "$BUILT" >/dev/null 2>&1

rm -rf "$APP.old"
if [ -d "$APP" ]; then mv "$APP" "$APP.old"; fi
mv "$BUILT" "$APP"
rm -rf "$APP.old"
echo "Built $APP (macOS asks for Ava Brain's permissions once for this build)." >&2
printf '%s\n' "$EXE"
