import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the employee workspace with three product entry points", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /PeopleFlow/);
  assert.match(html, /员工端/);
  assert.match(html, /企业管理端/);
  assert.match(html, /高级配置/);
  assert.match(html, /问问助手/);
  assert.match(html, /我的待办/);
  assert.match(html, /处理进度/);
  assert.match(html, /发送问题/);
  assert.doesNotMatch(html, /EXECUTION TRACE/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
});

test("server-renders the employee-facing onboarding chat demo", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("demo-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/demo", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /企业入职小助手/);
  assert.match(html, /常见问题/);
  assert.match(html, /需要准备什么入职材料/);
  assert.match(html, /输入你的入职问题/);
  assert.doesNotMatch(html, /思考过程|EXECUTION TRACE/);
});

test("legacy management routes return users to the unified platform", async () => {
  for (const pathname of ["/skills", "/tools", "/planner", "/models"]) {
    const response = await render(pathname);
    assert.equal(response.status, 200, pathname);
    const html = await response.text();
    assert.match(html, /正在返回 PeopleFlow 统一管理平台/, pathname);
  }
});

test("includes requested configurable capabilities without embedding secrets", async () => {
  const [page, layout, toolRegistry, coze, llm] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/tool-registry.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/coze-workflow.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/llm.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /Plan \+ Skill \+ Tool/);
  assert.match(page, /Plan 可视化编排/);
  assert.match(page, /新增 Tool/);
  assert.match(page, /config\/export/);
  assert.match(page, /coze-sessions/);
  assert.match(page, /统一 LLM Provider/);
  assert.match(page, /classroom-fixture/);
  assert.match(page, /当前生效模型/);
  assert.match(page, /全局生效/);
  assert.match(page, /最新版 6 个入职 Skill/);
  assert.match(page, /\/llm\/test/);
  assert.match(page, /bad_case_evaluation_cases/);
  assert.match(page, /EvaluationCenter/);
  const evaluationCenter = await readFile(new URL("../app/EvaluationCenter.tsx", import.meta.url), "utf8");
  assert.match(evaluationCenter, /核心评测集/);
  assert.match(evaluationCenter, /用户输入 \/ 评分规则/);
  assert.match(evaluationCenter, /Bad Case/);
  assert.match(evaluationCenter, /快速运行 8 条/);
  assert.match(evaluationCenter, /沉淀为 Bad Case/);
  assert.match(evaluationCenter, /PASS.*FAIL.*REVIEW.*ERROR/s);
  assert.match(evaluationCenter, /真实 Agent 评测/);
  const [knowledgeCenter, conversationCenter, analyticsDashboard] = await Promise.all([
    readFile(new URL("../app/KnowledgeCenter.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ConversationCenter.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AnalyticsDashboard.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(knowledgeCenter, /上传知识文档/);
  assert.match(knowledgeCenter, /保存后立即参与 Agent 检索/);
  assert.match(conversationCenter, /继续对话/);
  assert.match(conversationCenter, /转人工处理/);
  assert.match(analyticsDashboard, /知识缺口队列/);
  assert.match(analyticsDashboard, /自动评测质量门禁/);
  const demoPage = await readFile(new URL("../app/demo/page.tsx", import.meta.url), "utf8");
  assert.match(demoPage, /正在输入/);
  assert.match(demoPage, /conversation_id/);
  assert.match(demoPage, /这条回答有帮助吗/);
  assert.doesNotMatch(demoPage, /risk_review|plan\.steps|EXECUTION TRACE/);
  assert.match(toolRegistry, /createTool/);
  assert.match(toolRegistry, /duplicateTool/);
  assert.match(coze, /stream_resume/);
  assert.match(llm, /LLM_JSON_MODE/);
  assert.match(llm, /response_format/);
  assert.doesNotMatch(page + layout + toolRegistry + coze + llm, /pat_[A-Za-z0-9]{20,}/);
});
