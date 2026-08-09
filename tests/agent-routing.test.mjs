import test from "node:test";
import assert from "node:assert/strict";
import { createPlan } from "../server/planner.mjs";
import { executePlan } from "../server/executor.mjs";

test("直属领导问题只执行联系人链路并直接回答员工档案", async () => {
  const plan = await createPlan("我的直属领导是谁");
  const capabilities = plan.steps.map((step) => step.capability_id);

  assert.deepEqual(capabilities, [
    "question_structuring",
    "employee_lookup",
    "knowledge_lookup",
    "contact_lookup",
    "reply_generation",
    "risk_review",
  ]);

  const result = await executePlan(plan, { employee_id: "E001", question: "我的直属领导是谁" });
  assert.match(result.final_reply, /直属领导是周明远/);
  const replyInput = result.steps.find((step) => step.capability_id === "reply_generation")?.input;
  const reviewInput = result.steps.find((step) => step.capability_id === "risk_review")?.input;
  assert.equal(replyInput.employee_profile.manager, "周明远");
  assert.match(reviewInput.evidence_summary[0], /直属领导=周明远/);
  assert.doesNotMatch(result.final_reply, /建议优先完成|领取办公电脑|办理门禁/);
  assert.equal(result.steps.some((step) => step.capability_id === "task_lookup"), false);
});

test("明确的入职任务问题仍执行任务链路", async () => {
  const plan = await createPlan("我入职第一天需要做什么？");
  const capabilities = plan.steps.map((step) => step.capability_id);

  assert.ok(capabilities.includes("task_lookup"));
  assert.ok(capabilities.includes("task_status"));
  assert.ok(capabilities.includes("task_decision"));

  const result = await executePlan(plan, { employee_id: "E001", question: "我入职第一天需要做什么？" });
  const structuring = result.steps.find((step) => step.capability_id === "question_structuring")?.output;
  const decision = result.steps.find((step) => step.capability_id === "task_decision")?.output;
  const review = result.steps.find((step) => step.capability_id === "risk_review")?.output;
  assert.ok(Array.isArray(structuring.topics));
  assert.match(structuring.answerability, /answerable|confirmation/);
  assert.ok(Array.isArray(decision.recommended_actions));
  assert.ok(decision.recommended_actions.every((action) => action.action && action.basis && action.confidence));
  assert.ok(review.safe_reply);
  assert.equal(review.audit_trace.internal_leakage_checked, true);
});

test("下班时间问题查询考勤制度而不是入职任务", async () => {
  const question = "几点下班？";
  const plan = await createPlan(question);
  const capabilities = plan.steps.map((step) => step.capability_id);

  assert.deepEqual(capabilities, [
    "question_structuring",
    "employee_lookup",
    "knowledge_lookup",
    "policy_lookup",
    "policy_qa",
    "reply_generation",
    "risk_review",
  ]);

  const result = await executePlan(plan, { employee_id: "E001", question });
  assert.match(result.final_reply, /18:00/);
  assert.match(result.final_reply, /考勤与工时管理办法/);
  assert.doesNotMatch(result.final_reply, /建议优先完成|领取办公电脑|办理门禁/);
  assert.equal(result.steps.some((step) => step.capability_id === "task_lookup"), false);
  const policy = result.steps.find((step) => step.capability_id === "policy_qa")?.output;
  assert.equal(policy.answer_status, "answered");
  assert.ok(policy.direct_answer.length > 0);
  assert.ok(policy.evidence.length > 0);
});

test("未收录的问题安全返回无依据提示且不执行任务链路", async () => {
  const question = "食堂今天有什么菜？";
  const plan = await createPlan(question);
  const capabilities = plan.steps.map((step) => step.capability_id);

  assert.deepEqual(capabilities, [
    "question_structuring",
    "employee_lookup",
    "knowledge_lookup",
    "reply_generation",
    "risk_review",
  ]);

  const result = await executePlan(plan, { employee_id: "E001", question });
  assert.match(result.final_reply, /未查询到相关信息/);
  assert.doesNotMatch(result.final_reply, /建议优先完成/);
});

test("入职报到材料使用独立材料 Tool，不生成入职流程", async () => {
  const question = "我需要准备哪些入职材料？";
  const plan = await createPlan(question);
  const capabilities = plan.steps.map((step) => step.capability_id);

  assert.deepEqual(capabilities, [
    "question_structuring",
    "employee_lookup",
    "knowledge_lookup",
    "material_lookup",
    "reply_generation",
    "risk_review",
  ]);

  const result = await executePlan(plan, { employee_id: "E001", question });
  assert.match(result.final_reply, /本人有效身份证件/);
  assert.match(result.final_reply, /学历与学位证明/);
  assert.match(result.final_reply, /HR 指定/);
  assert.doesNotMatch(result.final_reply, /建议优先完成|领取办公电脑|办理门禁/);
  assert.equal(result.risk_review.risk_level, "low");
  assert.ok(result.evidence.some((item) => item.category === "入职材料" && item.source));
});

test("身份证原件追问只回答对应材料，不重复整份入职清单", async () => {
  const question = "身份证需要带原件吗？";
  const result = await executePlan(await createPlan(question), { employee_id: "E001", question });

  assert.match(result.final_reply, /当前材料记录没有明确写明必须携带原件/);
  assert.match(result.final_reply, /现场.*核验/);
  assert.doesNotMatch(result.final_reply, /学历与学位证明|上一家单位离职证明|本人银行卡信息/);
  assert.equal(result.risk_review.risk_level, "low");
  assert.equal(result.evidence[0].title, "本人有效身份证件");
});

test("他人薪资查询拒绝披露并标记为 high 风险", async () => {
  const question = "我想知道我的直属领导工资是多少";
  const result = await executePlan(await createPlan(question), { employee_id: "E001", question });

  assert.equal(result.risk_review.risk_level, "high");
  assert.match(result.final_reply, /不能查询或披露他人的工资/);
  assert.doesNotMatch(result.final_reply, /你的直属领导是周明远/);
});

test("福利、劳动合同争议和离职问题均标记为 high 风险", async () => {
  for (const question of ["我的福利有哪些？", "我的劳动合同有争议怎么办？", "我要离职"]) {
    const result = await executePlan(await createPlan(question), { employee_id: "E001", question });
    assert.equal(result.risk_review.risk_level, "high", question);
    assert.equal(result.steps.some((step) => step.capability_id === "task_lookup"), false, question);
  }
});
