#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Error: codex-computer-use-mcp only supports macOS." >&2
  exit 1
fi

MCP_CONFIG="${ANTIGRAVITY_MCP_CONFIG:-$HOME/.gemini/config/mcp_config.json}"
STATE_DIR="${CUA_BRIDGE_DIR:-$HOME/.local/share/cua-http-mcp}"

if [ "${1:-}" = "--uninstall" ]; then
  if [ ! -f "$MCP_CONFIG" ]; then
    echo "Nothing to uninstall: $MCP_CONFIG does not exist."
    exit 0
  fi
  NODE_BIN="${CUA_NODE_BIN:-$(command -v node || true)}"
  if [ -z "$NODE_BIN" ]; then
    echo "Error: node not found in PATH." >&2
    exit 1
  fi
  cp "$MCP_CONFIG" "${MCP_CONFIG}.bak.$(date +%Y%m%d-%H%M%S)"
  "$NODE_BIN" -e '
const fs = require("node:fs");
const p = process.argv[1];
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
if (cfg.mcpServers && cfg.mcpServers["computer-use"]) {
  delete cfg.mcpServers["computer-use"];
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  console.log("Removed computer-use from", p);
} else {
  console.log("computer-use entry not found in", p);
}
' "$MCP_CONFIG"
  echo "Done. Restart Antigravity CLI for the change to take effect."
  exit 0
fi

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

# Reuse existing codex-computer-use-mcp or install into $STATE_DIR/runtime
MCP_SCRIPT="${CUA_MCP_SCRIPT:-}"
if [ -z "$MCP_SCRIPT" ]; then
  for candidate in \
    "$STATE_DIR/runtime/node_modules/codex-computer-use-mcp/dist/mcp-server.js" \
    "$HOME/.pi/agent/npm/node_modules/codex-computer-use-mcp/dist/mcp-server.js"; do
    if [ -f "$candidate" ]; then
      MCP_SCRIPT="$candidate"
      echo "==> Reusing existing codex-computer-use-mcp at $MCP_SCRIPT"
      break
    fi
  done
fi

if [ -z "$MCP_SCRIPT" ]; then
  echo "==> Installing codex-computer-use-mcp into $STATE_DIR/runtime ..."
  mkdir -p "$STATE_DIR/runtime"
  npm --prefix "$STATE_DIR/runtime" install --no-audit --no-fund codex-computer-use-mcp
  MCP_SCRIPT="$STATE_DIR/runtime/node_modules/codex-computer-use-mcp/dist/mcp-server.js"
fi

echo "==> Verifying codex-computer-use-mcp runtime..."
"$NODE_BIN" "$MCP_SCRIPT" --status || true

echo "==> Updating $MCP_CONFIG ..."
mkdir -p "$(dirname "$MCP_CONFIG")"
if [ -f "$MCP_CONFIG" ]; then
  cp "$MCP_CONFIG" "${MCP_CONFIG}.bak.$(date +%Y%m%d-%H%M%S)"
fi

"$NODE_BIN" -e '
const fs = require("node:fs");
const [cfgPath, nodeBin, mcpScript] = process.argv.slice(1);
let cfg = {};
if (fs.existsSync(cfgPath)) {
  const raw = fs.readFileSync(cfgPath, "utf8").trim();
  if (raw) cfg = JSON.parse(raw);
}
if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") {
  cfg.mcpServers = {};
}
cfg.mcpServers["computer-use"] = {
  command: nodeBin,
  args: [mcpScript],
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
console.log("Configured computer-use in", cfgPath);
' "$MCP_CONFIG" "$NODE_BIN" "$MCP_SCRIPT"

echo "==> Running end-to-end stdio MCP self-test..."
"$NODE_BIN" -e '
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const p = spawn(process.argv[1], [process.argv[2]], { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: p.stdout });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) console.log("INIT OK:", msg.result.serverInfo);
  if (msg.id === 2) console.log("TOOLS:", msg.result.tools.map((t) => t.name));
  if (msg.id === 3) {
    console.log("STATUS:", msg.result.content[0].text.slice(0, 300));
    p.kill();
    process.exit(0);
  }
});
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agy-install-test", version: "1.0" } } }) + "\n");
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "computer_use_status", arguments: {} } }) + "\n");
setTimeout(() => { console.error("Self-test timed out"); p.kill(); process.exit(1); }, 15000);
' "$NODE_BIN" "$MCP_SCRIPT"

echo ""
echo "============================================================"
echo "Antigravity CLI setup complete!"
echo "Open a new Antigravity CLI session to use computer-use tools"
echo "(js, js_reset, computer_use_status)."
echo "To remove later: bash scripts/install-antigravity.sh --uninstall"
echo "============================================================"
