import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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
let initPromise = null;
const pending = new Map();
let nextInternalId = 1;

// Active Streamable HTTP sessions: sessionId -> { createdAt, sseClients: Set<res> }
const sessions = new Map();
const deletedSessions = new Set();
const allSseClients = new Set();

function broadcastNotification(msg) {
  const payload = `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const res of allSseClients) {
    if (!res.writableEnded) {
      try {
        res.write(payload);
      } catch {
        allSseClients.delete(res);
      }
    }
  }
}

function spawnChild() {
  if (child && !child.killed) return;
  initialized = false;
  initResult = null;
  initPromise = null;
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
      return;
    }
    // Forward server-initiated notifications to active SSE listeners
    if (msg.id === undefined && msg.method) {
      broadcastNotification(msg);
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
    initPromise = null;
  });
}

function sendRawRpc(msg, timeoutMs = 180000) {
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
      resolve,
      reject,
    });
    child.stdin.write(JSON.stringify(forwarded) + "\n");
  });
}

async function sendRpc(msg, timeoutMs = 180000) {
  spawnChild();

  // Notification (no id)
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === "notifications/initialized" && initialized) {
      return null;
    }
    child.stdin.write(JSON.stringify(msg) + "\n");
    return null;
  }

  // Deduplicate and cache initialize so reconnecting clients can attach cleanly
  if (msg.method === "initialize") {
    if (initialized && initResult) {
      return { jsonrpc: "2.0", id: msg.id, result: initResult };
    }
    if (!initPromise) {
      initPromise = sendRawRpc(msg, timeoutMs)
        .then((resp) => {
          if (resp.result) {
            initialized = true;
            initResult = resp.result;
          }
          return resp;
        })
        .finally(() => {
          initPromise = null;
        });
    }
    const resp = await initPromise;
    return { ...resp, id: msg.id };
  }

  return sendRawRpc(msg, timeoutMs);
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function isAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${TOKEN}`;
}

function handleGetMcp(req, res) {
  const accept = (req.headers["accept"] || "").toLowerCase();
  if (accept && !accept.includes("text/event-stream") && !accept.includes("*/*")) {
    res.writeHead(406, { "Content-Type": "text/plain" });
    res.end("Not Acceptable: text/event-stream required");
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && deletedSessions.has(sessionId)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Session not found");
    return;
  }

  const headers = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { createdAt: Date.now(), sseClients: new Set() });
    }
    sessions.get(sessionId).sseClients.add(res);
  }

  res.writeHead(200, headers);
  res.write(": connected\n\n");
  allSseClients.add(res);

  const keepalive = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepalive);
      return;
    }
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(keepalive);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepalive);
    allSseClients.delete(res);
    if (sessionId && sessions.has(sessionId)) {
      sessions.get(sessionId).sseClients.delete(res);
    }
  });
}

function handleDeleteMcp(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId) {
    const sess = sessions.get(sessionId);
    if (sess) {
      for (const clientRes of sess.sseClients) {
        allSseClients.delete(clientRes);
        if (!clientRes.writableEnded) clientRes.end();
      }
      sessions.delete(sessionId);
    }
    deletedSessions.add(sessionId);
    if (deletedSessions.size > 200) {
      const first = deletedSessions.values().next().value;
      deletedSessions.delete(first);
    }
  }
  res.writeHead(204);
  res.end();
}

async function handlePostMcp(req, res) {
  const incomingSessionId = req.headers["mcp-session-id"];
  if (incomingSessionId && deletedSessions.has(incomingSessionId)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Session not found" },
      })
    );
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON" },
      })
    );
    return;
  }

  const isBatch = Array.isArray(parsed);
  const messages = isBatch ? parsed : [parsed];
  const hasInitialize = messages.some((m) => m && m.method === "initialize");

  let sessionId = incomingSessionId;
  if (hasInitialize) {
    sessionId = crypto.randomUUID();
    sessions.set(sessionId, { createdAt: Date.now(), sseClients: new Set() });
  } else if (sessionId && !sessions.has(sessionId)) {
    sessions.set(sessionId, { createdAt: Date.now(), sseClients: new Set() });
  }

  const responses = [];
  for (const msg of messages) {
    try {
      const resp = await sendRpc(msg);
      if (resp !== null) {
        responses.push(resp);
      }
    } catch (err) {
      if (msg && msg.id !== undefined && msg.id !== null) {
        responses.push({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: String(err?.message || err) },
        });
      }
    }
  }

  const headers = { "Cache-Control": "no-cache" };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  if (responses.length === 0) {
    res.writeHead(202, headers);
    res.end();
    return;
  }

  const accept = (req.headers["accept"] || "").toLowerCase();
  const wantsOnlySse = accept.includes("text/event-stream") && !accept.includes("application/json");

  if (wantsOnlySse) {
    headers["Content-Type"] = "text/event-stream; charset=utf-8";
    res.writeHead(200, headers);
    for (const r of responses) {
      res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
    }
    res.end();
    return;
  }

  headers["Content-Type"] = "application/json";
  res.writeHead(200, headers);
  res.end(JSON.stringify(isBatch ? responses : responses[0]));
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        transport: "streamable-http",
        childAlive: Boolean(child && !child.killed),
        initialized,
        activeSessions: sessions.size,
        activeSseStreams: allSseClients.size,
      })
    );
    return;
  }

  if (pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("Unauthorized");
    return;
  }

  if (req.method === "POST") {
    await handlePostMcp(req, res);
    return;
  }
  if (req.method === "GET") {
    handleGetMcp(req, res);
    return;
  }
  if (req.method === "DELETE") {
    handleDeleteMcp(req, res);
    return;
  }

  res.writeHead(405, { Allow: "GET, POST, DELETE, OPTIONS" });
  res.end("Method Not Allowed");
});

function shutdown(sig) {
  console.log(`[cua-http-mcp] shutting down (${sig})...`);
  for (const res of allSseClients) {
    if (!res.writableEnded) res.end();
  }
  allSseClients.clear();
  server.close(() => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

spawnChild();
server.listen(PORT, HOST, () => {
  console.log(`[cua-http-mcp] listening on http://${HOST}:${PORT}/mcp (Streamable HTTP)`);
});
