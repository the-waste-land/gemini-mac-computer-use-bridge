#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Error: This bridge only supports macOS." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="${CUA_BRIDGE_DIR:-$HOME/.local/share/cua-http-mcp}"
PORT="${CUA_BRIDGE_PORT:-18765}"
PLIST="$HOME/Library/LaunchAgents/com.local.cua-http-mcp.plist"

NODE_BIN="${CUA_NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "Error: node (>= 22) not found in PATH. Install Node.js 22+ or set CUA_NODE_BIN." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Node.js >= 22 is required (found $("$NODE_BIN" -v) at $NODE_BIN)." >&2
  exit 1
fi

echo "==> Using Node: $NODE_BIN ($("$NODE_BIN" -v))"
mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE_DIR"

# Install codex-computer-use-mcp locally if not already available
MCP_SCRIPT="${CUA_MCP_SCRIPT:-}"
if [ -z "$MCP_SCRIPT" ]; then
  if [ -f "$HOME/.pi/agent/npm/node_modules/codex-computer-use-mcp/dist/mcp-server.js" ]; then
    MCP_SCRIPT="$HOME/.pi/agent/npm/node_modules/codex-computer-use-mcp/dist/mcp-server.js"
    echo "==> Reusing existing codex-computer-use-mcp at $MCP_SCRIPT"
  else
    echo "==> Installing codex-computer-use-mcp into $STATE_DIR/runtime ..."
    mkdir -p "$STATE_DIR/runtime"
    npm --prefix "$STATE_DIR/runtime" install --no-audit --no-fund codex-computer-use-mcp
    MCP_SCRIPT="$STATE_DIR/runtime/node_modules/codex-computer-use-mcp/dist/mcp-server.js"
  fi
fi

# Check runtime status before proceeding
echo "==> Verifying codex-computer-use-mcp runtime..."
"$NODE_BIN" "$MCP_SCRIPT" --status || true

# Generate per-machine loopback Bearer token (mode 600)
if [ ! -f "$STATE_DIR/token" ]; then
  openssl rand -hex 24 > "$STATE_DIR/token"
  chmod 600 "$STATE_DIR/token"
fi

# Install server and bridge scripts
cp "$REPO_DIR/src/server.mjs" "$STATE_DIR/server.mjs"
cp "$REPO_DIR/src/bridge.mjs" "$STATE_DIR/bridge.mjs"

cat > "$STATE_DIR/bridge.sh" <<EOF
#!/bin/sh
export CUA_BRIDGE_DIR="$STATE_DIR"
export CUA_BRIDGE_PORT="$PORT"
exec "$NODE_BIN" "$STATE_DIR/bridge.mjs"
EOF
chmod +x "$STATE_DIR/bridge.sh"

# Install and load LaunchAgent
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.cua-http-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$STATE_DIR/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CUA_BRIDGE_DIR</key>
    <string>$STATE_DIR</string>
    <key>CUA_BRIDGE_PORT</key>
    <string>$PORT</string>
    <key>CUA_NODE_BIN</key>
    <string>$NODE_BIN</string>
    <key>CUA_MCP_SCRIPT</key>
    <string>$MCP_SCRIPT</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$STATE_DIR/server.log</string>
  <key>StandardErrorPath</key>
  <string>$STATE_DIR/server.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.local.cua-http-mcp" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2

echo "==> Checking health endpoint..."
curl -fsS "http://127.0.0.1:$PORT/health"
echo ""

echo "==> Running end-to-end MCP bridge self-test..."
"$NODE_BIN" -e '
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const p = spawn(process.argv[1], [], { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: p.stdout });
let count = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) console.log("INIT OK:", msg.result.serverInfo);
  if (msg.id === 2) console.log("TOOLS:", msg.result.tools.map((t) => t.name));
  if (msg.id === 3) {
    console.log("STATUS:", msg.result.content[0].text.slice(0, 300));
    p.kill();
    process.exit(0);
  }
  count++;
});
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "install-test", version: "1.0" } } }) + "\n");
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "computer_use_status", arguments: {} } }) + "\n");
setTimeout(() => { console.error("Self-test timed out"); p.kill(); process.exit(1); }, 15000);
' "$STATE_DIR/bridge.sh"

echo ""
echo "============================================================"
echo "Installation complete!"
echo "In Gemini for Mac -> More -> Customize -> Connectors -> Custom:"
echo "  Setup method : Local MCP"
echo "  Server Name  : cua-bridge"
echo "  Command      : $STATE_DIR/bridge.sh"
echo "  Sandbox      : Default (keeps ~/.local, ~/.nvm & outbound network)"
echo "============================================================"
