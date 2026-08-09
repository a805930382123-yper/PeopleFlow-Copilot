import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const smokeRoot = path.join(root, "release", ".release-smoke");
const archive = path.join(root, "release", "企业入职助手-最终版.zip");
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });
const unpack = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${smokeRoot}' -Force`], { encoding: "utf8" });
assert.equal(unpack.status, 0, unpack.stderr || unpack.stdout);
const release = path.join(smokeRoot, "企业入职助手-最终版");
const runtime = path.join(release, "runtime", "node.exe");
await access(runtime);
const batchCheck = spawnSync("cmd.exe", ["/d", "/c", path.join(release, "启动企业入职助手.bat")], { cwd: release, env: { ...process.env, PEOPLEFLOW_CHECK_ONLY: "1" }, encoding: "utf8" });
assert.equal(batchCheck.status, 0, batchCheck.stderr || batchCheck.stdout);
assert.match(batchCheck.stdout, /^v\d+/m);
const child = spawn(runtime, ["--env-file-if-exists=.env", "scripts/portable.mjs"], { cwd: release, env: { ...process.env, PORT: "3093", API_PORT: "8893", COZE_API_TOKEN: "", COZE_MOCK_MODE: "true" }, stdio: ["ignore", "pipe", "pipe"] });
try {
  let html = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { const response = await fetch("http://127.0.0.1:3093"); if (response.ok) { html = await response.text(); break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(html, /PeopleFlow/);
  const health = await fetch("http://127.0.0.1:8893/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, "1.6.0");
  const bootstrap = await (await fetch("http://127.0.0.1:8893/api/bootstrap")).json();
  assert.ok(bootstrap.knowledge_documents.length >= 6);
  assert.ok(bootstrap.knowledge_runtime.chunks > 0);
  assert.ok(Array.isArray(bootstrap.conversation_feedback));
  const pptx = new JSZip();
  pptx.file("ppt/slides/slide1.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>发行包解析测试</a:t><a:t>新员工应在上午九点前完成签到</a:t></p:sld>');
  const pptxBuffer = await pptx.generateAsync({ type: "nodebuffer" });
  const upload = await fetch("http://127.0.0.1:8893/api/knowledge-files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "发行包解析测试.pptx", size: pptxBuffer.length, base64: pptxBuffer.toString("base64") }) });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.equal(uploaded.document.status, "review");
  assert.equal(uploaded.document.source_type, "PPTX");
  assert.match(uploaded.document.content, /上午九点前完成签到/);
  await fetch(`http://127.0.0.1:8893/api/knowledge-documents/${uploaded.document.id}`, { method: "DELETE" });
  const demo = await fetch("http://127.0.0.1:3093/demo");
  assert.equal(demo.status, 200);
  assert.match(await demo.text(), /企业入职小助手/);
  console.log("Release package smoke test passed");
} finally {
  const exited = child.exitCode === null ? new Promise((resolve) => child.once("exit", resolve)) : Promise.resolve();
  child.kill();
  await exited;
  await rm(smokeRoot, { recursive: true, force: true });
}
