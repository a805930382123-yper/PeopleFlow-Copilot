import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

export async function readJson(name) {
  return JSON.parse(await readFile(path.join(dataDir, name), "utf8"));
}

export async function readJsonOr(name, fallback) {
  try { return await readJson(name); }
  catch (error) { if (error?.code === "ENOENT") return structuredClone(fallback); throw error; }
}

export async function writeJson(name, value) {
  await mkdir(dataDir, { recursive: true });
  const target = path.join(dataDir, name);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await import("node:fs/promises").then(({ rename }) => rename(temp, target));
}

export async function updateRecord(file, id, patch) {
  const rows = await readJson(file);
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) throw new Error(`未找到记录 ${id}`);
  rows[index] = { ...rows[index], ...patch, id };
  await writeJson(file, rows);
  return rows[index];
}
