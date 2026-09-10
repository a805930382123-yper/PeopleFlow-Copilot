import { aggregateTokenUsage, normalizeTokenUsage } from "./token-usage.mjs";
import { getRuntimeEnv } from "./runtime-env.mjs";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_PATH = "/chat/completions";
const FIXTURE_PROVIDER = "classroom-fixture";
const LIVE_PROVIDER = "openai-compatible";

const numberFromEnv = (name, fallback, minimum = 0) => {
  const value = Number(getRuntimeEnv(name));
  return Number.isFinite(value) && value >= minimum ? value : fallback;
};

const normalizeBaseUrl = (value) => (value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");

export class LlmConfigurationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LlmConfigurationError";
    this.code = "LLM_NOT_CONFIGURED";
    this.status = 503;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function buildLlmEndpoint(baseUrl = getRuntimeEnv("LLM_BASE_URL"), apiPath = getRuntimeEnv("LLM_API_PATH")) {
  const base = normalizeBaseUrl(baseUrl);
  const path = (apiPath || DEFAULT_API_PATH).trim();
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}/${path.replace(/^\/+/, "")}`;
}

export function resolveThinkingMode(endpoint, model, configuredMode = getRuntimeEnv("LLM_THINKING_MODE") || "auto") {
  const mode = String(configuredMode || "auto").trim().toLowerCase();
  if (["enabled", "disabled"].includes(mode)) return mode;
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    if (hostname === "api.deepseek.com" && /^deepseek-v4-/i.test(String(model || ""))) return "disabled";
  } catch {}
  return null;
}

function safeEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "未配置有效地址";
  }
}

function selectedProvider() {
  const explicit = getRuntimeEnv("LLM_PROVIDER")?.trim().toLowerCase();
  if (explicit) return explicit;
  if (getRuntimeEnv("LLM_API_KEY")?.trim()) return LIVE_PROVIDER;
  if ((getRuntimeEnv("LLM_MOCK_MODE") || "").toLowerCase() === "true") return FIXTURE_PROVIDER;
  return "unconfigured";
}

export function getLlmRuntimeConfig(skill = {}) {
  const provider = selectedProvider();
  const endpoint = buildLlmEndpoint();
  const globalModel = getRuntimeEnv("LLM_MODEL")?.trim() || "";
  const fixture = provider === FIXTURE_PROVIDER;
  const live = provider === LIVE_PROVIDER;
  const useSkillModel = skill.model_strategy === "skill" && Boolean(skill.model?.trim());
  const selectedModel = useSkillModel ? skill.model.trim() : globalModel || skill.model || "";
  const missing = [];
  if (live && !getRuntimeEnv("LLM_API_KEY")?.trim()) missing.push("LLM_API_KEY");
  if (live && !selectedModel) missing.push("LLM_MODEL");
  if (![FIXTURE_PROVIDER, LIVE_PROVIDER].includes(provider)) missing.push("LLM_PROVIDER");
  const model = fixture ? "deterministic-onboarding-fixture" : selectedModel || "未配置";
  return {
    configured: (fixture || live) && missing.length === 0,
    provider,
    mode: fixture ? "fixture" : live ? "live" : "unconfigured",
    model,
    global_model: globalModel || null,
    model_source: fixture ? "fixture" : useSkillModel ? "skill" : globalModel ? "global" : "skill",
    endpoint: fixture ? "local://classroom-fixture" : safeEndpoint(endpoint),
    json_mode: (getRuntimeEnv("LLM_JSON_MODE") || "auto").toLowerCase(),
    thinking_mode: (getRuntimeEnv("LLM_THINKING_MODE") || "auto").toLowerCase(),
    timeout_ms: numberFromEnv("LLM_TIMEOUT_MS", 60000, 1000),
    max_retries: numberFromEnv("LLM_MAX_RETRIES", 1, 0),
    fallback_to_mock: false,
    missing,
  };
}

function configurationError(config) {
  return new LlmConfigurationError("大模型尚未完成配置。", {
    provider: config.provider,
    missing: config.missing,
    fixture_hint: "如需使用演示模式，请将 LLM_PROVIDER 设置为 classroom-fixture。",
  });
}

function extractMessageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part) => typeof part === "string" ? part : part?.text || part?.content || "").join("");
  return "";
}

export function parseJsonContent(content) {
  const text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!text) throw new Error("大模型返回内容为空");
  try { return JSON.parse(text); } catch {}
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  const objectCandidate = objectStart >= 0 && objectEnd > objectStart ? text.slice(objectStart, objectEnd + 1) : "";
  const arrayCandidate = arrayStart >= 0 && arrayEnd > arrayStart ? text.slice(arrayStart, arrayEnd + 1) : "";
  const candidate = objectCandidate || arrayCandidate;
  if (candidate) {
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error("大模型未返回有效 JSON");
}

function systemPrompt(skill) {
  const example = skill.output_example || { result: "根据输入生成的结构化结果" };
  return `${skill.prompt || "请处理用户输入。"}\n\n必须只输出一个有效 JSON 对象，不要使用 Markdown 代码块，不要输出解释文字。JSON 示例：${JSON.stringify(example)}`;
}

function isTransient(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function unsupportedJsonMode(status, detail) {
  return [400, 404, 415, 422].includes(status) && /response_format|json_object|json mode|unsupported|not support/i.test(detail);
}

async function requestCompletion(skill, payload, config) {
  const key = getRuntimeEnv("LLM_API_KEY").trim();
  const endpoint = buildLlmEndpoint();
  const jsonMode = ["auto", "on", "off"].includes(config.json_mode) ? config.json_mode : "auto";
  let useResponseFormat = jsonMode !== "off";
  let requestCount = 0;
  let retryCount = 0;
  const observedUsage = [];
  while (true) {
    requestCount += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
    try {
      const requestBody = {
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt(skill) },
          { role: "user", content: JSON.stringify(payload) },
        ],
      };
      if (Number.isFinite(skill.temperature)) requestBody.temperature = skill.temperature;
      if (Number.isFinite(skill.max_tokens)) requestBody.max_tokens = skill.max_tokens;
      if (useResponseFormat) requestBody.response_format = { type: "json_object" };
      const thinkingMode = resolveThinkingMode(endpoint, config.model, config.thinking_mode);
      if (thinkingMode) requestBody.thinking = { type: thinkingMode };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        try {
          const errorBody = JSON.parse(raw);
          const failedUsage = normalizeTokenUsage(errorBody?.usage, { source: "provider", billable: true });
          if (failedUsage.usage_source === "provider") observedUsage.push(failedUsage);
        } catch {}
        const detail = raw.slice(0, 500);
        if (jsonMode === "auto" && useResponseFormat && unsupportedJsonMode(response.status, detail)) { useResponseFormat = false; continue; }
        const error = new Error(`LLM API HTTP ${response.status}${detail ? `：${detail}` : ""}`);
        error.code = "LLM_REQUEST_FAILED";
        error.status = 502;
        error.retryable = isTransient(response.status);
        if (error.retryable && retryCount < config.max_retries) { retryCount += 1; continue; }
        throw error;
      }
      let body;
      try { body = JSON.parse(raw); } catch { throw new Error("LLM API 返回了非 JSON 响应"); }
      const text = extractMessageText(body?.choices?.[0]?.message);
      const currentUsage = normalizeTokenUsage(body?.usage, { source: "provider", billable: true });
      observedUsage.push(currentUsage);
      const tokenUsage = aggregateTokenUsage(observedUsage, { total_calls: requestCount });
      try {
        return { data: parseJsonContent(text), attempts: requestCount, response_format: useResponseFormat ? "json_object" : "prompt_only", request_id: body?.id || null, usage: body?.usage || null, token_usage: tokenUsage };
      } catch (error) {
        error.token_usage = tokenUsage;
        throw error;
      }
    } catch (error) {
      const normalized = error?.name === "AbortError" ? new Error(`LLM 请求超时（${config.timeout_ms}ms）`) : error;
      if (error?.name === "AbortError") { normalized.code = "LLM_TIMEOUT"; normalized.status = 504; }
      if (normalized.retryable === false || retryCount >= config.max_retries) {
        normalized.token_usage ||= aggregateTokenUsage(observedUsage, { total_calls: requestCount });
        throw normalized;
      }
      retryCount += 1;
    } finally { clearTimeout(timeout); }
  }
}

export async function callModel(skill, payload, fixtureFactory) {
  const config = getLlmRuntimeConfig(skill);
  if (!config.configured) throw configurationError(config);
  const startedAt = Date.now();
  if (config.provider === FIXTURE_PROVIDER) {
    return { data: await fixtureFactory(), mode: "fixture", provider: config.provider, model: config.model, duration_ms: Date.now() - startedAt, attempts: 1, token_usage: normalizeTokenUsage(null, { fixture: true, calls: 1 }) };
  }
  const result = await requestCompletion(skill, payload, config);
  return { ...result, mode: "live", provider: config.provider, model: config.model, duration_ms: Date.now() - startedAt };
}

export async function testLlmConnection() {
  const config = getLlmRuntimeConfig();
  if (!config.configured) return { ok: false, ...config, error: configurationError(config).toJSON() };
  if (config.provider === FIXTURE_PROVIDER) return { ok: true, ...config, output: { status: "ok", fixture: true }, duration_ms: 0 };
  const startedAt = Date.now();
  try {
    const result = await requestCompletion({ prompt: "你是连接测试助手。请确认服务可用。", temperature: 0, max_tokens: 80, output_example: { status: "ok" } }, { task: "connection_test" }, { ...config, max_retries: Math.min(config.max_retries, 1) });
    return { ok: true, ...config, duration_ms: Date.now() - startedAt, attempts: result.attempts, output: result.data };
  } catch (error) {
    return { ok: false, ...config, duration_ms: Date.now() - startedAt, error: { code: error.code || "LLM_CONNECTION_FAILED", message: error.message } };
  }
}
