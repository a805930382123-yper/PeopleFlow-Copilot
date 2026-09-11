import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import worker from "../dist/server/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(root, "dist", "client");
const port = Number(process.env.PORT || 3188);
const apiPort = Number(process.env.API_PORT || 8787);
const mime = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };

async function isPeopleFlowApiOnline() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: controller.signal });
    const result = await response.json();
    return response.ok && result?.ok === true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

if (!(await isPeopleFlowApiOnline())) {
  const bundledApi = path.join(root, "server", "server-runtime.mjs");
  await import(existsSync(bundledApi) ? pathToFileURL(bundledApi).href : "../server/local-server.mjs");
}

async function assetResponse(request) {
  const url = new URL(request.url);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const target = path.resolve(clientRoot, relative);
  if (!target.startsWith(clientRoot) || !relative) return new Response("Not found", { status: 404 });
  try { return new Response(await readFile(target), { headers: { "Content-Type": mime[path.extname(target).toLowerCase()] || "application/octet-stream" } }); }
  catch { return new Response("Not found", { status: 404 }); }
}

const server = http.createServer(async (req, res) => {
  try {
    // Keep local API storage rooted in the source/runtime server, not the UI bundle.
    if ((req.url || "").startsWith("/api/")) {
      const upstream = http.request({ hostname: "127.0.0.1", port: apiPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${apiPort}` } }, (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "业务服务暂时不可用，请重新启动后重试。" }));
      });
      req.pipe(upstream);
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://${req.headers.host || `localhost:${port}`}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : Buffer.concat(chunks) });
    const pathname = new URL(request.url).pathname;
    const response = pathname.startsWith("/assets/") || /\.(?:js|css|svg|png|jpg|ico|json)$/i.test(pathname)
      ? await assetResponse(request)
      : await worker.fetch(request, { ASSETS: { fetch: assetResponse } }, { waitUntil() {}, passThroughOnException() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); res.end(`PeopleFlow 启动失败：${error.message}`); }
});

server.listen(port, "127.0.0.1", () => {
  const localUrl = `http://127.0.0.1:${port}`;
  console.log(`PeopleFlow UI: ${localUrl}`);
  if (process.env.AUTO_OPEN === "1" && process.platform === "win32") {
    const opener = spawn("cmd.exe", ["/d", "/c", "start", "", localUrl], { detached: true, stdio: "ignore", windowsHide: true });
    opener.unref();
  }
});
