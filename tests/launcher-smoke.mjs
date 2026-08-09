import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const env = { ...process.env, PORT: "3094", API_PORT: "8894", AUTO_OPEN: "0", COZE_API_TOKEN: "", COZE_MOCK_MODE: "true" };
const server = spawn(process.execPath, ["scripts/portable.mjs"], { cwd: new URL("../", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { ready = (await fetch("http://127.0.0.1:3094")).ok; if (ready) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true);
  const output = [];
  const launcher = spawn(process.execPath, ["scripts/launcher.mjs"], { cwd: new URL("../", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
  launcher.stdout.on("data", (chunk) => output.push(chunk));
  const code = await new Promise((resolve) => launcher.on("exit", resolve));
  assert.equal(code, 0);
  assert.match(Buffer.concat(output).toString("utf8"), /already running/i);
  console.log("Idempotent launcher smoke test passed");
} finally { server.kill(); }
