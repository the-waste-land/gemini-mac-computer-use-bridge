import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

const HOST = "127.0.0.1";
const PORT = Number(process.env.CUA_BRIDGE_PORT || 18765);
const HOME = os.homedir();
const STATE_DIR = process.env.CUA_BRIDGE_DIR || path.join(HOME, ".local", "share", "cua-http-mcp");
const TOKEN_PATH = path.join(STATE_DIR, "token");
const NODE_BIN = process.env.CUA_NODE_BIN || process.execPath;

function resolveMcpScript() {
  if (process.env.CUA_MCP_SCRIPT && fs.existsSync(process.env.CUA_MCP_SCRIPT)) {
    return process.env.CUA_MCP_SCRIPT;
  }
  const candidates = [
    path.join(STATE_DIR, "runtime", "node_modules", "codex-computer-use-mcp", "dist", "mcp-server.js"),
    path.join(HOME, ".pi", "agent", "npm", "node_modules", "codex-computer-use-mcp", "dist", "mcp-server.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `codex-computer-use-mcp not found. Checked:\n${candidates.join("\n")}\nSet CUA_MCP_SCRIPT or run scripts/install.sh.`
  );
}

const TOKEN = fs.readFileSync(TOKEN_PATH, "utf8").trim();
const MCP_SCRIPT = resolveMcpScript();

let child = null;
let initialized = false;
let initResult = null;
const pending = new Map();
let nextInternalId = 1;

function spawnChild() {
  if (child && !child.killed) return;
  initialized = false;
  initResult = null;
  console.log(`[cua-http-mcp] spawning ${MCP_SCRIPT}`);
  child = spawn(NODE_BIN, [MCP_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME,
      PATH: `${path.dirname(NODE_BIN)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("[cua-http-mcp] non-json stdout:", line);
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, origId, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (origId !== undefined) msg.id = origId;
      resolve(msg);
    }
  });

  child.stderr.on("data", (d) => {
    process.stderr.write(`[mcp-stderr] ${d}`);
  });

  child.on("exit", (code, sig) => {
    console.error(`[cua-http-mcp] child exited code=${code} sig=${sig}`);
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server exited (code=${code}, sig=${sig})`));
    }
    pending.clear();
    child = null;
    initialized = false;
    initResult = null;
  });
}

function sendRpc(msg, timeoutMs = 180000) {
  spawnChild();

  // Notification (no id)
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === "notifications/initialized" && initialized) {
      return Promise.resolve(null);
    }
    child.stdin.write(JSON.stringify(msg) + "\n");
    return Promise.resolve(null);
  }

  // Cache initialize response so reconnecting clients can attach cleanly
  if (msg.method === "initialize" && initialized && initResult) {
    return Promise.resolve({ jsonrpc: "2.0", id: msg.id, result: initResult });
  }

  return new Promise((resolve, reject) => {
    const internalId = nextInternalId++;
    const origId = msg.id;
    const forwarded = { ...msg, id: internalId };
    const timer = setTimeout(() => {
      pending.delete(internalId);
      reject(new Error("MCP request timeout"));
    }, timeoutMs);

    pending.set(internalId, {
      origId,
      timer,
      resolve: (resp) => {
        if (msg.method === "initialize" && resp.result) {
          initialized = true;
          initResult = resp.result;
        }
        resolve(resp);
      },
      reject,
    });
    child.stdin.write(JSON.stringify(forwarded) + "\n");
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, childAlive: Boolean(child && !child.killed), initialized }));
    return;
  }

  if (req.url !== "/mcp" || req.method !== "POST") {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401);
    res.end("Unauthorized");
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end("Invalid JSON");
    return;
  }

  try {
    const resp = await sendRpc(msg);
    if (resp === null) {
      res.writeHead(202);
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
    }
  } catch (err) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32603, message: String(err?.message || err) },
      })
    );
  }
});

spawnChild();
server.listen(PORT, HOST, () => {
  console.log(`[cua-http-mcp] listening on http://${HOST}:${PORT}/mcp`);
});
