import { readJson, updateRecord, writeJson } from "./json-store.mjs";
import { runCozeWorkflowDetailed } from "./coze-workflow.mjs";
import { getVersion, listVersions, nextPatchVersion, snapshotVersion } from "./versioning.mjs";
import { searchKnowledgeDocuments } from "./knowledge-rag.mjs";

const stageRank = { pre_onboarding: 0, day_1: 1, week_1: 2, week_2: 3, day_30: 4, day_90: 5 };
const VERSION_FILE = "tool_versions.json";
const CORE_TOOLS = new Set(["employee_lookup", "knowledge_lookup"]);
export const listTools = () => readJson("tools.json");

const validateId = (id) => {
  if (!/^[a-z][a-z0-9_]{2,80}$/.test(id || "")) throw new Error("Tool ID 只能使用小写字母、数字和下划线，且必须以字母开头");
};

export async function getTool(id, requireEnabled = true) {
  const tool = (await listTools()).find((item) => item.id === id);
  if (!tool) throw new Error(`Tool 不存在：${id}`);
  if (requireEnabled && !tool.enabled) throw new Error(`Tool 已禁用，Executor 拒绝执行：${tool.name}`);
  return tool;
}

export async function createTool(input) {
  validateId(input?.id);
  const rows = await listTools();
  if (rows.some((row) => row.id === input.id)) throw new Error(`Tool ID 已存在：${input.id}`);
  const tool = {
    id: input.id,
    name: input.name?.trim() || input.id,
    description: input.description?.trim() || "自定义 Tool",
    enabled: input.enabled !== false,
    type: input.type || "http",
    source: input.source || input.endpoint || "custom",
    endpoint: input.endpoint || "",
    method: (input.method || "POST").toUpperCase(),
    timeout_ms: Math.max(1000, Number(input.timeout_ms || 30000)),
    auth_env_var: input.auth_env_var || "",
    headers: input.headers && typeof input.headers === "object" ? input.headers : {},
    input_schema: input.input_schema && typeof input.input_schema === "object" ? input.input_schema : {},
    output_schema: input.output_schema && typeof input.output_schema === "object" ? input.output_schema : {},
    workflow_id: input.workflow_id || "",
    base_url: input.base_url || "",
    answer_node_titles: Array.isArray(input.answer_node_titles) ? input.answer_node_titles : [],
    output_example: input.output_example && typeof input.output_example === "object" ? input.output_example : {},
    version: "1.0.0",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  rows.unshift(tool);
  await writeJson("tools.json", rows);
  return tool;
}

export async function saveTool(id, patch) {
  validateId(id);
  const current = await getTool(id, false);
  const safe = { ...patch };
  const changeNote = safe.change_note || safe.changeNote || "更新 Tool 配置";
  delete safe.id;
  delete safe.change_note;
  delete safe.changeNote;
  if (safe.method) safe.method = safe.method.toUpperCase();
  if (safe.timeout_ms !== undefined) safe.timeout_ms = Math.max(1000, Number(safe.timeout_ms || 30000));
  if (safe.headers && typeof safe.headers === "object") {
    safe.headers = Object.fromEntries(Object.entries(safe.headers).map(([key, value]) => {
      if (value === "***configured***") return [key, current.headers?.[key] || ""];
      if (/authorization|api[-_]?key|token|secret/i.test(key) || /^(?:Bearer\s+|pat_|sk-)/i.test(String(value))) throw Object.assign(new Error(`Header ${key} 疑似包含密钥，请改用 auth_env_var`), { code: "TOOL_SECRET_IN_CONFIG" });
      return [key, value];
    }));
  }
  if (safe.enabled === false && CORE_TOOLS.has(id)) throw Object.assign(new Error(`Tool ${id} 是默认 Plan 的必需能力，不能直接禁用`), { code: "MANDATORY_TOOL_DISABLE_BLOCKED", status: 409, details: { capability_id: id } });
  if (safe.auth_env_var && !/^[A-Z][A-Z0-9_]*$/.test(safe.auth_env_var)) throw Object.assign(new Error("鉴权环境变量名格式无效"), { code: "INVALID_AUTH_ENV_VAR" });
  if (safe.endpoint && !/^https?:\/\//i.test(safe.endpoint)) throw Object.assign(new Error("HTTP Tool endpoint 必须以 http:// 或 https:// 开头"), { code: "INVALID_TOOL_ENDPOINT" });
  const configurationKeys = ["name", "description", "enabled", "type", "source", "endpoint", "method", "timeout_ms", "auth_env_var", "headers", "input_schema", "output_schema", "output_example", "workflow_id", "base_url", "answer_node_titles"];
  const configurationChanged = Object.keys(safe).some((key) => configurationKeys.includes(key));
  if (configurationChanged) await snapshotVersion(VERSION_FILE, id, current, changeNote, "management");
  return updateRecord("tools.json", id, { ...safe, version: configurationChanged ? nextPatchVersion(current.version || "1.0.0") : current.version || "1.0.0", updated_at: new Date().toISOString() });
}

export async function toolVersions(id) { await getTool(id, false); return listVersions(VERSION_FILE, id); }
export async function toolVersion(id, versionId) { await getTool(id, false); return getVersion(VERSION_FILE, id, versionId); }
export async function restoreToolVersion(id, versionId, changeNote) {
  const current = await getTool(id, false);
  const historical = await getVersion(VERSION_FILE, id, versionId);
  await snapshotVersion(VERSION_FILE, id, current, changeNote || `恢复前快照：${current.version}`, "restore");
  const restored = { ...historical.content, id, version: nextPatchVersion(current.version || "1.0.0"), updated_at: new Date().toISOString() };
  delete restored.last_test;
  return updateRecord("tools.json", id, restored);
}

export async function deleteTool(id) {
  const rows = await listTools();
  const next = rows.filter((row) => row.id !== id);
  if (next.length === rows.length) throw new Error(`Tool 不存在：${id}`);
  await writeJson("tools.json", next);
  return { id, deleted: true };
}

export async function duplicateTool(id) {
  const source = await getTool(id, false);
  const rows = await listTools();
  let nextId = `${id}_copy`;
  let suffix = 2;
  while (rows.some((row) => row.id === nextId)) nextId = `${id}_copy_${suffix++}`;
  return createTool({ ...source, id: nextId, name: `${source.name} 副本`, last_test: undefined });
}

function validateInput(tool, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool 输入必须是 JSON 对象");
  for (const [key, type] of Object.entries(tool.input_schema || {})) {
    if (!Object.hasOwn(input, key)) throw new Error(`缺少输入字段：${key}`);
    if (type === "string" && typeof input[key] !== "string") throw new Error(`${key} 必须是字符串`);
    if (type === "number" && typeof input[key] !== "number") throw new Error(`${key} 必须是数字`);
    if (type === "boolean" && typeof input[key] !== "boolean") throw new Error(`${key} 必须是布尔值`);
    if (type === "string[]" && (!Array.isArray(input[key]) || input[key].some((item) => typeof item !== "string"))) throw new Error(`${key} 必须是字符串数组`);
  }
}

async function callHttpTool(tool, input) {
  if (!/^https?:\/\//i.test(tool.endpoint || "")) throw new Error("HTTP Tool endpoint 必须以 http:// 或 https:// 开头");
  const method = (tool.method || "POST").toUpperCase();
  const url = new URL(tool.endpoint);
  if (method === "GET") Object.entries(input).forEach(([key, value]) => url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value)));
  const headers = { "Content-Type": "application/json", ...(tool.headers || {}) };
  if (tool.auth_env_var) {
    const secret = process.env[tool.auth_env_var];
    if (!secret) throw new Error(`未配置环境变量：${tool.auth_env_var}`);
    if (!headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${secret}`;
  }
  const controller = new AbortController();
  const timeout = Math.max(1000, Number(tool.timeout_ms || 30000));
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = Date.now();
  try {
    const response = await fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(input), signal: controller.signal });
    const text = await response.text();
    const output = (() => { try { return JSON.parse(text); } catch { return text; } })();
    const trace = [{ index: 0, event: "HTTP", node_title: `${method} ${url.origin}${url.pathname}`, status_code: response.status, duration_ms: Date.now() - started, timestamp: new Date().toISOString() }];
    if (!response.ok) throw new Error(`HTTP Tool 请求失败（${response.status}）：${typeof output === "string" ? output.slice(0, 200) : JSON.stringify(output).slice(0, 200)}`);
    return { output, trace, request: { url: url.toString(), method, headers: Object.fromEntries(Object.keys(headers).map((key) => [key, /authorization/i.test(key) ? "***" : headers[key]])) } };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`HTTP Tool 在 ${timeout}ms 内未完成`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function callLocalTool(id, input) {
  if (id === "employee_lookup") {
    const employee = (await readJson("employees.json")).find((item) => item.id === input.employee_id);
    if (!employee) throw new Error("未查询到当前员工信息");
    return employee;
  }
  if (id === "knowledge_lookup") {
    const [policies, materials, tasks, trainings, employees, documentSearch] = await Promise.all([readJson("policies.json"), readJson("onboarding_materials.json"), readJson("onboarding_tasks.json"), readJson("trainings.json"), readJson("employees.json"), searchKnowledgeDocuments({ query: input.query, limit: 8 })]);
    const employee = employees.find((item) => item.id === input.employee_id);
    const query = String(input.query || "").toLowerCase();
    const tokens = [...new Set(query.split(/[\s，。！？、；：,.!?;:（）()]+/).filter((token) => token.length > 1))];
    const score = (text, keywords = []) => {
      const haystack = `${text} ${keywords.join(" ")}`.toLowerCase();
      let value = tokens.reduce((total, token) => total + (haystack.includes(token) || query.includes(token) && keywords.some((keyword) => query.includes(String(keyword).toLowerCase())) ? 3 : 0), 0);
      for (const keyword of keywords) if (query.includes(String(keyword).toLowerCase())) value += 5;
      return value;
    };
    const cards = [
      ...policies.filter((item) => item.active).map((item) => ({ id: `KB-${item.id}`, category: "制度", title: item.name, content: item.summary, keywords: item.keywords || [], source: "policies.json", source_id: item.id, version: item.version, effective_date: item.effective_date, scope: item.scope })),
      ...materials.filter((item) => item.applies_to.includes("all") || item.applies_to.includes(employee?.department) || item.applies_to.includes(employee?.position)).map((item) => ({ id: `KB-${item.id}`, category: "入职材料", title: item.name, content: `${item.purpose}；提交渠道：${item.submission_channel}；注意：${item.note}`, keywords: ["入职材料", "报到材料", "准备", "携带", item.name], source: "onboarding_materials.json", source_id: item.id, version: "local-1", effective_date: null, scope: item.applies_to.join("、") })),
      ...tasks.filter((item) => (item.departments.includes("all") || item.departments.includes(employee?.department)) && (item.positions.includes("all") || item.positions.includes(employee?.position))).map((item) => ({ id: `KB-${item.id}`, category: "入职任务", title: item.name, content: `${item.description}；建议时间：${item.recommended_time}；责任方：${item.owner}`, keywords: ["入职任务", "第一天", "待办", item.name], source: "onboarding_tasks.json", source_id: item.id, version: "local-1", effective_date: null, scope: item.stage })),
      ...trainings.filter((item) => (item.departments.includes("all") || item.departments.includes(employee?.department)) && (item.positions.includes("all") || item.positions.includes(employee?.position))).map((item) => ({ id: `KB-${item.id}`, category: "培训", title: item.name, content: `${item.type}；时间：${item.time}；形式：${item.format}；责任方：${item.owner}`, keywords: ["培训", "课程", "学习", item.name], source: "trainings.json", source_id: item.id, version: "local-1", effective_date: null, scope: item.stage })),
      ...documentSearch.knowledge_cards.map((item) => ({ ...item, keywords: [item.title, item.section, item.category].filter(Boolean), scope: "all", rag_score: item.score })),
    ].map((card) => ({ ...card, score: Math.max(score(`${card.category} ${card.title} ${card.content}`, card.keywords), Math.ceil(Number(card.rag_score || 0) * 10)) }));
    const matched = cards.filter((card) => card.score > 0).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-CN")).slice(0, 10).map((card) => { const result = { ...card }; delete result.keywords; return result; });
    return { knowledge_cards: matched, retrieval_summary: { query: input.query, mode: "hybrid", total_candidates: cards.length, matched_count: matched.length, sources: [...new Set(matched.map((card) => card.source))], document_retrieval: documentSearch.retrieval_summary } };
  }
  if (id === "task_lookup") {
    const [tasks, employees] = await Promise.all([readJson("onboarding_tasks.json"), readJson("employees.json")]);
    const employee = employees.find((item) => item.id === input.employee_id);
    if (!employee) return [];
    return tasks.filter((task) => (task.departments.includes("all") || task.departments.includes(employee.department)) && (task.positions.includes("all") || task.positions.includes(employee.position)) && stageRank[task.stage] <= stageRank[employee.stage] + 1).map((task) => ({ ...task, completed: employee.completed_tasks.includes(task.id) }));
  }
  if (id === "material_lookup") {
    const employee = (await readJson("employees.json")).find((item) => item.id === input.employee_id);
    if (!employee) return [];
    return (await readJson("onboarding_materials.json"))
      .filter((material) => material.applies_to.includes("all") || material.applies_to.includes(employee.department) || material.applies_to.includes(employee.position))
      .sort((a, b) => Number(b.required) - Number(a.required));
  }
  if (id === "contact_lookup") {
    const employee = (await readJson("employees.json")).find((item) => item.id === input.employee_id);
    return (await readJson("contacts.json")).filter((contact) => contact.scope.includes("all") || contact.scope.includes(employee?.department)).filter((contact) => !input.roles?.length || input.roles.some((role) => contact.role.includes(role))).map(({ id: contact_id, name, role, department, email, channel }) => ({ contact_id, name, role, department, email, channel }));
  }
  if (id === "policy_lookup") {
    const query = (input.query || "").toLowerCase();
    return (await readJson("policies.json")).filter((policy) => policy.active && (!query || policy.name.toLowerCase().includes(query) || policy.type.toLowerCase().includes(query) || policy.keywords.some((x) => query.includes(x.toLowerCase()) || x.toLowerCase().includes(query)))).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  }
  if (id === "training_lookup") {
    const employee = (await readJson("employees.json")).find((item) => item.id === input.employee_id);
    return (await readJson("trainings.json")).filter((item) => (item.departments.includes("all") || item.departments.includes(employee?.department)) && (item.positions.includes("all") || item.positions.includes(employee?.position)));
  }
  if (id === "task_status") {
    const employee = (await readJson("employees.json")).find((item) => item.id === input.employee_id);
    const tasks = await callLocalTool("task_lookup", input);
    const completed = tasks.filter((task) => task.completed);
    const pending = tasks.filter((task) => !task.completed);
    const onboardingDate = new Date(employee.onboarding_date).getTime();
    const enriched = pending.map((task) => ({ ...task, overdue: Date.now() > onboardingDate + task.deadline_days * 86400000, blocked_by: task.dependencies.filter((dep) => !employee.completed_tasks.includes(dep)) }));
    const rank = { P0: 0, P1: 1, P2: 2 };
    const ordered = enriched.sort((a, b) => rank[a.priority] - rank[b.priority] || a.deadline_days - b.deadline_days);
    return { employee_id: employee.id, onboarding_progress: tasks.length ? Number((completed.length / tasks.length).toFixed(2)) : 0, completed_task_count: completed.length, pending_task_count: pending.length, overdue_task_count: enriched.filter((x) => x.overdue).length, next_priority_tasks: ordered.filter((x) => x.blocked_by.length === 0).slice(0, 5).map((x) => x.name), dependency_blocked_tasks: ordered.filter((x) => x.blocked_by.length).map((x) => ({ task_id: x.id, blocked_by: x.blocked_by })), can_enter_next_stage: ordered.filter((x) => x.required && x.priority === "P0").length === 0 };
  }
  throw new Error(`未实现本地 Tool：${id}`);
}

export async function callToolDetailed(id, input) {
  const tool = await getTool(id, true);
  validateInput(tool, input);
  const started = Date.now();
  if (tool.type === "coze_workflow" || id.startsWith("run_coze_workflow_")) {
    const result = await runCozeWorkflowDetailed(input, tool);
    return { ...result, duration_ms: Date.now() - started, request: { workflow_id: tool.workflow_id || "7659350798523416603", parameters: input } };
  }
  if (tool.type === "http") return { ...(await callHttpTool(tool, input)), duration_ms: Date.now() - started };
  const output = await callLocalTool(id, input);
  return { output, duration_ms: Date.now() - started, trace: [{ index: 0, event: "Local", node_title: tool.name, content: "本地 JSON 查询完成", timestamp: new Date().toISOString() }], request: { source: tool.source, input } };
}

export async function callTool(id, input) {
  return (await callToolDetailed(id, input)).output;
}
