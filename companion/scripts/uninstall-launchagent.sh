#!/bin/sh
# Stops Ava Brain and removes its login item. Its data (pairing, routines, artifacts, sandboxes) stays in
# ~/Library/Application Support/Avi Brain, and so does Ava Brain.app there (keeping it keeps macOS's permissions for
# a reinstall); delete that folder to forget everything.
LABEL=com.avicopilot.brain
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed."
