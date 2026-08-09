import assert from "node:assert/strict";
import test from "node:test";
import { createPlan } from "../server/planner.mjs";
import { validatePlan } from "../server/plan-validator.mjs";
import { listSkills } from "../server/skill-registry.mjs";
import { listTools } from "../server/tool-registry.mjs";

test("Plan Validator 接受完整的材料查询链路", async () => {
  const [skills, tools, plan] = await Promise.all([listSkills(), listTools(), createPlan("需要准备什么入职材料？", "default_onboarding_plan", { forceRules: true })]);
  const result = validatePlan(plan, { skills, tools, question: "需要准备什么入职材料？" });
  assert.equal(result.valid, true);
  assert.ok(plan.selected_tools.includes("material_lookup"));
});

test("Plan Validator 阻断缺少风险审核的敏感链路", async () => {
  const [skills, tools, plan] = await Promise.all([listSkills(), listTools(), createPlan("我有劳动合同争议", "default_onboarding_plan", { forceRules: true })]);
  plan.steps = plan.steps.filter((step) => step.capability_id !== "risk_review");
  const result = validatePlan(plan, { skills, tools, question: "我有劳动合同争议" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === "RISK_REVIEW_MISSING" || item.code === "MANDATORY_CAPABILITY_MISSING"));
});

test("未明确要求 Coze 时禁止选择 Coze Tool", async () => {
  const [skills, tools, plan] = await Promise.all([listSkills(), listTools(), createPlan("几点下班？", "default_onboarding_plan", { forceRules: true })]);
  plan.steps.push({ id: "illegal-coze", kind: "tool", capability_id: "run_coze_workflow_7659350798523416603", depends_on: ["employee"] });
  const result = validatePlan(plan, { skills, tools, question: "几点下班？" });
  assert.ok(result.errors.some((item) => item.code === "COZE_NOT_EXPLICITLY_REQUESTED"));
});
