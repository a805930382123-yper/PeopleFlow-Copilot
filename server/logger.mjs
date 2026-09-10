import { updateJson } from "./json-store.mjs";
import { sanitizeForStorage } from "./privacy.mjs";
export async function appendLog(entry) {
  const sanitized = sanitizeForStorage(entry);
  await updateJson("execution_logs.json", (logs) => [sanitized, ...logs].slice(0, 500), []);
  return sanitized;
}

export async function saveLog(entry) {
  const sanitized = sanitizeForStorage(entry);
  await updateJson("execution_logs.json", (logs) => {
    const index = logs.findIndex((item) => item.id === sanitized.id);
    if (index >= 0) logs[index] = sanitized;
    else logs.unshift(sanitized);
    return logs.slice(0, 500);
  }, []);
  return sanitized;
}
