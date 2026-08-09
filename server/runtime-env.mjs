import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const PROJECT_ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
const RELOADABLE_SECRETS = ["LLM_API_KEY", "COZE_API_TOKEN", "EMBEDDING_API_KEY"];

export function reloadRuntimeSecrets() {
  const parsed = parseEnv(readFileSync(PROJECT_ENV_FILE, "utf8"));
  const configured = {};

  for (const name of RELOADABLE_SECRETS) {
    if (Object.prototype.hasOwnProperty.call(parsed, name)) {
      const value = String(parsed[name] || "").trim();
      if (value) process.env[name] = value;
      else delete process.env[name];
    }
    configured[name] = Boolean(process.env[name]?.trim());
  }

  return { reloaded: true, configured };
}
