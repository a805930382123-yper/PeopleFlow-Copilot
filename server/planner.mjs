import { listSkills } from "./skill-registry.mjs";
import { listTools } from "./tool-registry.mjs";
import { getPlannerConfig } from "./plan-registry.mjs";
import { asksHrPartner, asksManager, asksOnboardingMaterials, detectQuestionContext, isSensitiveQuestion } from "./question-intent.mjs";
import { readJson } from "./json-store.mjs";
import { callModel } from "./llm.mjs";
import { assessSensitiveRequest } from "./privacy.mjs";
import { mandatoryCapabilitiesFor } from "./plan-validator.mjs";

const basePlannerSkill = {
  model: "gpt-4.1-mini",
  temperature: 0,
  max_tokens: 900,
  prompt: "你是企业入职助手的能力编排器。根据用户问题从候选节点中选择最小且充分的执行集合。必须保留问题结构化、员工查询、统一知识检索、回复生成和风险审核；需要任务、制度、培训、联系人或流程时选择对应节点。不得为普通问题选择 Coze，只有用户明确要求 Coze/扣子工作流时才能选择。只选择候选 node_id，不得编造能力。",
  output_example: { selected_node_ids: ["identify", "employee", "knowledge", "reply", "review"], rationale: "基础知识问答链路" },
};

function includeDependencies(nodes, selectedIds) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = new Set(selectedIds);
  const visit = (id) => {
    const node = byId.get(id);
    if (!node) return;
    selected.add(id);
    (node.depends_on || []).forEach((dependency) => { visit(dependency); selected.add(dependency); });
  };
  [...selected].forEach(visit);
  return selected;
}

function decideRoute(question, context) {
  if (context.coze) return { type: "coze_workflow", label: "Coze 工作流", confidence: 0.99, reason: "用户明确要求调用 Coze/扣子工作流" };
  if (isSensitiveQuestion(question)) return { type: "sensitive_handoff", label: "敏感问答 + 人工转接", confidence: 0.98, reason: "问题涉及薪资、福利、合同、争议或个人敏感信息" };
  if (asksManager(question) || asksHrPartner(question)) return { type: "employee_data", label: "员工数据查询", confidence: 0.98, reason: "问题需要读取当前员工档案或联系人" };
  if (asksOnboardingMaterials(question)) return { type: "onboarding_materials", label: "入职材料查询", confidence: 0.98, reason: "问题明确询问报到或入职材料" };
  if (context.policy) return { type: "policy_knowledge", label: "制度知识问答", confidence: 0.95, reason: "问题命中制度、福利或工作规范主题" };
  if (context.task || context.process) return { type: "task_process", label: "任务与流程", confidence: 0.93, reason: "问题需要查询待办状态或解释办理流程" };
  if (context.training) return { type: "training_knowledge", label: "培训知识问答", confidence: 0.94, reason: "问题涉及课程或学习安排" };
  return { type: "general_knowledge", label: "通用知识检索", confidence: 0.72, reason: "未命中专用路由，使用统一知识检索并执行无答案兜底" };
}

