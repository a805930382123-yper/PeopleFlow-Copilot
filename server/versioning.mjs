import { randomUUID } from "node:crypto";
import { readJsonOr, writeJson } from "./json-store.mjs";

export function nextPatchVersion(version = "1.0.0") {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return "1.0.1";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export async function snapshotVersion(file, entityId, content, changeNote = "保存前自动快照", source = "management") {
  const rows = await readJsonOr(file, []);
  const snapshot = {
    id: `VER-${randomUUID()}`,
    entity_id: entityId,
    version: content.version || "1.0.0",
    created_at: new Date().toISOString(),
    change_note: String(changeNote || "保存前自动快照").slice(0, 300),
    source,
    content: structuredClone(content),
  };
  rows.unshift(snapshot);
  await writeJson(file, rows.slice(0, 500));
  return snapshot;
}

export async function listVersions(file, entityId) {
  return (await readJsonOr(file, [])).filter((item) => item.entity_id === entityId);
}

export async function getVersion(file, entityId, versionId) {
  const version = (await listVersions(file, entityId)).find((item) => item.id === versionId || item.version === versionId);
  if (!version) {
    const error = new Error(`未找到版本：${versionId}`);
    error.code = "VERSION_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  return version;
}

export function textDiff(before = "", after = "") {
  const left = String(before).split("\n");
  const right = String(after).split("\n");
  const length = Math.max(left.length, right.length);
  const changes = [];
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) continue;
    if (left[index] !== undefined) changes.push({ type: "removed", line: index + 1, text: left[index] });
    if (right[index] !== undefined) changes.push({ type: "added", line: index + 1, text: right[index] });
  }
  return changes;
}
