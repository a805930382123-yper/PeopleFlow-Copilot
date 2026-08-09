import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["scripts/portable.mjs"], { cwd: new URL("../", import.meta.url), env: { ...process.env, PORT: "3091", API_PORT: "8891", COZE_API_TOKEN: "", COZE_MOCK_MODE: "true" }, stdio: ["ignore", "pipe", "pipe"] });
try {
  let html = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch("http://127.0.0.1:3091"); if (response.ok) { html = await response.text(); break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(html, /PeopleFlow/);
  const asset = html.match(/(?:src|href)="([^"]+\.js(?:\?[^\"]*)?)"/)?.[1];
  assert.ok(asset);
  assert.equal((await fetch(new URL(asset, "http://127.0.0.1:3091"))).status, 200);
  assert.equal((await fetch("http://127.0.0.1:8891/api/health")).status, 200);
  console.log("Portable package smoke test passed");
} finally { child.kill(); }
