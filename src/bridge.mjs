import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const HOME = os.homedir();
const STATE_DIR = process.env.CUA_BRIDGE_DIR || path.join(HOME, ".local", "share", "cua-http-mcp");
const PORT = Number(process.env.CUA_BRIDGE_PORT || 18765);
const URL = process.env.CUA_BRIDGE_URL || `http://127.0.0.1:${PORT}/mcp`;
const TOKEN = fs.readFileSync(path.join(STATE_DIR, "token"), "utf8").trim();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(msg),
    });

    if (res.status === 202) return;

    const text = await res.text();
    if (text.trim()) {
      process.stdout.write(text.trim() + "\n");
    }
  } catch (err) {
    if (msg.id !== undefined && msg.id !== null) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32603,
            message: `cua-http-mcp bridge error: ${err?.message || err}`,
          },
        }) + "\n"
      );
    }
  }
});
