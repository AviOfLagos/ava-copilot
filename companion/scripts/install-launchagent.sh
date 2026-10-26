#!/bin/sh
# Runs Ava Brain at login and keeps it running (launchd restarts it if it stops). Builds what it needs
# first: the companion bundle and the eve agent, with eve's telemetry off. Then prints a pairing code to
# type into Ava Copilot › Settings › Ava Brain. Undo with scripts/uninstall-launchagent.sh.
# It runs node through "Ava Brain.app" (scripts/build-launcher.sh), so macOS keeps Calendar permission for
# "Ava Brain" when Homebrew upgrades node.
#
#   --runtime-only   only (re)build Ava Brain.app and point the LaunchAgent at it, then restart Ava Brain
# LABEL and LOGS keep their original "avicopilot"/"Avi Brain" values so an existing install's LaunchAgent
# and logs are reused in place rather than leaving an orphaned old one behind.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.avicopilot.brain
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/Avi Brain"
DATA="${AVI_BRAIN_HOME:-$HOME/Library/Application Support/Avi Brain}"
# The PATH entry (e.g. /opt/homebrew/bin/node), not the versioned binary it points to, so upgrades are picked up
NODE="${NODE:-$(command -v node || true)}"
RUNTIME_ONLY=0
if [ "${1:-}" = "--runtime-only" ]; then RUNTIME_ONLY=1; fi

if [ -z "$NODE" ] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "Ava Brain needs Node 24 or newer (https://nodejs.org)."
  exit 1
fi
cd "$HERE"
if [ "$RUNTIME_ONLY" = 0 ]; then
  if [ ! -x "$HERE/node_modules/.bin/eve" ]; then
    echo "Install the companion's dependencies first:"
    echo "  cd \"$HERE\" && snare shield check . && pnpm install"
    exit 1
  fi
  echo "Building Ava Brain…"
  "$NODE" scripts/build.mjs >/dev/null
  # Every eve command reports usage to Vercel unless told not to: off for this command and saved off
  EVE_TELEMETRY_DISABLED=1 node_modules/.bin/eve telemetry disable >/dev/null 2>&1 || true
  EVE_TELEMETRY_DISABLED=1 node_modules/.bin/eve build --skip-sandbox-prewarm >/dev/null
elif [ ! -f "$HERE/dist/nex-brain.mjs" ]; then
  echo "Ava Brain is not built yet: run this script without --runtime-only."
  exit 1
fi

# Paths go into XML
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# Ava Brain.app runs node as its child, so macOS asks for (and keeps) permissions as "Ava Brain"
if LAUNCHER="$(sh "$HERE/scripts/build-launcher.sh" "$DATA")"; then
  PROGRAM="<string>$(xml "$LAUNCHER")</string>
    "
else
  echo "Running Ava Brain as plain node: macOS will ask for Calendar again after each Node upgrade."
  PROGRAM=""
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"
chmod 700 "$LOGS"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    $PROGRAM<string>$(xml "$NODE")</string>
    <string>$(xml "$HERE/dist/nex-brain.mjs")</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$HERE")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EVE_TELEMETRY_DISABLED</key><string>1</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <!-- 077: what Ava Brain writes is readable by this user only -->
  <key>Umask</key><integer>63</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml "$LOGS/brain.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/brain.log")</string>
</dict>
</plist>
PLIST
chmod 600 "$PLIST"

# bootout returns before the old job is gone, and a bootstrap then fails with "5: Input/output error" and
# leaves Ava Brain stopped: wait for it to go (up to 10 s), and try the bootstrap a few times
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
tries=0
while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ "$tries" -lt 20 ]; do
  sleep 0.5
  tries=$((tries + 1))
done
tries=0
until launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -ge 5 ]; then
    echo "Could not start Ava Brain. Try: launchctl bootstrap $DOMAIN \"$PLIST\""
    exit 1
  fi
  sleep 1
done
echo "Installed: Ava Brain starts at login and on 127.0.0.1 only ($PLIST)."
echo "Logs: $LOGS/brain.log"
if [ -n "$PROGRAM" ]; then
  echo "macOS now asks for Calendar as “Ava Brain” (once per launcher build, not per Node upgrade):"
  echo "  Ava Copilot › Settings › Calendar › Allow access, then choose Allow on the Mac."
fi
if [ "$RUNTIME_ONLY" = 1 ]; then exit 0; fi

if docker info >/dev/null 2>&1; then
  if ! docker image inspect avi-brain-sandbox:1 >/dev/null 2>&1; then
    echo "Building the sandbox image (once; it downloads Node and Python)…"
    "$NODE" dist/nex-brain.mjs sandbox-build
  fi
else
  echo
  echo "Docker is not running. Start Docker Desktop, then run: cd \"$HERE\" && pnpm sandbox:build"
  echo "Until then Ava Brain works, but cannot run code or build artifacts."
fi

"$NODE" dist/nex-brain.mjs pair