export async function createPlan(question, planId = "default_onboarding_plan", options = {}) {
  const [skills, tools, configured, policies] = await Promise.all([listSkills(), listTools(), getPlannerConfig(planId), readJson("policies.json")]);
  if (!configured.enabled) throw new Error(`Plan 已禁用：${configured.name}`);
  const allowedSkills = new Set(configured.allowed_skills || skills.map((item) => item.id));
  const allowedTools = new Set(configured.allowed_tools || tools.map((item) => item.id));
  const temporarilyDisabledSkills = new Set(options.disabledSkills || []);
  const temporarilyDisabledTools = new Set(options.disabledTools || []);
  const registries = {
    skill: new Map(skills.filter((item) => item.enabled && allowedSkills.has(item.id) && !temporarilyDisabledSkills.has(item.id)).map((item) => [item.id, item])),
    tool: new Map(tools.filter((item) => item.enabled && allowedTools.has(item.id) && !temporarilyDisabledTools.has(item.id)).map((item) => [item.id, item])),
  };
  const context = detectQuestionContext(question);
  const routeDecision = decideRoute(question, context);
  const normalizedQuestion = question.toLowerCase();
  context.policy ||= policies.some((policy) => policy.active && (policy.keywords || []).some((keyword) => normalizedQuestion.includes(String(keyword).toLowerCase())));
  if (context.rejects_policy) context.policy = false;
  const enabledNodes = configured.nodes.filter((node) => node.enabled !== false && registries[node.kind]?.has(node.capability_id));
  const ruleNodes = enabledNodes.filter((node) => context[node.condition || "always"] !== false);
  const mandatoryCapabilityIds = mandatoryCapabilitiesFor(question, configured.mandatory_capabilities);
  const mandatoryNodeIds = enabledNodes
    .filter((node) => mandatoryCapabilityIds.includes(node.capability_id))
    .map((node) => node.id);
  let activeNodes = ruleNodes;
  let selectionMode = "rules";
  let plannerRationale = "根据问题关键词和节点条件生成确定性候选 Plan。";
  let plannerFallbackReason = null;
  let plannerTokenUsage = null;
  let plannerRuntime = null;
  const plannerMode = options.forceRules ? "rules" : configured.mode || (process.env.PLANNER_MODE || "hybrid").toLowerCase();
  if (plannerMode === "hybrid") {
    try {
      const plannerSkill = { ...basePlannerSkill, prompt: configured.planner_prompt || basePlannerSkill.prompt };
      const result = await callModel(plannerSkill, { question, conversation_history: options.conversationHistory || [], mandatory_capabilities: mandatoryCapabilityIds, candidates: enabledNodes.map((node) => ({ node_id: node.id, kind: node.kind, capability_id: node.capability_id, goal: node.goal, condition: node.condition })) }, async () => ({ selected_node_ids: ruleNodes.map((node) => node.id), rationale: plannerRationale }));
      plannerTokenUsage = result.token_usage || null;
      plannerRuntime = { provider: result.provider, model: result.model, mode: result.mode, attempts: result.attempts || 1 };
      const proposed = Array.isArray(result.data?.selected_node_ids) ? result.data.selected_node_ids.filter((nodeId) => enabledNodes.some((node) => node.id === nodeId)) : [];
      const required = ["identify", "employee", "knowledge", "reply", "review"];
      const safe = proposed.filter((nodeId) => nodeId !== "coze" || context.coze);
      // A model can omit a capability even when the prompt marks it as mandatory.
      // Add global and question-specific mandatory nodes deterministically before validation.
      const selected = includeDependencies(enabledNodes, [...required, ...mandatoryNodeIds, ...safe]);
      const validated = enabledNodes.filter((node) => selected.has(node.id)).slice(0, configured.max_nodes || 14);
      if (validated.length >= required.length && required.every((nodeId) => validated.some((node) => node.id === nodeId))) {
        activeNodes = validated;
        selectionMode = result.mode === "live" ? "llm_validated" : "rules";
        plannerRationale = result.data?.rationale || plannerRationale;
      } else {
        selectionMode = "rules_fallback";
        plannerFallbackReason = "模型返回的候选 Plan 未包含全部必需能力，已使用确定性规则 Plan。";
      }
    } catch (error) {
      plannerTokenUsage ||= error.token_usage || null;
      const message = String(error?.message || "");
      const isModelOutputError = message.includes("有效 JSON") || message.includes("返回内容为空") || error?.code === "LLM_INVALID_RESPONSE";
      if (!isModelOutputError) throw error;
      selectionMode = "rules_fallback";
      plannerFallbackReason = `Planner 模型输出无法解析：${message}；已使用确定性规则 Plan。`;
    }
  }
  const activeIds = new Set(activeNodes.map((node) => node.id));
  const orderedNodes = [];
  const pending = [...activeNodes];
  while (pending.length) {
    const index = pending.findIndex((node) => (node.depends_on || []).filter((dep) => activeIds.has(dep)).every((dep) => orderedNodes.some((item) => item.id === dep)));
    if (index < 0) throw new Error("Plan 存在循环依赖，请检查节点 depends_on 配置");
    orderedNodes.push(pending.splice(index, 1)[0]);
  }
  const steps = orderedNodes.map((node) => {
    const capability = registries[node.kind]?.get(node.capability_id);
    if (!capability) throw new Error(`Plan 需要的能力未启用或不存在：${node.capability_id}`);
    return {
      id: node.id,
      capability_id: node.capability_id,
      name: capability.name,
      kind: node.kind,
      goal: node.goal || capability.description,
      condition: node.condition || "always",
      retry: Math.max(0, Number(node.retry || 0)),
      depends_on: (node.depends_on || []).filter((dep) => activeIds.has(dep)),
    };
  });
  const topics = Object.entries(context).filter(([key, value]) => key !== "always" && value).map(([key]) => ({ materials: "入职报到材料", task: "入职任务", policy: "制度", training: "培训", contact: "负责人", coze: "Coze 工作流", process: "办理流程" }[key])).filter(Boolean);
  const mandatoryCapabilities = mandatoryCapabilityIds;
  const riskAssessment = assessSensitiveRequest(question);
  const selectedSkills = steps.filter((step) => step.kind === "skill").map((step) => step.capability_id);
  const selectedTools = steps.filter((step) => step.kind === "tool").map((step) => step.capability_id);
  const rationale = `路由到「${routeDecision.label}」；问题涉及${topics.join("、") || "基础入职信息"}。${plannerRationale} 所有模型选择均经过能力白名单、依赖补全、Coze 限制和最终风险审核校验。`;
  return {
    id: configured.id,
    plan_id: configured.id,
    name: configured.name,
    rationale,
    reasoning: {
      summary: rationale,
      evidence_needs: context.policy ? ["当前有效制度或已导入知识文档"] : context.materials ? ["当前员工适用的入职材料"] : ["当前员工与入职知识证据"],
      risk_reasons: riskAssessment.level === "low" ? [] : [riskAssessment.reason],
    },
    selection_mode: selectionMode,
    planner_version: configured.version || "1.0.0",
    route_decision: routeDecision,
    route: routeDecision,
    context,
    selected_skills: selectedSkills,
    selected_tools: selectedTools,
    mandatory_capabilities: mandatoryCapabilities,
    risk_assessment: { level: riskAssessment.level, tags: riskAssessment.category === "general" ? [] : [riskAssessment.category], action: riskAssessment.action },
    fallback: { action: "safe_reply_or_handoff", reason: plannerFallbackReason },
    token_usage: plannerTokenUsage,
    planner_runtime: plannerRuntime,
    steps,
  };
}
