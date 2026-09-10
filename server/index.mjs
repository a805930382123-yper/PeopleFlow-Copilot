import { readJson, updateJson, updateRecord } from "./json-store.mjs";
import { listSkills } from "./skill-registry.mjs";
import { listTools, getTool, saveTool, callTool, callToolDetailed } from "./tool-registry.mjs";
import { listPlans } from "./plan-registry.mjs";
import { createPlan } from "./planner.mjs";
import { executePlan } from "./executor.mjs";
import { appendLog, saveLog } from "./logger.mjs";
import { validatePlan } from "./plan-validator.mjs";
import { annotateRun, explainRun, getRun, listRuns } from "./run-service.mjs";
import { resumeCozeWorkflowDetailed } from "./coze-workflow.mjs";
import { exportConfiguration, importConfiguration } from "./config-service.mjs";
import { getLlmRuntimeConfig } from "./llm.mjs";
import { initializeLlmConfig } from "./llm-config-service.mjs";
import { listEvaluationCases } from "./evaluation.mjs";
import { getAnalytics } from "./analytics.mjs";
import { assessSensitiveRequest, assertSelfAccess, sanitizeForStorage } from "./privacy.mjs";
import { documentStats, listKnowledgeDocuments } from "./knowledge-service.mjs";
import { listKnowledgeImportJobs } from "./knowledge-ingestion.mjs";
import { ensureKnowledgeIndex, knowledgeRagStats } from "./knowledge-rag.mjs";
import { aggregateTokenUsage } from "./token-usage.mjs";
import { getRuntimeEnv } from "./runtime-env.mjs";
import { readRequestBody as body, send } from "./http.mjs";
import { handleSystemRoutes } from "./routes/system.mjs";
import { handleManagementRoutes } from "./routes/management.mjs";
import { handleKnowledgeRoutes } from "./routes/knowledge.mjs";
import { handleEvaluationRoutes } from "./routes/evaluation.mjs";

let initializationPromise;
export function initializeApi() {
  initializationPromise ||= Promise.all([initializeLlmConfig(), ensureKnowledgeIndex()]);
  return initializationPromise;
}
const id = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

async function prepend(file, entry, limit = 100) {
  const sanitized = sanitizeForStorage(entry);
  await updateJson(file, (rows) => [sanitized, ...rows].slice(0, limit), []);
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
    const userMessage = { id: userMessageId, role: "user", content: input.question, created_at: execution.created_at };
    const assistantMessage = { id: responseMessageId, execution_id: execution.id, role: "assistant", content: result.final_reply, evidence: result.evidence, risk_level: result.risk_review.risk_level, created_at: new Date().toISOString() };
    await updateJson("conversations.json", (rows) => {
      let current = rows.find((item) => item.id === conversation.id);
      if (!current) {
        current = { ...conversation, messages: [] };
        rows.unshift(current);
      }
      current.messages = [...(current.messages || []), userMessage, assistantMessage].slice(-20);
      current.updated_at = new Date().toISOString();
      return rows.slice(0, 100).map(sanitizeForStorage);
    }, []);
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
  const loaders = {
    employees: () => readJson("employees.json"),
    skills: () => listSkills(),
    tools: () => listTools(),
    plans: () => listPlans(),
    logs: () => readJson("execution_logs.json"),
    toolTests: () => readJson("tool_test_logs.json"),
    cozeSessions: () => readJson("coze_sessions.json"),
    conversations: () => readJson("conversations.json"),
    handoffs: () => readJson("handoffs.json"),
    evaluationCases: () => listEvaluationCases(),
    evaluationRuns: () => readJson("evaluation_runs.json"),
    accessPolicies: () => readJson("access_policies.json"),
    analytics: () => getAnalytics(),
    knowledgeDocuments: () => listKnowledgeDocuments(),
    knowledgeImportJobs: () => listKnowledgeImportJobs(),
    knowledgeRuntime: () => knowledgeRagStats(),
    conversationFeedback: () => readJson("conversation_feedback.json"),
    securityEvents: () => readJson("security_events.json"),
  };
  const fallback = {
    employees: [], skills: [], tools: [], plans: [], logs: [], toolTests: [], cozeSessions: [], conversations: [], handoffs: [],
    evaluationCases: [], evaluationRuns: [], accessPolicies: [], analytics: null, knowledgeDocuments: [], knowledgeImportJobs: [],
    knowledgeRuntime: { documents: 0, active_documents: 0, indexed_documents: 0, chunks: 0, embedding: { provider: "local-hash", model: "local-chinese-ngram-v1", configured: true } },
    conversationFeedback: [], securityEvents: [],
  };
  const values = { ...fallback };
  const bootstrapErrors = [];
  await Promise.all(Object.entries(loaders).map(async ([name, loader]) => {
    try { values[name] = await loader(); }
    catch (error) {
      const issue = { source: name, code: error.code || "BOOTSTRAP_SOURCE_FAILED", message: error.message || "数据加载失败" };
      bootstrapErrors.push(issue);
      console.error(`[bootstrap:${name}]`, issue.code, issue.message);
    }
  }));
  const { employees, skills, tools, plans, logs, toolTests, cozeSessions, conversations, handoffs, evaluationCases, evaluationRuns, accessPolicies, analytics, knowledgeDocuments, knowledgeImportJobs, knowledgeRuntime, conversationFeedback, securityEvents } = values;
  const llm = getLlmRuntimeConfig();
  const runtimeSkills = skills.map((skill) => ({ ...skill, effective_model: llm.model, model_source: llm.model_source }));
  return { bootstrap_status: bootstrapErrors.length ? "partial" : "ok", bootstrap_errors: bootstrapErrors, employees, skills: runtimeSkills, tools: tools.map(publicTool), plans, logs, tool_tests: toolTests, coze_sessions: cozeSessions, conversations, conversation_feedback: conversationFeedback, handoffs, knowledge_documents: knowledgeDocuments, knowledge_stats: documentStats(knowledgeDocuments), knowledge_import_jobs: knowledgeImportJobs, knowledge_runtime: knowledgeRuntime, security_events: securityEvents, evaluation_cases: evaluationCases.filter((item) => !item.isBadCase), bad_case_evaluation_cases: evaluationCases.filter((item) => item.isBadCase), evaluation_runs: evaluationRuns, access_policies: accessPolicies, analytics, llm, api_base: "/api" };
}

