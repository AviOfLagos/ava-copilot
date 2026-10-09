#!/bin/sh
# Removes the login item that keeps Brave open.
LABEL=com.avicopilot.brave
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed."
