import { readJson, writeJson } from "./json-store.mjs";
import { sanitizeForStorage } from "./privacy.mjs";
export async function appendLog(entry) {
  const logs = await readJson("execution_logs.json");
  const sanitized = sanitizeForStorage(entry);
  logs.unshift(sanitized);
  await writeJson("execution_logs.json", logs.slice(0, 500));
  return sanitized;
}

export async function saveLog(entry) {
  const logs = await readJson("execution_logs.json");
  const sanitized = sanitizeForStorage(entry);
  const index = logs.findIndex((item) => item.id === sanitized.id);
  if (index >= 0) logs[index] = sanitized;
  else logs.unshift(sanitized);
  await writeJson("execution_logs.json", logs.slice(0, 500));
  return sanitized;
}
