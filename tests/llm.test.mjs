import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callModel, getLlmRuntimeConfig, parseJsonContent, resolveThinkingMode, testLlmConnection } from "../server/llm.mjs";

const envKeys = ["LLM_API_KEY", "LLM_PROVIDER", "LLM_BASE_URL", "LLM_API_PATH", "LLM_MODEL", "LLM_JSON_MODE", "LLM_THINKING_MODE", "LLM_TIMEOUT_MS", "LLM_MAX_RETRIES", "LLM_FALLBACK_TO_MOCK", "LLM_MOCK_MODE"];

test("DeepSeek V4 structured calls default to non-thinking mode", () => {
  assert.equal(resolveThinkingMode("https://api.deepseek.com/chat/completions", "deepseek-v4-pro", "auto"), "disabled");
  assert.equal(resolveThinkingMode("https://api.deepseek.com/chat/completions", "deepseek-v4-flash", "enabled"), "enabled");
  assert.equal(resolveThinkingMode("https://example.com/chat/completions", "custom-model", "auto"), null);
});

async function withMockServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}/v1`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function withEnv(values, run) {
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, values);
  try { await run(); }
  finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("解析纯 JSON、代码块 JSON 与夹带说明的 JSON", () => {
  assert.deepEqual(parseJsonContent('{"ok":true}'), { ok: true });
  assert.deepEqual(parseJsonContent('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(parseJsonContent('结果如下：{"ok":true}。'), { ok: true });
});

test("显式 Fixture 经过统一调用层并标记真实运行模式", async () => {
  await withEnv({ LLM_PROVIDER: "classroom-fixture" }, async () => {
    const result = await callModel({ model: "skill-model" }, {}, async () => ({ local: true }));
    assert.equal(result.mode, "fixture");
    assert.equal(result.provider, "classroom-fixture");
    assert.equal(result.model, "deterministic-onboarding-fixture");
    assert.deepEqual(result.data, { local: true });
  });
});

test("真实模式缺少配置时不会静默降级", async () => {
  await withEnv({ LLM_PROVIDER: "openai-compatible", LLM_MODEL: "deepseek-v4-pro" }, async () => {
    await assert.rejects(() => callModel({ model: "skill-model" }, {}, async () => ({ local: true })), (error) => error.code === "LLM_NOT_CONFIGURED");
  });
});

test("OpenAI-Compatible 请求使用全局模型、Bearer 鉴权与 JSON Mode", async () => {
  let captured;
  await withMockServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    captured = { url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(parts).toString()) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl-token-test", choices: [{ message: { content: '```json\n{"status":"ok"}\n```' } }], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100, prompt_tokens_details: { cached_tokens: 10 } } }));
  }, async (baseUrl) => withEnv({ LLM_API_KEY: "test-key", LLM_BASE_URL: baseUrl, LLM_MODEL: "global-model", LLM_JSON_MODE: "auto", LLM_MAX_RETRIES: "0", LLM_FALLBACK_TO_MOCK: "false" }, async () => {
    const result = await callModel({ model: "skill-model", prompt: "输出测试结果", temperature: 0, max_tokens: 100 }, { input: "hello" }, async () => ({}));
    assert.equal(result.mode, "live");
    assert.equal(result.model, "global-model");
    assert.deepEqual(result.data, { status: "ok" });
    assert.equal(result.request_id, "chatcmpl-token-test");
    assert.equal(result.token_usage.total_tokens, 100);
    assert.equal(result.token_usage.cached_tokens, 10);
    assert.equal(result.token_usage.usage_source, "provider");
  }));
  assert.equal(captured.url, "/v1/chat/completions");
  assert.equal(captured.auth, "Bearer test-key");
  assert.equal(captured.body.model, "global-model");
  assert.deepEqual(captured.body.response_format, { type: "json_object" });
  assert.match(captured.body.messages[0].content, /只输出一个有效 JSON/);
});

test("不支持 response_format 时自动改用提示词 JSON 约束", async () => {
  const bodies = [];
  await withMockServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const requestBody = JSON.parse(Buffer.concat(parts).toString()); bodies.push(requestBody);
    res.writeHead(bodies.length === 1 ? 400 : 200, { "Content-Type": "application/json" });
    res.end(bodies.length === 1 ? JSON.stringify({ error: { message: "response_format unsupported" } }) : JSON.stringify({ choices: [{ message: { content: '{"status":"ok"}' } }] }));
  }, async (baseUrl) => withEnv({ LLM_API_KEY: "test-key", LLM_BASE_URL: baseUrl, LLM_MODEL: "compatible-model", LLM_JSON_MODE: "auto", LLM_MAX_RETRIES: "0", LLM_FALLBACK_TO_MOCK: "false" }, async () => {
    const result = await callModel({ prompt: "测试" }, {}, async () => ({}));
    assert.equal(result.mode, "live");
    assert.equal(result.attempts, 2);
    assert.equal(result.response_format, "prompt_only");
  }));
  assert.ok(bodies[0].response_format);
  assert.equal(bodies[1].response_format, undefined);
});

test("连接测试不泄露 API Key，未配置时给出明确状态", async () => {
  await withEnv({ LLM_BASE_URL: "https://example.com/v1", LLM_MODEL: "demo-model" }, async () => {
    const result = await testLlmConnection();
    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
    assert.equal(result.model, "demo-model");
    assert.doesNotMatch(JSON.stringify(result), /API_KEY.*demo-model/);
    assert.equal("api_key" in getLlmRuntimeConfig(), false);
  });
});
