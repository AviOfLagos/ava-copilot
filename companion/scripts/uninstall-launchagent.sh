#!/bin/sh
# Stops Nex Brain and removes its login item. Its data (pairing, routines, artifacts, sandboxes) stays in
# ~/Library/Application Support/Avi Brain; delete that folder to forget everything.
LABEL=com.avicopilot.brain
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed."
