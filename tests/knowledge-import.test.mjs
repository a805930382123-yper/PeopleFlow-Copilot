import assert from "node:assert/strict";
import test from "node:test";
import { callTool } from "../server/tool-registry.mjs";

test("batch imported knowledge is searchable with traceable source ids", async () => {
  const cases = [
    ["\u6b63\u5e38\u4e0b\u73ed\u65f6\u95f4\u51e0\u70b9", "DOC-GCS-879E4075A22D"],
    ["\u5dee\u65c5\u4f4f\u5bbf\u8d39\u4e0a\u9650\u591a\u5c11", "DOC-GCS-D1DD2C8BDCB0"],
    ["\u5982\u4f55\u7533\u8bf7\u516c\u53f8\u7528\u7ae0", "DOC-GCS-8482858AE7AE"],
    ["\u8bf7\u5047\u600e\u4e48\u529e\u7406", "DOC-GCS-7270C9B3EFA4"],
  ];

  for (const [query, sourceId] of cases) {
    const result = await callTool("knowledge_lookup", { employee_id: "E001", query });
    assert.ok(
      result.knowledge_cards.some(
        (item) => item.source === "knowledge_documents.json" && item.source_id === sourceId,
      ),
      `expected ${sourceId} for ${query}`,
    );
  }
});
