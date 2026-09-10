import { readJsonOr, updateJson, writeJson } from "./json-store.mjs";
import { getLlmRuntimeConfig, testLlmConnection } from "./llm.mjs";
import { getRuntimeEnv, hasExternalRuntimeEnv, setRuntimeConfig } from "./runtime-env.mjs";

const FILE = "llm_config.json";
export const PROVIDER_PROFILES = [
  { id: "openai", name: "OpenAI", provider: "openai-compatible", description: "OpenAI 官方 /v1/chat/completions 接口。", base_url: "https://api.openai.com/v1", api_path: "/chat/completions", models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"], requires_api_key: true },
  { id: "deepseek", name: "DeepSeek", provider: "openai-compatible", description: "DeepSeek OpenAI-Compatible 对话接口。", base_url: "https://api.deepseek.com", api_path: "/chat/completions", models: ["deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"], requires_api_key: true },
  { id: "custom", name: "自定义 OpenAI-Compatible", provider: "openai-compatible", description: "其他兼容 /chat/completions 的模型服务。", base_url: "", api_path: "/chat/completions", models: [], requires_api_key: true },
  { id: "classroom-fixture", name: "Classroom Fixture", provider: "classroom-fixture", description: "确定性演示稳定模式，仍经过完整 Agent 主链路。", base_url: "local://classroom-fixture", api_path: "", models: ["deterministic-onboarding-fixture"], requires_api_key: false },
];

function validateConfig(input) {
  const provider = String(input.provider || "").toLowerCase();
  if (!["openai-compatible", "classroom-fixture"].includes(provider)) throw Object.assign(new Error("Provider 只能是 openai-compatible 或 classroom-fixture"), { code: "INVALID_LLM_PROVIDER" });
  if (provider === "openai-compatible") {
    if (!String(input.base_url || "").match(/^https?:\/\//i)) throw Object.assign(new Error("Base URL 必须以 http:// 或 https:// 开头"), { code: "INVALID_LLM_BASE_URL" });
    const parsed = new URL(input.base_url);
    if (parsed.username || parsed.password || parsed.search) throw Object.assign(new Error("Base URL 不得包含凭据或查询参数"), { code: "UNSAFE_LLM_BASE_URL" });
    if (!String(input.model || "").trim()) throw Object.assign(new Error("真实 Provider 必须配置默认模型"), { code: "LLM_MODEL_REQUIRED" });
  }
  const timeout = Math.max(1000, Math.min(300000, Number(input.timeout_ms || 60000)));
  const retries = Math.max(0, Math.min(3, Number(input.max_retries || 1)));
  return {
    active: true,
    provider,
    profile_id: input.profile_id || (provider === "classroom-fixture" ? "classroom-fixture" : "custom"),
    model: provider === "classroom-fixture" ? "deterministic-onboarding-fixture" : String(input.model).trim(),
    base_url: provider === "classroom-fixture" ? "local://classroom-fixture" : String(input.base_url).replace(/\/+$/, ""),
    api_path: provider === "classroom-fixture" ? "" : String(input.api_path || "/chat/completions"),
    json_mode: ["auto", "on", "off"].includes(input.json_mode) ? input.json_mode : "auto",
    timeout_ms: timeout,
    max_retries: retries,
    updated_at: new Date().toISOString(),
  };
}

function applyConfig(config) {
  if (!config?.active) return;
  setRuntimeConfig({
    LLM_PROVIDER: config.provider,
    LLM_MODEL: config.model,
    LLM_BASE_URL: config.base_url,
    LLM_API_PATH: config.api_path,
    LLM_JSON_MODE: config.json_mode,
    LLM_TIMEOUT_MS: config.timeout_ms,
    LLM_MAX_RETRIES: config.max_retries,
  });
}

export async function initializeLlmConfig() {
  const saved = await readJsonOr(FILE, { active: false });
  if (!hasExternalRuntimeEnv("LLM_PROVIDER")) applyConfig(saved);
  return saved;
}

export async function getLlmConfig() {
  const saved = await readJsonOr(FILE, { active: false });
  const runtime = getLlmRuntimeConfig();
  const profileId = saved.active ? saved.profile_id : runtime.provider === "classroom-fixture" ? "classroom-fixture" : runtime.endpoint?.includes("deepseek") ? "deepseek" : runtime.endpoint?.includes("openai.com") ? "openai" : "custom";
  return {
    ...runtime,
    profile_id: profileId,
    provider_description: PROVIDER_PROFILES.find((item) => item.id === profileId)?.description || "OpenAI-Compatible 模型服务。",
    base_url: saved.active ? saved.base_url : getRuntimeEnv("LLM_BASE_URL") || "",
    api_path: saved.active ? saved.api_path : getRuntimeEnv("LLM_API_PATH") || "/chat/completions",
    api_key: { configured: Boolean(getRuntimeEnv("LLM_API_KEY")?.trim()), env_var: "LLM_API_KEY" },
    profiles: PROVIDER_PROFILES,
    saved: Boolean(saved.active),
    last_test: saved.last_test || null,
  };
}

export async function updateLlmConfig(input) {
  const config = validateConfig(input);
  await writeJson(FILE, config);
  applyConfig(config);
  return getLlmConfig();
}

export async function switchLlmProvider(input) {
  const profile = PROVIDER_PROFILES.find((item) => item.id === input.profile_id);
  if (!profile) throw Object.assign(new Error(`Provider Profile 不存在：${input.profile_id}`), { code: "LLM_PROFILE_NOT_FOUND", status: 404 });
  const current = await getLlmConfig();
  return updateLlmConfig({
    provider: profile.provider,
    profile_id: profile.id,
    model: input.model || profile.models[0] || current.model,
    base_url: input.base_url || profile.base_url || current.base_url,
    api_path: input.api_path ?? profile.api_path,
    json_mode: input.json_mode || current.json_mode,
    timeout_ms: input.timeout_ms || current.timeout_ms,
    max_retries: input.max_retries ?? current.max_retries,
  });
}

export async function testManagedLlmConnection() {
  const result = await testLlmConnection();
  const tested = { ...result, tested_at: new Date().toISOString() };
  await updateJson(FILE, (saved) => ({ ...saved, last_test: { ok: tested.ok, provider: tested.provider, model: tested.model, duration_ms: tested.duration_ms || 0, tested_at: tested.tested_at, error: tested.error || null } }), { active: false });
  return tested;
}
