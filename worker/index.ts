/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleNodeApiRequest } from "../server/index.mjs";
import { withRuntimeStorage } from "../server/runtime-storage.mjs";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  FILES?: R2Bucket;
  SITE_MODE?: string;
  PRIVATE_ACCESS_PASSWORD?: string;
  PRIVATE_SESSION_SECRET?: string;
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_API_PATH?: string;
  LLM_MODEL?: string;
  LLM_JSON_MODE?: string;
  LLM_THINKING_MODE?: string;
  LLM_TIMEOUT_MS?: string;
  LLM_MAX_RETRIES?: string;
  COZE_API_TOKEN?: string;
  COZE_API_BASE_URL?: string;
  COZE_WORKFLOW_ID?: string;
  EMBEDDING_PROVIDER?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_MODEL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

const RUNTIME_ENV_KEYS = [
  "LLM_PROVIDER", "LLM_API_KEY", "LLM_BASE_URL", "LLM_API_PATH", "LLM_MODEL",
  "LLM_JSON_MODE", "LLM_THINKING_MODE", "LLM_TIMEOUT_MS", "LLM_MAX_RETRIES",
  "COZE_API_TOKEN", "COZE_API_BASE_URL", "COZE_WORKFLOW_ID",
  "EMBEDDING_PROVIDER", "EMBEDDING_API_KEY", "EMBEDDING_BASE_URL", "EMBEDDING_MODEL",
] as const;
const SESSION_COOKIE = "peopleflow_private_session";

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signSession(payload: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${base64Url(signature)}`;
}

async function validSession(request: Request, env: Env) {
  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  if (!env.PRIVATE_SESSION_SECRET) return false;
  const cookie = request.headers.get("cookie") || "";
  const token = cookie.split(/;\s*/).find((item) => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return false;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return false;
  const payload = token.slice(0, separator);
  const expected = await signSession(payload, env.PRIVATE_SESSION_SECRET);
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < token.length; index += 1) mismatch |= token.charCodeAt(index) ^ expected.charCodeAt(index);
  if (mismatch !== 0) return false;
  const expiresAt = Number(payload.split(":")[1] || 0);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function loginPage(message = "") {
  const notice = message ? `<p class="error">${message}</p>` : "";
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>企业入职小助手 · 私有访问</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f2e9;color:#17352b;font-family:system-ui,"Microsoft YaHei",sans-serif}.card{width:min(420px,calc(100vw - 40px));background:#fff;border:1px solid #dfe7df;border-radius:24px;padding:34px;box-shadow:0 24px 60px #355b4920}h1{font-size:25px;margin:0 0 8px}p{color:#64756c;line-height:1.65}.error{color:#b42318;background:#fff1f0;border-radius:10px;padding:10px 12px}label{display:block;font-weight:700;margin:24px 0 8px}input{box-sizing:border-box;width:100%;height:48px;border:1px solid #cbd8d0;border-radius:12px;padding:0 14px;font-size:16px}button{width:100%;height:48px;margin-top:16px;border:0;border-radius:12px;background:#397a59;color:#fff;font-size:16px;font-weight:700;cursor:pointer}.hint{font-size:13px}</style></head><body><main class="card"><h1>企业入职小助手</h1><p>私有全功能管理平台</p>${notice}<form method="post" action="/api/auth/login"><label for="password">访问口令</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">进入管理平台</button></form><p class="hint">此站点同时受私有访问策略与服务端会话保护。</p></main></body></html>`, { status: message ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function handleLogin(request: Request, env: Env) {
  if (!env.PRIVATE_ACCESS_PASSWORD || !env.PRIVATE_SESSION_SECRET) return new Response("Private access is not configured", { status: 503 });
  const form = await request.formData();
  const submitted = String(form.get("password") || "");
  const expected = env.PRIVATE_ACCESS_PASSWORD;
  let mismatch = submitted.length ^ expected.length;
  for (let index = 0; index < Math.max(submitted.length, expected.length); index += 1) mismatch |= (submitted.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  if (mismatch !== 0) return loginPage("访问口令不正确，请重新输入。");
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  const token = await signSession(`v1:${expiresAt}`, env.PRIVATE_SESSION_SECRET);
  return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`, "Cache-Control": "no-store" } });
}

async function runApiRequest(request: Request, env: Env): Promise<Response> {
  const requestBytes = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
  const headers = Object.fromEntries(request.headers.entries());
  const url = new URL(request.url);
  const nodeRequest = { method: request.method, url: `${url.pathname}${url.search}`, headers, async *[Symbol.asyncIterator]() { if (requestBytes.length) yield requestBytes; } };
  let status = 200;
  let responseHeaders = new Headers();
  const chunks: Array<string | Uint8Array> = [];
  const nodeResponse = {
    writeHead(nextStatus: number, nextHeaders: Record<string, string> = {}) { status = nextStatus; responseHeaders = new Headers(nextHeaders); return this; },
    write(chunk: string | Uint8Array) { chunks.push(chunk); return true; },
    end(chunk?: string | Uint8Array) { if (chunk != null) chunks.push(chunk); },
  };
  const runtimeEnv = Object.fromEntries(RUNTIME_ENV_KEYS.map((key) => [key, env[key]]).filter(([, value]) => typeof value === "string"));
  await withRuntimeStorage({ db: env.DB, files: env.FILES, env: runtimeEnv }, () => handleNodeApiRequest(nodeRequest, nodeResponse));
  return new Response(chunks.length ? chunks : null, { status, headers: responseHeaders });
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const privateFull = env.SITE_MODE === "private-full";
    const localRequest = url.hostname === "localhost" || url.hostname === "127.0.0.1";

    if (privateFull && request.method === "POST" && url.pathname === "/api/auth/login") return handleLogin(request, env);
    if (privateFull && !(await validSession(request, env))) return loginPage();

    if (request.method === "GET" && url.pathname === "/" && !privateFull && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      return Response.redirect(new URL("/demo", request.url), 302);
    }

    if (url.pathname.startsWith("/api/")) {
      if (!privateFull && !localRequest) return Response.json({ error: "Not found" }, { status: 404 });
      return runApiRequest(request, env);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (privateFull) {
      const headers = new Headers(request.headers);
      headers.set("x-peopleflow-mode", "private-full");
      request = new Request(request, { headers });
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
