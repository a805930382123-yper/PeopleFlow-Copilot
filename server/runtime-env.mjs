import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { getRuntimeStorage } from "./runtime-storage.mjs";

const moduleUrl = import.meta.url;
const PROJECT_ENV_FILE = moduleUrl ? path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", ".env") : path.resolve(process.cwd(), ".env");
const RELOADABLE_SECRETS = ["LLM_API_KEY", "COZE_API_TOKEN", "EMBEDDING_API_KEY"];
const CONFIGURABLE_VALUES = ["LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_API_PATH", "LLM_JSON_MODE", "LLM_TIMEOUT_MS", "LLM_MAX_RETRIES"];
const localOverrides = new Map();
const runtimeConfig = new Map();

export function getRuntimeEnv(name) {
  const hostedValue = getRuntimeStorage()?.env?.[name];
  if (typeof hostedValue === "string") return hostedValue;
  if (runtimeConfig.has(name)) return runtimeConfig.get(name);
  if (localOverrides.has(name)) return localOverrides.get(name);
  return process.env[name];
}

export function hasExternalRuntimeEnv(name) {
  const hostedEnv = getRuntimeStorage()?.env;
  return Boolean(hostedEnv && Object.prototype.hasOwnProperty.call(hostedEnv, name))
    || Object.prototype.hasOwnProperty.call(process.env, name);
}

export function setRuntimeConfig(values = {}) {
  for (const name of CONFIGURABLE_VALUES) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
    const value = values[name];
    if (value === null || value === undefined || value === "") runtimeConfig.delete(name);
    else runtimeConfig.set(name, String(value));
  }
}

export function reloadRuntimeSecrets() {
  if (getRuntimeStorage()) {
    return {
      reloaded: false,
      source: "hosted_environment",
      configured: Object.fromEntries(RELOADABLE_SECRETS.map((name) => [name, Boolean(getRuntimeEnv(name)?.trim())])),
    };
  }
  const parsed = parseEnv(readFileSync(PROJECT_ENV_FILE, "utf8"));
  const configured = {};

  for (const name of RELOADABLE_SECRETS) {
    if (Object.prototype.hasOwnProperty.call(parsed, name)) {
      const value = String(parsed[name] || "").trim();
      if (value) localOverrides.set(name, value);
      else localOverrides.delete(name);
    }
    configured[name] = Boolean(getRuntimeEnv(name)?.trim());
  }

  return { reloaded: true, configured };
}
