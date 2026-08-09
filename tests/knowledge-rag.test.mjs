import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { parseKnowledgeFile } from "../server/knowledge-parser.mjs";
import { cosineSimilarity, localEmbedding } from "../server/embedding.mjs";
import { chunkDocument } from "../server/knowledge-rag.mjs";

test("Markdown is split into traceable sections", async () => {
  const parsed = await parseKnowledgeFile({ filename: "考勤制度.md", buffer: Buffer.from("# 考勤制度\n\n## 工作时间\n上午九点上班，下午六点下班。\n\n## 请假\n请提前申请。") });
  assert.equal(parsed.source_type, "Markdown");
  assert.equal(parsed.segments.some((item) => item.title === "工作时间" && item.content.includes("六点下班")), true);
});

test("PPTX parser keeps slide numbers", async () => {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>新员工报到流程</a:t><a:t>第一天到 HR 前台签到</a:t></p:sld>');
  zip.file("ppt/slides/slide2.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>工作时间</a:t><a:t>下午六点下班</a:t></p:sld>');
  const parsed = await parseKnowledgeFile({ filename: "制度.pptx", buffer: await zip.generateAsync({ type: "nodebuffer" }) });
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[1].slide, 2);
  assert.match(parsed.segments[1].content, /六点下班/);
});

test("document chunking preserves page and source metadata", () => {
  const chunks = chunkDocument({ id: "DOC-T", name: "员工手册", category: "制度", version: "1.0", source_file: "员工手册.pdf", content: "工作时间说明", segments: [{ title: "工作时间", content: "下午六点下班。".repeat(120), page: 8, slide: null }] });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((item) => item.page === 8 && item.source_file === "员工手册.pdf"), true);
});

test("local vectors are deterministic and comparable", () => {
  const left = localEmbedding("公司的正常下班时间是几点");
  const same = localEmbedding("公司的正常下班时间是几点");
  const other = localEmbedding("入职需要携带身份证和学历证明");
  assert.equal(left.length, 192);
  assert.ok(cosineSimilarity(left, same) > cosineSimilarity(left, other));
});
