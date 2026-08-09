import { assessSensitiveRequest } from "./privacy.mjs";
import { asksOnboardingMaterials, detectQuestionContext } from "./question-intent.mjs";

const BASE_MANDATORY = ["question_structuring", "employee_lookup", "knowledge_lookup", "reply_generation", "risk_review"];

function error(code, capabilityId, message, severity = "blocking") {
  return { code, capability_id: capabilityId || null, message, severity };
}

export function mandatoryCapabilitiesFor(question = "", base = BASE_MANDATORY) {
  const context = detectQuestionContext(question);
  const required = new Set(Array.isArray(base) && base.length ? base : BASE_MANDATORY);
  if (asksOnboardingMaterials(question)) required.add("material_lookup");
  if (context.task) { required.add("task_lookup"); required.add("task_status"); required.add("task_decision"); }
  if (context.policy) { required.add("policy_lookup"); required.add("policy_qa"); }
  if (context.training) required.add("training_lookup");
  if (context.process) required.add("process_explanation");
  if (context.coze) required.add("run_coze_workflow_7659350798523416603");
  return [...required];
}

export function validatePlan(plan, { skills = [], tools = [], question = "", mandatoryCapabilities } = {}) {
  const errors = [];
  const warnings = [];
  const skillMap = new Map(skills.map((item) => [item.id, item]));
  const toolMap = new Map(tools.map((item) => [item.id, item]));
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const ids = new Set();
  const capabilities = new Set();
  const context = detectQuestionContext(question);
  const mandatory = mandatoryCapabilities || plan?.mandatory_capabilities || mandatoryCapabilitiesFor(question);

  if (!steps.length) errors.push(error("PLAN_EMPTY", null, "Plan 没有可执行步骤。"));
  for (const step of steps) {
    if (!step?.id || ids.has(step.id)) errors.push(error("INVALID_STEP_ID", step?.capability_id, `步骤 ID 缺失或重复：${step?.id || "未提供"}`));
    ids.add(step?.id);
    capabilities.add(step?.capability_id);
    const registry = step?.kind === "skill" ? skillMap : step?.kind === "tool" ? toolMap : null;
    const capability = registry?.get(step?.capability_id);
    if (!registry) errors.push(error("INVALID_CAPABILITY_KIND", step?.capability_id, `能力类型无效：${step?.kind || "未提供"}`));
    else if (!capability) errors.push(error("CAPABILITY_NOT_FOUND", step.capability_id, `能力不存在：${step.capability_id}`));
    else if (!capability.enabled) errors.push(error("CAPABILITY_DISABLED", step.capability_id, `能力已禁用：${capability.name}`));
  }

  for (const step of steps) {
    for (const dependency of step.depends_on || []) if (!ids.has(dependency)) errors.push(error("DEPENDENCY_NOT_FOUND", step.capability_id, `步骤 ${step.id} 依赖不存在的节点 ${dependency}`));
  }

  const remaining = [...steps];
  const ordered = [];
  while (remaining.length) {
    const index = remaining.findIndex((step) => (step.depends_on || []).every((dependency) => ordered.some((item) => item.id === dependency)));
    if (index < 0) { errors.push(error("CYCLIC_DEPENDENCY", null, "Plan 存在循环依赖，无法执行。")); break; }
    ordered.push(remaining.splice(index, 1)[0]);
  }

  for (const capabilityId of mandatory) {
    if (!capabilities.has(capabilityId)) errors.push(error("MANDATORY_CAPABILITY_MISSING", capabilityId, `必需能力未包含：${capabilityId}`));
  }
  if (asksOnboardingMaterials(question) && !capabilities.has("material_lookup")) errors.push(error("MATERIAL_TOOL_MISSING", "material_lookup", "入职材料问题缺少材料查询 Tool。"));
  if (context.task && (!capabilities.has("task_lookup") || !capabilities.has("task_status"))) errors.push(error("TASK_TOOLS_MISSING", "task_lookup", "任务或进度问题缺少任务查询与状态计算能力。"));
  if (context.policy && !capabilities.has("knowledge_lookup")) errors.push(error("KNOWLEDGE_TOOL_MISSING", "knowledge_lookup", "制度问题缺少统一知识检索能力。"));
  if (["high", "critical"].includes(assessSensitiveRequest(question).level) && !capabilities.has("risk_review")) errors.push(error("RISK_REVIEW_MISSING", "risk_review", "敏感问题缺少风险审核，运行已阻断。"));
  if (capabilities.has("run_coze_workflow_7659350798523416603") && !context.coze) errors.push(error("COZE_NOT_EXPLICITLY_REQUESTED", "run_coze_workflow_7659350798523416603", "用户未明确要求 Coze，不允许调用 Coze 工作流。"));

  const valid = !errors.some((item) => item.severity === "blocking");
  return {
    valid,
    errors,
    warnings,
    validated_plan: valid ? { ...plan, steps: ordered } : null,
    action: valid ? "continue" : "block_and_handoff",
    checked_at: new Date().toISOString(),
  };
}
