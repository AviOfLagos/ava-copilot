#!/bin/sh
# Keeps Brave, and with it Avi Copilot and "Hey Ava", running: opens Brave at login, and every hour
# opens it again if it was closed or crashed. Brave already running is left alone.
# Undo with scripts/always-on/uninstall.sh.
set -eu

LABEL=com.avicopilot.brave
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="${BRAVE_APP:-Brave Browser}"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>/usr/bin/pgrep -xq "$APP" || /usr/bin/open -g -a "$APP"</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed: Brave opens at login and is checked every hour ($PLIST)."
