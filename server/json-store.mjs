import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeStorage } from "./runtime-storage.mjs";
import { seedFor } from "./seed-data.mjs";

const moduleUrl = import.meta.url;
const root = moduleUrl ? path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..") : process.cwd();
const dataDir = path.join(root, "data");

const localMutationQueues = new Map();
const cloudMutationQueues = new WeakMap();

async function readCloudJson(db, name) {
  const row = await db.prepare("SELECT value FROM json_documents WHERE name = ?").bind(name).first();
  if (row?.value != null) return JSON.parse(String(row.value));
  const seed = seedFor(name);
  if (seed === undefined) {
    const error = new Error(`Data file not found: ${name}`);
    error.code = "ENOENT";
    throw error;
  }
  await writeCloudJson(db, name, seed);
  return structuredClone(seed);
}

async function writeCloudJson(db, name, value) {
  await db.prepare(`INSERT INTO json_documents (name, value, updated_at, version)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, version = json_documents.version + 1`)
    .bind(name, JSON.stringify(value), new Date().toISOString())
    .run();
}

function mutationQueue(db) {
  if (!db) return localMutationQueues;
  if (!cloudMutationQueues.has(db)) cloudMutationQueues.set(db, new Map());
  return cloudMutationQueues.get(db);
}

async function serializeMutation(db, name, callback) {
  const queue = mutationQueue(db);
  const previous = queue.get(name) || Promise.resolve();
  const current = previous.catch(() => {}).then(callback);
  queue.set(name, current);
  try { return await current; }
  finally { if (queue.get(name) === current) queue.delete(name); }
}

function initialValue(name, fallback) {
  const seed = seedFor(name);
  if (seed !== undefined) return structuredClone(seed);
  if (fallback !== undefined) return structuredClone(fallback);
  const error = new Error(`Data file not found: ${name}`);
  error.code = "ENOENT";
  throw error;
}

async function applyUpdater(current, updater) {
  const draft = structuredClone(current);
  const result = await updater(draft);
  return result === undefined ? draft : result;
}

async function updateCloudJson(db, name, updater, fallback) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await db.prepare("SELECT value, version FROM json_documents WHERE name = ?").bind(name).first();
    const current = row?.value != null ? JSON.parse(String(row.value)) : initialValue(name, fallback);
    const next = await applyUpdater(current, updater);
    const updatedAt = new Date().toISOString();
    const result = row?.value != null
      ? await db.prepare("UPDATE json_documents SET value = ?, updated_at = ?, version = version + 1 WHERE name = ? AND version = ?")
        .bind(JSON.stringify(next), updatedAt, name, Number(row.version || 0)).run()
      : await db.prepare("INSERT INTO json_documents (name, value, updated_at, version) VALUES (?, ?, ?, 0) ON CONFLICT(name) DO NOTHING")
        .bind(name, JSON.stringify(next), updatedAt).run();
    const changes = result?.meta?.changes ?? result?.changes;
    if (changes === undefined || Number(changes) > 0) return next;
  }
  const error = new Error(`Concurrent update did not settle: ${name}`);
  error.code = "CONCURRENT_UPDATE_CONFLICT";
  error.status = 409;
  throw error;
}

export async function readJson(name) {
  const storage = getRuntimeStorage();
  if (storage?.db) return readCloudJson(storage.db, name);
  return JSON.parse(await readFile(path.join(dataDir, name), "utf8"));
}

export async function readJsonOr(name, fallback) {
  try { return await readJson(name); }
  catch (error) { if (error?.code === "ENOENT") return structuredClone(fallback); throw error; }
}

export async function writeJson(name, value) {
  const storage = getRuntimeStorage();
  if (storage?.db) return writeCloudJson(storage.db, name, value);
  await mkdir(dataDir, { recursive: true });
  const target = path.join(dataDir, name);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await import("node:fs/promises").then(({ rename }) => rename(temp, target));
}

export async function updateJson(name, updater, fallback) {
  if (typeof updater !== "function") throw new TypeError("updateJson updater must be a function");
  const storage = getRuntimeStorage();
  return serializeMutation(storage?.db, name, async () => {
    if (storage?.db) return updateCloudJson(storage.db, name, updater, fallback);
    let current;
    try { current = await readJson(name); }
    catch (error) { if (error?.code !== "ENOENT") throw error; current = initialValue(name, fallback); }
    const next = await applyUpdater(current, updater);
    await writeJson(name, next);
    return next;
  });
}

export async function updateRecord(file, id, patch) {
  let updated;
  await updateJson(file, (rows) => {
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw new Error(`未找到记录 ${id}`);
    updated = { ...rows[index], ...patch, id };
    rows[index] = updated;
  });
  return updated;
}