async function dataHealth() {
  const datasets = {
    employees: () => readJson("employees.json"),
    knowledge_documents: () => readJson("knowledge_documents.json"),
    knowledge_chunks: () => readJson("knowledge_chunks.json"),
    skills: () => readJson("skills.json"),
    tools: () => readJson("tools.json"),
    plans: () => readJson("plans.json"),
    execution_logs: () => readJson("execution_logs.json"),
  };
  const checks = await Promise.all(Object.entries(datasets).map(async ([name, loader]) => {
    try {
      const value = await loader();
      return [name, { ok: true, count: Array.isArray(value) ? value.length : 1 }];
    } catch (error) {
      return [name, { ok: false, count: 0, code: error.code || "DATASET_READ_FAILED", message: error.message || "数据读取失败" }];
    }
  }));
  const result = Object.fromEntries(checks);
  return { status: Object.values(result).every((item) => item.ok) ? "ok" : "partial", datasets: result, checked_at: new Date().toISOString() };
}

function publicTool(tool) {
  return {
    ...tool,
    headers: Object.fromEntries(Object.keys(tool.headers || {}).map((key) => [key, "***configured***"])),
    auth_configured: Boolean(tool.auth_env_var && getRuntimeEnv(tool.auth_env_var)?.trim()),
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

export async function handleNodeApiRequest(req, res) {
  await initializeApi();
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (await handleSystemRoutes(req, res, url, { bootstrap, dataHealth, demoBootstrap })) return;
    if (await handleManagementRoutes(req, res, url, { managementSkills, managementTools, listSkills, listTools, publicTool, previewPlanner, runToolTest })) return;
    if (await handleKnowledgeRoutes(req, res, url)) return;
    if (await handleEvaluationRoutes(req, res, url, { listSkills, listTools, getRun, executeAgent })) return;
    if (req.method === "GET" && url.pathname === "/api/config/export") return send(res, 200, await exportConfiguration(), { "Content-Disposition": `attachment; filename="peopleflow-config-${new Date().toISOString().slice(0, 10)}.json"` });
    if (req.method === "POST" && url.pathname === "/api/config/import") return send(res, 200, await importConfiguration(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/agent/run") return streamAgentRun(req, res);
    if (req.method === "POST" && url.pathname === "/api/execute") return send(res, 200, await executeAgent(await body(req), { source: "workbench" }));
    if (req.method === "GET" && url.pathname === "/api/runs") return send(res, 200, await listRuns(url.searchParams));
    if (req.method === "POST" && url.pathname === "/api/explain") {
      const payload = await body(req);
      return send(res, 200, explainRun(await getRun(payload.run_id)));
    }
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
      if (!["up", "down"].includes(payload.rating)) throw new Error("评价只能是 up 或 down");
      let conversation;
      let targetMessage;
      await updateJson("conversations.json", (rows) => {
        conversation = rows.find((item) => item.id === conversationFeedback[1]);
        if (!conversation) throw new Error("多轮会话不存在");
        const indexedMessage = Number.isInteger(payload.message_index) ? conversation.messages[payload.message_index] : null;
        targetMessage = payload.message_id ? conversation.messages.find((item) => item.id === payload.message_id && item.role === "assistant") : indexedMessage?.role === "assistant" ? indexedMessage : [...conversation.messages].reverse().find((item) => item.role === "assistant");
        if (!targetMessage) throw new Error("未找到可评价的助手回复");
        if (!targetMessage.id) targetMessage.id = id("MSG");
        return rows.map(sanitizeForStorage);
      });
      let record;
      await updateJson("conversation_feedback.json", (feedbackRows) => {
        const existing = feedbackRows.find((item) => item.conversation_id === conversation.id && item.message_id === targetMessage.id);
        record = sanitizeForStorage({ id: existing?.id || id("FDBK"), conversation_id: conversation.id, message_id: targetMessage.id, execution_id: targetMessage.execution_id || null, employee_id: conversation.employee_id, rating: payload.rating, tags: Array.isArray(payload.tags) ? payload.tags.map(String).slice(0, 8) : [], comment: String(payload.comment || "").slice(0, 500), created_at: existing?.created_at || new Date().toISOString(), updated_at: new Date().toISOString() });
        if (existing) Object.assign(existing, record); else feedbackRows.unshift(record);
        return feedbackRows.slice(0, 1000);
      });
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
      await updateJson("conversations.json", (conversations) => {
        if (!conversations.some((item) => item.id === conversationMatch[1])) throw new Error("多轮会话不存在");
        return conversations.filter((item) => item.id !== conversationMatch[1]);
      });
      await updateJson("conversation_feedback.json", (feedbackRows) => feedbackRows.filter((item) => item.conversation_id !== conversationMatch[1]));
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
}
