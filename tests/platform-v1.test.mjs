import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { callTool } from "../server/tool-registry.mjs";
import { createPlan } from "../server/planner.mjs";
import { maskSensitiveText, sanitizeForStorage, assertSelfAccess } from "../server/privacy.mjs";

test("统一知识库返回可追溯知识卡片", async () => {
  const result = await callTool("knowledge_lookup", { employee_id: "E001", query: "几点下班 考勤 工作时间" });
  assert.ok(result.knowledge_cards.length > 0);
  assert.ok(result.knowledge_cards.some((card) => card.source === "policies.json" && card.version && card.effective_date));
  assert.ok(result.retrieval_summary.sources.includes("policies.json"));
});

test("确定性 Planner 始终包含知识检索和最终风控", async () => {
  const plan = await createPlan("食堂今天有什么菜？", "default_onboarding_plan", { forceRules: true });
  assert.ok(plan.steps.some((step) => step.capability_id === "knowledge_lookup"));
  assert.equal(plan.steps.at(-1).capability_id, "risk_review");
});

test("100 条评测集结构完整", async () => {
  const cases = JSON.parse(await readFile(new URL("../data/evaluation_cases.json", import.meta.url), "utf8"));
  assert.equal(cases.length, 100);
  assert.equal(new Set(cases.map((item) => item.id)).size, 100);
  assert.ok(cases.every((item) => item.expected_any.includes("knowledge_lookup")));
});

test("Bad Case 评测集覆盖历史错误、敏感边界和上下文问题", async () => {
  const cases = JSON.parse(await readFile(new URL("../data/bad_case_evaluation_cases.json", import.meta.url), "utf8"));
  assert.ok(cases.length >= 30);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  assert.ok(cases.every((item) => item.suite === "bad_case" && item.failure_mode && item.question));
  assert.ok(cases.some((item) => item.context?.length));
  assert.ok(cases.some((item) => item.expected_risk === "high"));
});

test("存储脱敏和本人访问边界生效", () => {
  assert.match(maskSensitiveText("身份证 110105199001011234，密码: abc12345"), /身份证号已脱敏/);
  assert.doesNotMatch(JSON.stringify(sanitizeForStorage({ api_key: "sk-secretsecretsecret", text: "验证码：876543" })), /sk-secret|876543/);
  assert.throws(() => assertSelfAccess("E001", "E002"), /只能访问本人/);
  assert.doesNotThrow(() => assertSelfAccess("E001", "E001"));
});
