import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readJson, updateJson } from "../server/json-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("updateJson serializes concurrent local mutations without losing writes", async () => {
  const name = `json-store-concurrency-${process.pid}-${Date.now()}.json`;
  const target = path.join(root, "data", name);
  try {
    await Promise.all(Array.from({ length: 40 }, (_, index) => updateJson(name, (rows) => {
      rows.push(index);
    }, [])));
    const rows = await readJson(name);
    assert.equal(rows.length, 40);
    assert.deepEqual([...rows].sort((left, right) => left - right), Array.from({ length: 40 }, (_, index) => index));
  } finally {
    await unlink(target).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
});
