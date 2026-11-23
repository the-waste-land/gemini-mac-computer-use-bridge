#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${CUA_BRIDGE_DIR:-$HOME/.local/share/cua-http-mcp}"
PLIST="$HOME/Library/LaunchAgents/com.local.cua-http-mcp.plist"

echo "==> Stopping LaunchAgent com.local.cua-http-mcp..."
launchctl bootout "gui/$(id -u)/com.local.cua-http-mcp" 2>/dev/null || true
rm -f "$PLIST"

echo "==> Removing $STATE_DIR..."
rm -rf "$STATE_DIR"

echo "Done. Remember to remove 'cua-bridge' from Gemini for Mac -> Customize -> Connectors if you no longer need it."
