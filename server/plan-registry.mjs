import { readJson, updateRecord, writeJson } from "./json-store.mjs";
import { getVersion, listVersions, nextPatchVersion, snapshotVersion, textDiff } from "./versioning.mjs";
import { getRuntimeEnv } from "./runtime-env.mjs";

const VERSION_FILE = "planner_versions.json";
export const DEFAULT_PLANNER_PROMPT = "你是企业入职助手的能力编排器。根据员工问题、会话上下文、当前启用的 Skill 和 Tool，选择最小且充分的执行集合。必须保留问题结构化、员工查询、统一知识检索、回复生成和风险审核；根据入职材料、任务、制度、培训、联系人或流程主题选择对应能力。不得选择未启用或不存在的能力。只有用户明确要求 Coze/扣子工作流时才能选择 Coze Tool。输出结构化 JSON，不得编造能力。";

export const listPlans = () => readJson("plans.json");

export async function getPlan(id = "default_onboarding_plan") {
  const plan = (await listPlans()).find((item) => item.id === id);
  if (!plan) throw Object.assign(new Error(`Plan 不存在：${id}`), { code: "PLAN_NOT_FOUND", status: 404 });
  return plan;
}

export async function getPlannerConfig(id = "default_onboarding_plan") {
  const [plan, skills, tools] = await Promise.all([getPlan(id), readJson("skills.json"), readJson("tools.json")]);
  return {
    ...plan,
    version: plan.version || "1.0.0",
    planner_prompt: plan.planner_prompt || DEFAULT_PLANNER_PROMPT,
    mode: plan.mode || (getRuntimeEnv("PLANNER_MODE") || "hybrid").toLowerCase(),
    mandatory_capabilities: plan.mandatory_capabilities || ["question_structuring", "employee_lookup", "knowledge_lookup", "reply_generation", "risk_review"],
    allowed_skills: plan.allowed_skills || skills.map((item) => item.id),
    allowed_tools: plan.allowed_tools || tools.map((item) => item.id),
    max_nodes: Number(plan.max_nodes || 14),
    risk_strategy: plan.risk_strategy || "敏感人事问题必须经过风险审核；高风险转人工，严重风险阻断。",
    fallback_strategy: plan.fallback_strategy || "能力不足或计划非法时安全降级并转人工，不得伪装成功。",
  };
}

async function validatePlanPatch(id, patch) {
  if (patch.nodes && !Array.isArray(patch.nodes)) throw Object.assign(new Error("Plan nodes 必须是数组"), { code: "INVALID_PLAN_NODES" });
  if (patch.mode && !["rules", "hybrid"].includes(patch.mode)) throw Object.assign(new Error("Planner 模式只能是 rules 或 hybrid"), { code: "INVALID_PLANNER_MODE" });
  if (patch.max_nodes !== undefined && (!Number.isInteger(Number(patch.max_nodes)) || Number(patch.max_nodes) < 5 || Number(patch.max_nodes) > 30)) throw Object.assign(new Error("最大节点数必须是 5 到 30 的整数"), { code: "INVALID_MAX_NODES" });
  const [skills, tools] = await Promise.all([readJson("skills.json"), readJson("tools.json")]);
  const skillIds = new Set(skills.map((item) => item.id));
  const toolIds = new Set(tools.map((item) => item.id));
  for (const item of patch.allowed_skills || []) if (!skillIds.has(item)) throw Object.assign(new Error(`允许的 Skill 不存在：${item}`), { code: "PLANNER_SKILL_NOT_FOUND" });
  for (const item of patch.allowed_tools || []) if (!toolIds.has(item)) throw Object.assign(new Error(`允许的 Tool 不存在：${item}`), { code: "PLANNER_TOOL_NOT_FOUND" });
  const allCapabilities = new Set([...skillIds, ...toolIds]);
  for (const item of patch.mandatory_capabilities || []) if (!allCapabilities.has(item)) throw Object.assign(new Error(`必需能力不存在：${item}`), { code: "MANDATORY_CAPABILITY_NOT_FOUND" });
  if (patch.nodes) {
    const ids = new Set();
    for (const node of patch.nodes) {
      if (!node.id || ids.has(node.id)) throw Object.assign(new Error(`Plan 节点 ID 缺失或重复：${node.id || "空"}`), { code: "DUPLICATE_PLAN_NODE" });
      ids.add(node.id);
      if (!["skill", "tool"].includes(node.kind)) throw Object.assign(new Error(`节点类型无效：${node.kind}`), { code: "INVALID_PLAN_NODE_KIND" });
      if (!(node.kind === "skill" ? skillIds : toolIds).has(node.capability_id)) throw Object.assign(new Error(`节点能力不存在：${node.capability_id}`), { code: "PLAN_CAPABILITY_NOT_FOUND" });
      node.depends_on = Array.isArray(node.depends_on) ? node.depends_on.filter((dep) => dep !== node.id) : [];
      node.retry = Math.max(0, Math.min(3, Number(node.retry || 0)));
    }
    for (const node of patch.nodes) for (const dep of node.depends_on) if (!ids.has(dep)) throw Object.assign(new Error(`节点 ${node.id} 引用了不存在的依赖：${dep}`), { code: "PLAN_DEPENDENCY_NOT_FOUND" });
  }
  if (patch.planner_prompt !== undefined && !String(patch.planner_prompt).trim()) throw Object.assign(new Error("Planner Prompt 不能为空"), { code: "PLANNER_PROMPT_REQUIRED" });
  return { ...patch, id, max_nodes: patch.max_nodes === undefined ? undefined : Number(patch.max_nodes) };
}

export async function savePlan(id, patch, options = {}) {
  const current = await getPlan(id);
  const safe = { ...patch };
  const changeNote = safe.change_note || safe.changeNote || options.changeNote || "更新 Planner 配置";
  delete safe.id;
  delete safe.change_note;
  delete safe.changeNote;
  const validated = await validatePlanPatch(id, safe);
  await snapshotVersion(VERSION_FILE, id, await getPlannerConfig(id), changeNote, options.source || "management");
  return updateRecord("plans.json", id, { ...validated, version: nextPatchVersion(current.version || "1.0.0"), updated_at: new Date().toISOString() });
}

export async function plannerVersions(id = "default_onboarding_plan") {
  const current = await getPlannerConfig(id);
  return (await listVersions(VERSION_FILE, id)).map((item) => ({ ...item, diff: textDiff(item.content?.planner_prompt, current.planner_prompt) }));
}

export async function plannerVersion(id, versionId) {
  const current = await getPlannerConfig(id);
  const version = await getVersion(VERSION_FILE, id, versionId);
  return { ...version, diff: textDiff(version.content?.planner_prompt, current.planner_prompt) };
}

export async function restorePlannerVersion(id, versionId, changeNote) {
  const current = await getPlannerConfig(id);
  const historical = await getVersion(VERSION_FILE, id, versionId);
  await snapshotVersion(VERSION_FILE, id, current, changeNote || `恢复前快照：${current.version}`, "restore");
  const content = await validatePlanPatch(id, { ...historical.content });
  delete content.id;
  return updateRecord("plans.json", id, { ...content, version: nextPatchVersion(current.version), updated_at: new Date().toISOString() });
}

export async function importPlans(plans) {
  if (!Array.isArray(plans) || !plans.length) throw new Error("导入配置缺少 plans");
  await writeJson("plans.json", plans);
  return plans;
}
