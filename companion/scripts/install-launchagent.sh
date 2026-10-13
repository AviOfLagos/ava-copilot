#!/bin/sh
# Runs Nex Brain at login and keeps it running (launchd restarts it if it stops). Builds what it needs
# first: the companion bundle and the eve agent, with eve's telemetry off. Then prints a pairing code to
# type into Nex Copilot › Settings › Nex Brain. Undo with scripts/uninstall-launchagent.sh.
# LABEL and LOGS keep their original "avicopilot"/"Avi Brain" values so an existing install's LaunchAgent
# and logs are reused in place rather than leaving an orphaned old one behind.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.avicopilot.brain
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/Avi Brain"
NODE="${NODE:-$(command -v node || true)}"

if [ -z "$NODE" ] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "Nex Brain needs Node 24 or newer (https://nodejs.org)."
  exit 1
fi
if [ ! -x "$HERE/node_modules/.bin/eve" ]; then
  echo "Install the companion's dependencies first:"
  echo "  cd \"$HERE\" && snare shield check . && pnpm install"
  exit 1
fi

cd "$HERE"
echo "Building Nex Brain…"
"$NODE" scripts/build.mjs >/dev/null
# Every eve command reports usage to Vercel unless told not to: off for this command and saved off
EVE_TELEMETRY_DISABLED=1 node_modules/.bin/eve telemetry disable >/dev/null 2>&1 || true
EVE_TELEMETRY_DISABLED=1 node_modules/.bin/eve build --skip-sandbox-prewarm >/dev/null

# Paths go into XML
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

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
    <string>$(xml "$NODE")</string>
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
  <!-- 077: what Nex Brain writes is readable by this user only -->
  <key>Umask</key><integer>63</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml "$LOGS/brain.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/brain.log")</string>
</dict>
</plist>
PLIST
chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed: Nex Brain starts at login and on 127.0.0.1 only ($PLIST)."
echo "Logs: $LOGS/brain.log"

if docker info >/dev/null 2>&1; then
  if ! docker image inspect avi-brain-sandbox:1 >/dev/null 2>&1; then
    echo "Building the sandbox image (once; it downloads Node and Python)…"
    "$NODE" dist/nex-brain.mjs sandbox-build
  fi
else
  echo
  echo "Docker is not running. Start Docker Desktop, then run: cd \"$HERE\" && pnpm sandbox:build"
  echo "Until then Nex Brain works, but cannot run code or build artifacts."
fi

"$NODE" dist/nex-brain.mjs pair
