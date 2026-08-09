import http from "node:http";
import { readJson, writeJson, updateRecord } from "./json-store.mjs";
import { listSkills, getSkill, saveSkill, toggleSkill, skillVersions, skillVersion, restoreSkillVersion } from "./skill-registry.mjs";
import { listTools, getTool, saveTool, createTool, deleteTool, duplicateTool, callTool, callToolDetailed, toolVersions, toolVersion, restoreToolVersion } from "./tool-registry.mjs";
import { listPlans, getPlan, savePlan, getPlannerConfig, plannerVersions, plannerVersion, restorePlannerVersion } from "./plan-registry.mjs";
import { createPlan } from "./planner.mjs";
import { executePlan, testSkill } from "./executor.mjs";
import { appendLog, saveLog } from "./logger.mjs";
import { validatePlan } from "./plan-validator.mjs";
import { annotateRun, explainRun, getRun, listRuns } from "./run-service.mjs";
import { resumeCozeWorkflowDetailed } from "./coze-workflow.mjs";
import { exportConfiguration, importConfiguration } from "./config-service.mjs";
import { getLlmRuntimeConfig, testLlmConnection } from "./llm.mjs";
import { getLlmConfig, initializeLlmConfig, switchLlmProvider, testManagedLlmConnection, updateLlmConfig } from "./llm-config-service.mjs";
import {
  batchUpdateEvaluationCases,
  createBadCase,
  createEvaluationCase,
  deleteEvaluationCase,
  duplicateEvaluationCase,
  evaluationOverview,
  getEvaluationCase,
  listEvaluationCases,
  listEvaluationRuns,
  promoteFailures,
  runEvaluation,
  runEvaluationCase,
  updateEvaluationCase,
} from "./evaluation.mjs";
import { getAnalytics } from "./analytics.mjs";
import { assessSensitiveRequest, assertSelfAccess, sanitizeForStorage } from "./privacy.mjs";
import { createKnowledgeDocument, deleteKnowledgeDocument, documentStats, knowledgeDocumentChunks, listKnowledgeDocuments, publishKnowledgeDocument, reindexKnowledgeDocument, saveKnowledgeDocument } from "./knowledge-service.mjs";
import { ingestKnowledgeFile, listKnowledgeImportJobs } from "./knowledge-ingestion.mjs";
import { ensureKnowledgeIndex, knowledgeRagStats, searchKnowledgeDocuments } from "./knowledge-rag.mjs";
import { aggregateTokenUsage } from "./token-usage.mjs";
import { getTokenMonitorConfig, updateTokenMonitorConfig } from "./token-monitor-service.mjs";
import { reloadRuntimeSecrets } from "./runtime-env.mjs";

const port = Number(process.env.API_PORT || 8787);
await initializeLlmConfig();
await ensureKnowledgeIndex();
const send = (res, status, data, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", ...headers }); res.end(JSON.stringify(data)); };
const sendData = (res, status, data) => send(res, status, { ok: true, data });
const body = async (req) => {
  const parts = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 30 * 1024 * 1024) throw Object.assign(new Error("请求内容不能超过 30MB"), { code: "REQUEST_TOO_LARGE" });
    parts.push(chunk);
  }
  return parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {};
};
const id = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

async function prepend(file, entry, limit = 100) {
  const rows = await readJson(file);
  rows.unshift(sanitizeForStorage(entry));
  await writeJson(file, rows.slice(0, limit));
  return entry;
}

