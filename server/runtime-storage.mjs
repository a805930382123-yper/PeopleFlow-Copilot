import { AsyncLocalStorage } from "node:async_hooks";

const runtimeStorage = new AsyncLocalStorage();

export function withRuntimeStorage(bindings, callback) {
  return runtimeStorage.run(bindings || {}, callback);
}

export function getRuntimeStorage() {
  return runtimeStorage.getStore() || null;
}

export async function putRuntimeFile(key, value, metadata = {}) {
  const storage = getRuntimeStorage();
  if (!storage?.files) return null;
  await storage.files.put(key, value, {
    httpMetadata: metadata.contentType ? { contentType: metadata.contentType } : undefined,
    customMetadata: metadata.customMetadata || undefined,
  });
  return `r2://${key}`;
}

export async function deleteRuntimeFile(pointer) {
  const storage = getRuntimeStorage();
  if (!storage?.files || !String(pointer || "").startsWith("r2://")) return false;
  await storage.files.delete(String(pointer).slice(5));
  return true;
}