async function createHandoffRecord(input) {
  const record = {
    id: id("HANDOFF"),
    execution_id: input.execution_id || null,
    conversation_id: input.conversation_id || null,
    employee_id: input.employee_id,
    question: String(input.question || "").trim(),
    summary: String(input.summary || "员工请求人工协助").trim(),
    reason: String(input.reason || "用户主动申请转人工").trim(),
    risk_level: input.risk_level || "medium",
    assigned_to: input.assigned_to || "HR 对接人",
    status: "open",
    source: input.source || "manual",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return prepend("handoffs.json", record, 200);
}

async function executeAgent(input, options = {}) {
  if (!input.employee_id || !input.question?.trim()) throw new Error("employee_id 和 question 为必填项");
  const started = Date.now();
  const createdAt = new Date().toISOString();
  const runId = id("RUN");
  const emit = (event, data) => { if (typeof options.onEvent === "function") options.onEvent(event, sanitizeForStorage(data)); };
  assertSelfAccess(input.actor_employee_id || input.employee_id, input.employee_id);
  const conversations = await readJson("conversations.json");
  let conversation = input.conversation_id ? conversations.find((item) => item.id === input.conversation_id) : null;
  if (input.conversation_id && !conversation) throw new Error("多轮会话不存在或已被清理");
  if (conversation) assertSelfAccess(input.employee_id, conversation.employee_id);
  if (!conversation) {
    conversation = { id: id("CONV"), employee_id: input.employee_id, name: input.question.trim().slice(0, 24), messages: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    conversations.unshift(conversation);
  }
  const runtime = getLlmRuntimeConfig();
  let execution = {
    id: runId,
    question: input.question,
    source: options.source || input.source || "workbench",
    employee_id: input.employee_id,
    conversation_id: conversation.id,
    created_at: createdAt,
    updated_at: createdAt,
    status: "running",
    final_reply: null,
    plan: null,
    plan_validation: null,
    steps: [],
    evidence: [],
    risk_review: null,
    duration_ms: 0,
    error: null,
    mode: runtime.mode,
    provider: runtime.provider,
    model: runtime.model,
    skill_versions: {},
    tool_versions: {},
    retry_of: input.retry_of || null,
    handoff: null,
    annotations: [],
    token_usage: null,
  };
  await appendLog(execution);
  emit("run.started", { run_id: runId, conversation_id: conversation.id, source: execution.source, created_at: createdAt });
  const suppliedHistory = Array.isArray(input.conversation_history) ? input.conversation_history.slice(-8) : [];
  const conversationContext = suppliedHistory.length ? suppliedHistory : conversation.messages.slice(-8);
  const previousUserMessage = [...conversationContext].reverse().find((message) => message.role === "user")?.content;
  const planningQuestion = previousUserMessage ? `${input.question}\n会话上下文：${previousUserMessage}` : input.question;
  try {
    const plan = await createPlan(planningQuestion, input.plan_id);
    execution.plan = plan;
    emit("plan.created", { run_id: runId, plan });
    const [skills, tools] = await Promise.all([listSkills(), listTools()]);
    const validation = validatePlan(plan, { skills, tools, question: planningQuestion });
    execution.plan_validation = validation;
    emit("plan.validated", { run_id: runId, validation });
    if (!validation.valid) {
      const message = validation.errors.map((item) => item.message).join("；");
      execution = { ...execution, status: "blocked", final_reply: `本次运行未通过 Plan 校验：${message}。请启用必需能力后重试，或转交人工处理。`, updated_at: new Date().toISOString(), duration_ms: Date.now() - started, error: { code: "PLAN_VALIDATION_FAILED", message, details: validation.errors }, token_usage: aggregateTokenUsage([plan.token_usage].filter(Boolean)) };
      const handoff = await createHandoffRecord({ execution_id: runId, conversation_id: conversation.id, employee_id: input.employee_id, question: input.question, summary: "Plan 校验未通过，系统已阻断运行。", reason: message, risk_level: plan.risk_assessment?.level || "medium", assigned_to: "平台管理员或 HR 对接人", source: "plan_validation" });
      execution.handoff = { id: handoff.id, status: handoff.status, assigned_to: handoff.assigned_to };
      await saveLog(execution);
      emit("run.failed", { run_id: runId, status: execution.status, error: execution.error });
      return execution;
    }
    const result = await executePlan(validation.validated_plan, { ...input, question: input.question, conversation_context: conversationContext, onEvent: emit });
    const userMessageId = id("MSG");
    const responseMessageId = id("MSG");
    execution = {
      ...execution,
      response_message_id: responseMessageId,
      employee: result.employee,
      plan: validation.validated_plan,
      steps: result.steps,
      final_reply: result.final_reply,
      evidence: result.evidence,
      risk_review: result.risk_review,
      mode: result.mode || runtime.mode,
      provider: result.provider || runtime.provider,
      model: result.model || runtime.model,
      skill_versions: result.skill_versions || {},
      tool_versions: result.tool_versions || {},
      token_usage: aggregateTokenUsage([validation.validated_plan?.token_usage, result.token_usage].filter(Boolean)),
      status: result.status || "success",
      updated_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
    };
    await saveLog(execution);
    conversation.messages.push({ id: userMessageId, role: "user", content: input.question, created_at: execution.created_at }, { id: responseMessageId, execution_id: execution.id, role: "assistant", content: result.final_reply, evidence: result.evidence, risk_level: result.risk_review.risk_level, created_at: new Date().toISOString() });
    conversation.messages = conversation.messages.slice(-20);
    conversation.updated_at = new Date().toISOString();
    await writeJson("conversations.json", conversations.slice(0, 100).map(sanitizeForStorage));
    const securityAssessment = assessSensitiveRequest(input.question);
    if (["high", "critical"].includes(securityAssessment.level)) await prepend("security_events.json", { id: id("SEC"), execution_id: execution.id, conversation_id: conversation.id, employee_id: input.employee_id, category: securityAssessment.category, action: securityAssessment.action, reason: securityAssessment.reason, risk_level: securityAssessment.level, created_at: new Date().toISOString() }, 500);
    if (["high", "critical"].includes(result.risk_review.risk_level)) {
      const assignedTo = /合同|争议|仲裁|离职|辞职|裁员|补偿/.test(input.question) ? "HR 与法务" : /账号|VPN|权限|门禁/.test(input.question) ? "IT 或行政" : "HR 对接人";
      const handoff = await createHandoffRecord({ execution_id: execution.id, conversation_id: conversation.id, employee_id: input.employee_id, question: input.question, summary: `系统检测到 ${result.risk_review.risk_level} 风险，需要有权限人员确认。`, reason: result.risk_review.suggestions?.[0] || "涉及个人敏感信息或个案判断", risk_level: result.risk_review.risk_level, assigned_to: assignedTo, source: "automatic_risk_review" });
      execution.handoff = { id: handoff.id, status: handoff.status, assigned_to: handoff.assigned_to };
      await saveLog(execution);
    }
    emit("risk.completed", { run_id: runId, risk_review: execution.risk_review });
    emit("run.completed", { run_id: runId, status: execution.status, final_reply: execution.final_reply, duration_ms: execution.duration_ms });
    return execution;
  } catch (error) {
    execution = {
      ...execution,
      status: "error",
      steps: error.partial_steps || execution.steps,
      mode: error.mode || execution.mode,
      provider: error.provider || execution.provider,
      model: error.model || execution.model,
      skill_versions: error.skill_versions || execution.skill_versions,
      tool_versions: error.tool_versions || execution.tool_versions,
      token_usage: aggregateTokenUsage([
        execution.plan?.token_usage,
        ...(error.partial_steps || execution.steps || []).map((step) => step.token_usage),
        error.token_usage,
      ].filter(Boolean)),
      updated_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      error: { code: error.code || "AGENT_RUN_FAILED", message: error.message, details: error.details || null },
    };
    await saveLog(execution);
    emit("run.failed", { run_id: runId, status: execution.status, error: execution.error });
    error.run_id = runId;
    throw error;
  }
}

async function demoBootstrap(employeeId = "E001") {
  const [employee, materials] = await Promise.all([
    callTool("employee_lookup", { employee_id: employeeId }),
    callTool("material_lookup", { employee_id: employeeId, query: "入职材料" }),
  ]);
  const requiredMaterials = materials.filter((item) => item.required).slice(0, 5);
  const optionalMaterials = materials.filter((item) => !item.required).slice(0, 3);
  const materialLines = [
    `${employee.name}，你好！根据当前入职资料，你需要优先准备：`,
    ...requiredMaterials.map((item) => `• ${item.name}：${item.note}`),
  ];
  if (optionalMaterials.length) materialLines.push(`另外请按通知确认：${optionalMaterials.map((item) => item.name).join("、")}。`);
  materialLines.push("身份证、银行卡等敏感资料请只通过 HR 指定渠道提交，最终以录用通知和 HR 正式通知为准。");
  return {
    employee,
    quick_questions: ["需要准备什么入职材料？", "我的直属领导是谁？", "公司的福利制度有哪些？"],
    sample_messages: [
      { id: "sample-user-materials", role: "user", content: "需要准备什么入职材料？" },
      { id: "sample-ai-materials", role: "assistant", content: materialLines.join("\n") },
      { id: "sample-user-manager", role: "user", content: "我的直属领导是谁？" },
      { id: "sample-ai-manager", role: "assistant", content: `${employee.name}，你的直属领导是${employee.manager}。如组织关系刚有调整，请以企业通讯录中的最新信息为准。` },
    ],
  };
}

async function saveSession(tool, input, detailed, testId) {
  if (!detailed.interrupt) return null;
  const session = {
    id: id("COZE"),
    tool_id: tool.id,
    workflow_id: detailed.interrupt.workflow_id || tool.workflow_id,
    event_id: detailed.interrupt.event_id,
    interrupt_type: detailed.interrupt.interrupt_type,
    question: detailed.interrupt.question,
    node_title: detailed.interrupt.node_title,
    status: "waiting_input",
    attempts: 0,
    input,
    trace: detailed.trace || [],
    test_id: testId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await prepend("coze_sessions.json", session, 100);
  return session;
}

async function runToolTest(tool, input, rerunOf = null) {
  const testId = id("TEST");
  const createdAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const detailed = await callToolDetailed(tool.id, input);
    const session = await saveSession(tool, input, detailed, testId);
    const result = { mode: detailed.mock ? "mock" : tool.type === "local" ? "local" : "live", output: detailed.output, trace: detailed.trace || [], request: detailed.request || { input }, duration_ms: detailed.duration_ms || 0, interrupt_session: session };
    const record = { id: testId, tool_id: tool.id, tool_name: tool.name, created_at: createdAt, status: session ? "needs_input" : "success", input, output: detailed.output, request: result.request, trace: result.trace, duration_ms: result.duration_ms, rerun_of: rerunOf };
    await prepend("tool_test_logs.json", record, 200);
    await saveTool(tool.id, { last_test: { input, output: result, tested_at: createdAt, test_id: testId } });
    return result;
  } catch (error) {
    const record = { id: testId, tool_id: tool.id, tool_name: tool.name, created_at: createdAt, status: "failed", input, output: null, error: error.message, request: { input }, trace: [], duration_ms: Date.now() - startedAt, rerun_of: rerunOf };
    await prepend("tool_test_logs.json", record, 200);
    error.test_id = testId;
    throw error;
  }
}

async function bootstrap() {
  const [employees, skills, tools, plans, logs, toolTests, cozeSessions, conversations, handoffs, evaluationCases, evaluationRuns, accessPolicies, analytics, knowledgeDocuments, knowledgeImportJobs, knowledgeRuntime, conversationFeedback, securityEvents] = await Promise.all([readJson("employees.json"), listSkills(), listTools(), listPlans(), readJson("execution_logs.json"), readJson("tool_test_logs.json"), readJson("coze_sessions.json"), readJson("conversations.json"), readJson("handoffs.json"), listEvaluationCases(), readJson("evaluation_runs.json"), readJson("access_policies.json"), getAnalytics(), listKnowledgeDocuments(), listKnowledgeImportJobs(), knowledgeRagStats(), readJson("conversation_feedback.json"), readJson("security_events.json")]);
  const llm = getLlmRuntimeConfig();
  const runtimeSkills = skills.map((skill) => ({ ...skill, effective_model: llm.model, model_source: llm.model_source }));
  return { employees, skills: runtimeSkills, tools: tools.map(publicTool), plans, logs, tool_tests: toolTests, coze_sessions: cozeSessions, conversations, conversation_feedback: conversationFeedback, handoffs, knowledge_documents: knowledgeDocuments, knowledge_stats: documentStats(knowledgeDocuments), knowledge_import_jobs: knowledgeImportJobs, knowledge_runtime: knowledgeRuntime, security_events: securityEvents, evaluation_cases: evaluationCases.filter((item) => !item.isBadCase), bad_case_evaluation_cases: evaluationCases.filter((item) => item.isBadCase), evaluation_runs: evaluationRuns, access_policies: accessPolicies, analytics, llm, api_base: `http://127.0.0.1:${port}/api` };
}

function publicTool(tool) {
  return {
    ...tool,
    headers: Object.fromEntries(Object.keys(tool.headers || {}).map((key) => [key, "***configured***"])),
    auth_configured: Boolean(tool.auth_env_var && process.env[tool.auth_env_var]?.trim()),
  };
}

async function managementSkills() {
  const [skills, tools, plans] = await Promise.all([listSkills(), listTools(), listPlans()]);
  return skills.map((skill) => {
    const runtime = getLlmRuntimeConfig(skill);
    return {
      ...skill,
      model_strategy: skill.model_strategy || "global",
      dependent_tools: skill.dependent_tools || [],
      effective_model: runtime.model,
      model_source: runtime.model_source,
      referenced_by_plans: plans.filter((plan) => plan.nodes.some((node) => node.capability_id === skill.id)).map((plan) => plan.id),
      available_tools: tools.map((tool) => ({ id: tool.id, name: tool.name, enabled: tool.enabled })),
    };
  });
}

async function managementTools() {
  const [tools, skills, plans, tests] = await Promise.all([listTools(), listSkills(), listPlans(), readJson("tool_test_logs.json")]);
  return tools.map((tool) => publicTool({
    ...tool,
    version: tool.version || "1.0.0",
    referenced_by_skills: skills.filter((skill) => (skill.dependent_tools || []).includes(tool.id)).map((skill) => skill.id),
    referenced_by_plans: plans.filter((plan) => plan.nodes.some((node) => node.capability_id === tool.id)).map((plan) => plan.id),
    latest_test: tests.find((test) => test.tool_id === tool.id) || null,
  }));
}

async function previewPlanner(payload) {
  const question = String(payload.question || "").trim();
  if (!question) throw Object.assign(new Error("请输入 Planner 测试问题"), { code: "PLANNER_QUESTION_REQUIRED" });
  const [skills, tools] = await Promise.all([listSkills(), listTools()]);
  const disabledSkills = Array.isArray(payload.disabled_skills) ? payload.disabled_skills : [];
  const disabledTools = Array.isArray(payload.disabled_tools) ? payload.disabled_tools : [];
  const plan = await createPlan(question, payload.plan_id || "default_onboarding_plan", { forceRules: Boolean(payload.force_rules), conversationHistory: payload.conversation_history || [], disabledSkills, disabledTools });
  const effectiveSkills = skills.map((item) => disabledSkills.includes(item.id) ? { ...item, enabled: false } : item);
  const effectiveTools = tools.map((item) => disabledTools.includes(item.id) ? { ...item, enabled: false } : item);
  return { plan, validation: validatePlan(plan, { skills: effectiveSkills, tools: effectiveTools, question, mandatoryCapabilities: plan.mandatory_capabilities }) };
}

async function streamAgentRun(req, res) {
  const payload = await body(req);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const writeEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    await executeAgent(payload, { source: payload.source || "workbench", onEvent: writeEvent });
  } catch (error) {
    writeEvent("error", { run_id: error.run_id || null, code: error.code || "AGENT_RUN_FAILED", message: error.message, details: error.details || null });
  } finally { res.end(); }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      const llm = getLlmRuntimeConfig();
      return send(res, 200, { ok: true, mode: llm.mode, llm_mode: llm.mode, llm_provider: llm.provider, llm_model: llm.model, llm_model_source: llm.model_source, planner_mode: (process.env.PLANNER_MODE || "hybrid").toLowerCase(), llm_endpoint: llm.endpoint, llm_configured: llm.configured, coze_mode: process.env.COZE_API_TOKEN ? "live" : (process.env.COZE_MOCK_MODE || "false").toLowerCase() === "true" ? "mock" : "unconfigured", version: "1.6.0" });
    }
    if (req.method === "POST" && url.pathname === "/api/system/reload-env") {
      const result = reloadRuntimeSecrets();
      const llm = getLlmRuntimeConfig();
      return send(res, 200, { ok: true, ...result, llm_configured: llm.configured, missing: llm.missing });
    }
    if (req.method === "GET" && url.pathname === "/api/bootstrap") return send(res, 200, await bootstrap());
    if (req.method === "GET" && url.pathname === "/api/demo/bootstrap") return send(res, 200, await demoBootstrap(url.searchParams.get("employee_id") || "E001"));
    if (req.method === "GET" && url.pathname === "/api/analytics") return send(res, 200, await getAnalytics({ days: Number(url.searchParams.get("days") || 30), source: url.searchParams.get("source") || "all" }));
    if (req.method === "GET" && url.pathname === "/api/token-monitor/config") return send(res, 200, await getTokenMonitorConfig());
    if (req.method === "PUT" && url.pathname === "/api/token-monitor/config") return send(res, 200, await updateTokenMonitorConfig(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/llm/test") return send(res, 200, await testLlmConnection());
    if (req.method === "GET" && url.pathname === "/api/skills") return sendData(res, 200, await managementSkills());
    if (req.method === "GET" && url.pathname === "/api/tools") return sendData(res, 200, await managementTools());
    if (req.method === "GET" && url.pathname === "/api/planner") return sendData(res, 200, { planner: await getPlannerConfig(), skills: await listSkills(), tools: (await listTools()).map(publicTool), versions: await plannerVersions() });
    if (req.method === "PUT" && url.pathname === "/api/planner") return sendData(res, 200, await savePlan("default_onboarding_plan", await body(req)));
    if (req.method === "POST" && url.pathname === "/api/planner/preview") return sendData(res, 200, await previewPlanner(await body(req)));
    if (req.method === "GET" && url.pathname === "/api/planner/versions") return sendData(res, 200, await plannerVersions());
    if (req.method === "GET" && url.pathname === "/api/llm-config") return sendData(res, 200, await getLlmConfig());
    if (req.method === "PUT" && url.pathname === "/api/llm-config") return sendData(res, 200, await updateLlmConfig(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/llm-config/switch") return sendData(res, 200, await switchLlmProvider(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/llm-config/test") return sendData(res, 200, await testManagedLlmConnection());

    const plannerVersionRestore = url.pathname.match(/^\/api\/planner\/versions\/([^/]+)\/restore$/);
    const plannerVersionMatch = url.pathname.match(/^\/api\/planner\/versions\/([^/]+)$/);
    if (req.method === "GET" && plannerVersionMatch) return sendData(res, 200, await plannerVersion("default_onboarding_plan", plannerVersionMatch[1]));
    if (req.method === "POST" && plannerVersionRestore) return sendData(res, 200, await restorePlannerVersion("default_onboarding_plan", plannerVersionRestore[1], (await body(req)).change_note));

    const skillVersionRestore = url.pathname.match(/^\/api\/skills\/([^/]+)\/versions\/([^/]+)\/restore$/);
    const skillVersionMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/versions\/([^/]+)$/);
    const skillVersionsMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/versions$/);
    const skillToggleMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/toggle$/);
    const skillDetailMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (req.method === "GET" && skillVersionsMatch) return sendData(res, 200, await skillVersions(skillVersionsMatch[1]));
    if (req.method === "GET" && skillVersionMatch) return sendData(res, 200, await skillVersion(skillVersionMatch[1], skillVersionMatch[2]));
    if (req.method === "POST" && skillVersionRestore) return sendData(res, 200, await restoreSkillVersion(skillVersionRestore[1], skillVersionRestore[2], (await body(req)).change_note));
    if (req.method === "POST" && skillToggleMatch) { const payload = await body(req); return sendData(res, 200, await toggleSkill(skillToggleMatch[1], payload.enabled, payload.change_note)); }
    if (req.method === "GET" && skillDetailMatch) return sendData(res, 200, await getSkill(skillDetailMatch[1], false));

    const toolVersionRestore = url.pathname.match(/^\/api\/tools\/([^/]+)\/versions\/([^/]+)\/restore$/);
    const toolVersionMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/versions\/([^/]+)$/);
    const toolVersionsMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/versions$/);
    const toolTestsMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/tests$/);
    const toolToggleMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/toggle$/);
    const toolDetailMatch = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
    if (req.method === "GET" && toolVersionsMatch) return sendData(res, 200, await toolVersions(toolVersionsMatch[1]));
    if (req.method === "GET" && toolVersionMatch) return sendData(res, 200, await toolVersion(toolVersionMatch[1], toolVersionMatch[2]));
    if (req.method === "POST" && toolVersionRestore) return sendData(res, 200, await restoreToolVersion(toolVersionRestore[1], toolVersionRestore[2], (await body(req)).change_note));
    if (req.method === "GET" && toolTestsMatch) return sendData(res, 200, (await readJson("tool_test_logs.json")).filter((item) => item.tool_id === toolTestsMatch[1]));
    if (req.method === "POST" && toolToggleMatch) { const payload = await body(req); return sendData(res, 200, await saveTool(toolToggleMatch[1], { enabled: payload.enabled, change_note: payload.change_note })); }
    if (req.method === "GET" && toolDetailMatch) return sendData(res, 200, publicTool(await getTool(toolDetailMatch[1], false)));
    if (req.method === "GET" && url.pathname === "/api/eval") return send(res, 200, await evaluationOverview({ skills: await listSkills(), tools: await listTools() }));
    if (req.method === "GET" && url.pathname === "/api/eval/cases") return send(res, 200, await listEvaluationCases({ suite: url.searchParams.get("suite") || "all" }));
    if (req.method === "POST" && url.pathname === "/api/eval/cases") return send(res, 201, await createEvaluationCase(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/eval/cases/from-run") {
      const payload = await body(req);
      const source = await getRun(payload.runId || payload.run_id);
      return send(res, 201, await createEvaluationCase({
        ...payload,
        question: payload.question || source.question,
        employeeId: payload.employeeId || source.employee_id || source.employee?.id,
        sourceRunId: source.id,
        inputRiskLevel: payload.inputRiskLevel || source.risk_review?.risk_level || "low",
        expectedRiskResult: payload.expectedRiskResult || { inputRiskLevel: source.risk_review?.risk_level || "low", replyShouldBeSafe: true, replyAllowed: true, handoffRequired: Boolean(source.handoff) },
        requiredCapabilities: payload.requiredCapabilities || source.steps?.map((step) => step.capability_id) || [],
        expectedEvidence: payload.expectedEvidence || { required: Boolean(source.evidence?.length), minCount: source.evidence?.length ? 1 : 0 },
      }));
    }
    if (req.method === "POST" && url.pathname === "/api/eval/cases/from-failure") {
      const payload = await body(req);
      const sourceRun = (await listEvaluationRuns()).find((item) => item.id === payload.evalRunId || item.runId === payload.runId);
      if (!sourceRun) throw Object.assign(new Error("评测运行不存在"), { code: "EVAL_RUN_NOT_FOUND" });
      const sourceCase = await getEvaluationCase(sourceRun.caseId);
      return send(res, 201, await createEvaluationCase({ ...sourceCase, id: undefined, name: `${sourceCase.name}（失败回流）`, isBadCase: true, sourceRunId: sourceRun.runId, failure_mode: sourceRun.scoreResult?.reason || "评测失败回流" }));
    }
    if (req.method === "POST" && url.pathname === "/api/eval/cases/batch-update") return send(res, 200, await batchUpdateEvaluationCases(await body(req)));
    if (req.method === "GET" && url.pathname === "/api/eval/runs") return send(res, 200, await listEvaluationRuns({ caseId: url.searchParams.get("caseId") || undefined }));
    if (req.method === "GET" && url.pathname === "/api/eval/compare") {
      const rows = await readJson("evaluation_runs.json");
      const left = rows.find((item) => item.id === url.searchParams.get("left"));
      const right = rows.find((item) => item.id === url.searchParams.get("right"));
      if (!left || !right) throw Object.assign(new Error("请选择两个有效评测批次"), { code: "EVAL_COMPARE_BATCH_REQUIRED" });
      return send(res, 200, {
        left,
        right,
        delta: {
          pass_rate: Number((right.pass_rate - left.pass_rate).toFixed(3)),
          route_accuracy: Number((right.route_accuracy - left.route_accuracy).toFixed(3)),
          risk_accuracy: Number((right.risk_accuracy - left.risk_accuracy).toFixed(3)),
          availability_rate: Number(((right.availability_rate || 0) - (left.availability_rate || 0)).toFixed(3)),
          duration_ms: (right.duration_ms || 0) - (left.duration_ms || 0),
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/eval/batches") return send(res, 200, await readJson("evaluation_runs.json"));
    if (req.method === "POST" && url.pathname === "/api/eval/batches") return send(res, 201, await runEvaluation(await body(req), { agentRunner: executeAgent }));
    const evalBatchRetry = url.pathname.match(/^\/api\/eval\/batches\/([^/]+)\/retry$/);
    const evalBatchStop = url.pathname.match(/^\/api\/eval\/batches\/([^/]+)\/stop$/);
    const evalBatchMatch = url.pathname.match(/^\/api\/eval\/batches\/([^/]+)$/);
    if (req.method === "GET" && evalBatchMatch) {
      const batch = (await readJson("evaluation_runs.json")).find((item) => item.id === evalBatchMatch[1]);
      if (!batch) throw Object.assign(new Error("评测批次不存在"), { code: "EVAL_BATCH_NOT_FOUND" });
      return send(res, 200, batch);
    }
    if (req.method === "POST" && evalBatchRetry) {
      const batch = (await readJson("evaluation_runs.json")).find((item) => item.id === evalBatchRetry[1]);
      if (!batch) throw Object.assign(new Error("评测批次不存在"), { code: "EVAL_BATCH_NOT_FOUND" });
      const payload = await body(req);
      const statuses = Array.isArray(payload.statuses) && payload.statuses.length ? payload.statuses : ["FAIL", "ERROR"];
      const caseIds = (batch.eval_runs || []).filter((item) => statuses.includes(item.status)).map((item) => item.caseId);
      if (!caseIds.length) throw Object.assign(new Error("该批次没有符合重试条件的用例"), { code: "EVAL_RETRY_EMPTY" });
      return send(res, 201, await runEvaluation({ suite: "all", caseIds, limit: caseIds.length, name: `${batch.name || batch.id} · 重试` }, { agentRunner: executeAgent }));
    }
    if (req.method === "POST" && evalBatchStop) {
      const rows = await readJson("evaluation_runs.json");
      const index = rows.findIndex((item) => item.id === evalBatchStop[1]);
      if (index < 0) throw Object.assign(new Error("评测批次不存在"), { code: "EVAL_BATCH_NOT_FOUND" });
      rows[index] = { ...rows[index], status: rows[index].status === "running" ? "stopped" : rows[index].status, stop_requested_at: new Date().toISOString() };
      await writeJson("evaluation_runs.json", rows);
      return send(res, 200, rows[index]);
    }
    const evalCaseRun = url.pathname.match(/^\/api\/eval\/cases\/([^/]+)\/run$/);
    const evalCaseDuplicate = url.pathname.match(/^\/api\/eval\/cases\/([^/]+)\/duplicate$/);
    const evalCaseMatch = url.pathname.match(/^\/api\/eval\/cases\/([^/]+)$/);
    if (req.method === "POST" && evalCaseRun) return send(res, 200, await runEvaluationCase(evalCaseRun[1], executeAgent, await body(req)));
    if (req.method === "POST" && evalCaseDuplicate) return send(res, 201, await duplicateEvaluationCase(evalCaseDuplicate[1]));
    if (req.method === "GET" && evalCaseMatch) return send(res, 200, await getEvaluationCase(evalCaseMatch[1]));
    if (req.method === "PATCH" && evalCaseMatch) return send(res, 200, await updateEvaluationCase(evalCaseMatch[1], await body(req)));
    if (req.method === "DELETE" && evalCaseMatch) return send(res, 200, await deleteEvaluationCase(evalCaseMatch[1]));
    if (req.method === "POST" && url.pathname === "/api/evaluations/run") return send(res, 200, await runEvaluation(await body(req), { agentRunner: executeAgent }));
    if (req.method === "POST" && url.pathname === "/api/evaluations/cases") return send(res, 201, await createBadCase(await body(req)));
    const evaluationPromote = url.pathname.match(/^\/api\/evaluations\/runs\/([^/]+)\/promote-failures$/);
    if (req.method === "POST" && evaluationPromote) return send(res, 200, await promoteFailures(evaluationPromote[1]));
    if (req.method === "POST" && url.pathname === "/api/knowledge-documents") return send(res, 201, await createKnowledgeDocument(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/knowledge-files") return send(res, 201, await ingestKnowledgeFile(await body(req)));
    if (req.method === "GET" && url.pathname === "/api/knowledge-import-jobs") return send(res, 200, await listKnowledgeImportJobs());
    if (req.method === "GET" && url.pathname === "/api/knowledge-runtime") return send(res, 200, await knowledgeRagStats());
    if (req.method === "POST" && url.pathname === "/api/knowledge-search/preview") return send(res, 200, await searchKnowledgeDocuments(await body(req)));
    if (req.method === "GET" && url.pathname === "/api/config/export") return send(res, 200, await exportConfiguration(), { "Content-Disposition": `attachment; filename="peopleflow-config-${new Date().toISOString().slice(0, 10)}.json"` });
    if (req.method === "POST" && url.pathname === "/api/config/import") return send(res, 200, await importConfiguration(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/agent/run") return streamAgentRun(req, res);
    if (req.method === "POST" && url.pathname === "/api/execute") return send(res, 200, await executeAgent(await body(req), { source: "workbench" }));
    if (req.method === "GET" && url.pathname === "/api/runs") return send(res, 200, await listRuns(url.searchParams));
    if (req.method === "POST" && url.pathname === "/api/explain") {
      const payload = await body(req);
      return send(res, 200, explainRun(await getRun(payload.run_id)));
    }
    if (req.method === "POST" && url.pathname === "/api/tools") return send(res, 201, await createTool(await body(req)));

    const runRetry = url.pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
    const runHandoff = url.pathname.match(/^\/api\/runs\/([^/]+)\/handoff$/);
    const runAnnotate = url.pathname.match(/^\/api\/runs\/([^/]+)\/annotate$/);
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) return send(res, 200, await getRun(runMatch[1]));
    if (req.method === "POST" && runRetry) {
      const previous = await getRun(runRetry[1]);
      return send(res, 200, await executeAgent({ employee_id: previous.employee_id || previous.employee?.id, actor_employee_id: previous.employee_id || previous.employee?.id, question: previous.question, plan_id: previous.plan?.id || previous.plan?.plan_id, retry_of: previous.id }, { source: "retry" }));
    }
    if (req.method === "POST" && runHandoff) {
      const run = await getRun(runHandoff[1]);
      const payload = await body(req);
      const handoff = await createHandoffRecord({ execution_id: run.id, conversation_id: run.conversation_id, employee_id: run.employee_id || run.employee?.id, question: run.question, summary: payload.summary || "运行记录已标记人工接管", reason: payload.reason || run.error?.message || "人工复核", assigned_to: payload.assigned_to || "HR 对接人", risk_level: payload.risk_level || run.risk_review?.risk_level || "medium", source: "manual_run" });
      run.handoff = { id: handoff.id, status: handoff.status, assigned_to: handoff.assigned_to };
      run.updated_at = new Date().toISOString();
      await saveLog(run);
      return send(res, 201, handoff);
    }
    if (req.method === "POST" && runAnnotate) return send(res, 200, await annotateRun(runAnnotate[1], await body(req)));

    const knowledgeDocumentMatch = url.pathname.match(/^\/api\/knowledge-documents\/([^/]+)$/);
    const knowledgeDocumentPublish = url.pathname.match(/^\/api\/knowledge-documents\/([^/]+)\/publish$/);
    const knowledgeDocumentReindex = url.pathname.match(/^\/api\/knowledge-documents\/([^/]+)\/reindex$/);
    const knowledgeDocumentChunksMatch = url.pathname.match(/^\/api\/knowledge-documents\/([^/]+)\/chunks$/);
    if (req.method === "POST" && knowledgeDocumentPublish) return send(res, 200, await publishKnowledgeDocument(knowledgeDocumentPublish[1], await body(req)));
    if (req.method === "POST" && knowledgeDocumentReindex) return send(res, 200, await reindexKnowledgeDocument(knowledgeDocumentReindex[1]));
    if (req.method === "GET" && knowledgeDocumentChunksMatch) return send(res, 200, await knowledgeDocumentChunks(knowledgeDocumentChunksMatch[1]));
    if (req.method === "PUT" && knowledgeDocumentMatch) return send(res, 200, await saveKnowledgeDocument(knowledgeDocumentMatch[1], await body(req)));
    if (req.method === "DELETE" && knowledgeDocumentMatch) return send(res, 200, await deleteKnowledgeDocument(knowledgeDocumentMatch[1]));

    const conversationMessage = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    const conversationFeedback = url.pathname.match(/^\/api\/conversations\/([^/]+)\/feedback$/);
    const conversationHandoff = url.pathname.match(/^\/api\/conversations\/([^/]+)\/handoff$/);
    const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (req.method === "POST" && conversationMessage) {
      const payload = await body(req);
      const conversation = (await readJson("conversations.json")).find((item) => item.id === conversationMessage[1]);
      if (!conversation) throw new Error("多轮会话不存在");
      return send(res, 200, await executeAgent({ ...payload, employee_id: conversation.employee_id, actor_employee_id: payload.actor_employee_id || conversation.employee_id, conversation_id: conversation.id }, { source: "demo" }));
    }
    if (req.method === "POST" && conversationFeedback) {
      const payload = await body(req);
      const conversationRows = await readJson("conversations.json");
      const conversation = conversationRows.find((item) => item.id === conversationFeedback[1]);
      if (!conversation) throw new Error("多轮会话不存在");
      if (!["up", "down"].includes(payload.rating)) throw new Error("评价只能是 up 或 down");
      const indexedMessage = Number.isInteger(payload.message_index) ? conversation.messages[payload.message_index] : null;
      const targetMessage = payload.message_id ? conversation.messages.find((item) => item.id === payload.message_id && item.role === "assistant") : indexedMessage?.role === "assistant" ? indexedMessage : [...conversation.messages].reverse().find((item) => item.role === "assistant");
      if (!targetMessage) throw new Error("未找到可评价的助手回复");
      if (!targetMessage.id) { targetMessage.id = id("MSG"); await writeJson("conversations.json", conversationRows.map(sanitizeForStorage)); }
      const feedbackRows = await readJson("conversation_feedback.json");
      const existing = feedbackRows.find((item) => item.conversation_id === conversation.id && item.message_id === targetMessage.id);
      const record = sanitizeForStorage({ id: existing?.id || id("FDBK"), conversation_id: conversation.id, message_id: targetMessage.id, execution_id: targetMessage.execution_id || null, employee_id: conversation.employee_id, rating: payload.rating, tags: Array.isArray(payload.tags) ? payload.tags.map(String).slice(0, 8) : [], comment: String(payload.comment || "").slice(0, 500), created_at: existing?.created_at || new Date().toISOString(), updated_at: new Date().toISOString() });
      if (existing) Object.assign(existing, record); else feedbackRows.unshift(record);
      await writeJson("conversation_feedback.json", feedbackRows.slice(0, 1000));
      return send(res, 200, record);
    }
    if (req.method === "POST" && conversationHandoff) {
      const conversation = (await readJson("conversations.json")).find((item) => item.id === conversationHandoff[1]);
      if (!conversation) throw new Error("多轮会话不存在");
      const payload = await body(req);
      const latestQuestion = [...conversation.messages].reverse().find((item) => item.role === "user")?.content || conversation.name;
      return send(res, 201, await createHandoffRecord({ conversation_id: conversation.id, employee_id: conversation.employee_id, question: latestQuestion, summary: payload.summary || `员工就“${conversation.name}”申请人工协助`, reason: payload.reason || "员工主动申请转人工", assigned_to: payload.assigned_to || "HR 对接人", risk_level: payload.risk_level || "medium", source: "manual_conversation" }));
    }
    if (req.method === "PUT" && conversationMatch) {
      const patch = await body(req);
      return send(res, 200, await updateRecord("conversations.json", conversationMatch[1], { name: String(patch.name || "").trim().slice(0, 40) || "未命名会话", status: patch.status === "archived" ? "archived" : "active", updated_at: new Date().toISOString() }));
    }
    if (req.method === "DELETE" && conversationMatch) {
      const conversations = await readJson("conversations.json");
      if (!conversations.some((item) => item.id === conversationMatch[1])) throw new Error("多轮会话不存在");
      await writeJson("conversations.json", conversations.filter((item) => item.id !== conversationMatch[1]));
      const feedbackRows = await readJson("conversation_feedback.json");
      await writeJson("conversation_feedback.json", feedbackRows.filter((item) => item.conversation_id !== conversationMatch[1]));
      return send(res, 200, { id: conversationMatch[1], deleted: true });
    }

    const handoffMatch = url.pathname.match(/^\/api\/handoffs\/([^/]+)$/);
    if (req.method === "PUT" && handoffMatch) {
      const patch = await body(req);
      if (!['open', 'processing', 'resolved'].includes(patch.status)) throw new Error("无效的转接状态");
      return send(res, 200, await updateRecord("handoffs.json", handoffMatch[1], { status: patch.status, note: patch.note || "", updated_at: new Date().toISOString() }));
    }

    const executionRerun = url.pathname.match(/^\/api\/executions\/([^/]+)\/rerun$/);
    if (req.method === "POST" && executionRerun) {
      const previous = (await readJson("execution_logs.json")).find((item) => item.id === executionRerun[1]);
      if (!previous) throw new Error("执行记录不存在");
      return send(res, 200, await executeAgent({ employee_id: previous.employee_id || previous.employee?.id, question: previous.question, plan_id: previous.plan?.id, retry_of: previous.id }, { source: "retry" }));
    }

    const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
    const skillTestMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/test$/);
    if (req.method === "PUT" && skillMatch) return send(res, 200, await saveSkill(skillMatch[1], await body(req)));
    if (req.method === "POST" && skillTestMatch) {
      const skill = await getSkill(skillTestMatch[1], false);
      const payload = await body(req);
      const result = await testSkill(skill, payload.input || "");
      await saveSkill(skill.id, { last_test: { input: payload.input, output: result, tested_at: new Date().toISOString() } });
      return send(res, 200, result);
    }

    const planMatch = url.pathname.match(/^\/api\/plans\/([^/]+)$/);
    if (req.method === "GET" && planMatch) return send(res, 200, await getPlan(planMatch[1]));
    if (req.method === "PUT" && planMatch) return send(res, 200, await savePlan(planMatch[1], await body(req)));

    const toolDuplicate = url.pathname.match(/^\/api\/tools\/([^/]+)\/duplicate$/);
    const toolTestMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/test$/);
    const toolMatch = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
    if (req.method === "POST" && toolDuplicate) return send(res, 201, await duplicateTool(toolDuplicate[1]));
    if (req.method === "POST" && toolTestMatch) {
      const tool = await getTool(toolTestMatch[1], false);
      if (!tool.enabled) throw new Error(`Tool 已禁用：${tool.name}`);
      const payload = await body(req);
      return send(res, 200, await runToolTest(tool, payload.input && typeof payload.input === "object" ? payload.input : {}));
    }
    if (req.method === "PUT" && toolMatch) return send(res, 200, await saveTool(toolMatch[1], await body(req)));
    if (req.method === "DELETE" && toolMatch) {
      const plans = await listPlans();
      const nextPlans = plans.map((plan) => {
        const removed = new Set(plan.nodes.filter((node) => node.capability_id === toolMatch[1]).map((node) => node.id));
        return removed.size ? { ...plan, nodes: plan.nodes.filter((node) => !removed.has(node.id)).map((node) => ({ ...node, depends_on: node.depends_on.filter((dep) => !removed.has(dep)) })) } : plan;
      });
      if (JSON.stringify(nextPlans) !== JSON.stringify(plans)) await writeJson("plans.json", nextPlans);
      return send(res, 200, await deleteTool(toolMatch[1]));
    }

    const testRerun = url.pathname.match(/^\/api\/tool-tests\/([^/]+)\/rerun$/);
    if (req.method === "POST" && testRerun) {
      const previous = (await readJson("tool_test_logs.json")).find((item) => item.id === testRerun[1]);
      if (!previous) throw new Error("Tool 测试记录不存在");
      return send(res, 200, await runToolTest(await getTool(previous.tool_id, false), previous.input, previous.id));
    }

    const resumeMatch = url.pathname.match(/^\/api\/coze-sessions\/([^/]+)\/resume$/);
    if (req.method === "POST" && resumeMatch) {
      const sessions = await readJson("coze_sessions.json");
      const session = sessions.find((item) => item.id === resumeMatch[1]);
      if (!session) throw new Error("Coze 中断会话不存在");
      if (session.status !== "waiting_input") throw new Error(`会话当前状态不可恢复：${session.status}`);
      if (session.attempts >= 3) throw new Error("Coze 工作流最多恢复 3 次");
      const payload = await body(req);
      const tool = await getTool(session.tool_id, true);
      const detailed = await resumeCozeWorkflowDetailed(session, payload.resume_data, tool);
      const next = {
        ...session,
        event_id: detailed.interrupt?.event_id || session.event_id,
        interrupt_type: detailed.interrupt?.interrupt_type ?? session.interrupt_type,
        question: detailed.interrupt?.question || session.question,
        status: detailed.interrupt ? "waiting_input" : "completed",
        attempts: session.attempts + 1,
        output: detailed.output,
        trace: [...(session.trace || []), ...(detailed.trace || [])],
        updated_at: new Date().toISOString(),
      };
      await updateRecord("coze_sessions.json", session.id, next);
      await prepend("tool_test_logs.json", { id: id("TEST"), tool_id: tool.id, tool_name: tool.name, created_at: new Date().toISOString(), status: next.status === "completed" ? "success" : "needs_input", input: { resume_data: payload.resume_data }, output: detailed.output, trace: detailed.trace, duration_ms: detailed.duration_ms || 0, session_id: session.id }, 200);
      return send(res, 200, { mode: "live", output: detailed.output, trace: detailed.trace, interrupt_session: next.status === "waiting_input" ? next : null, session: next });
    }

    return send(res, 404, { error: "API 不存在" });
  } catch (error) {
    const payload = { code: error.code || "REQUEST_FAILED", message: error.message, details: error.details || {}, run_id: error.run_id || undefined, test_id: error.test_id || undefined };
    if (/^\/api\/(skills|tools|planner|llm-config)(?:\/|$)/.test(url.pathname)) return send(res, error.status || 400, { ok: false, error: payload });
    return send(res, error.status || 400, { error: error.message, code: payload.code, details: payload.details, run_id: payload.run_id, test_id: payload.test_id });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`PeopleFlow API: http://localhost:${port}/api`));
