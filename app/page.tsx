"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import EvaluationCenter, { type EvaluationCase, type EvaluationRun } from "./EvaluationCenter";
import KnowledgeCenter, { type KnowledgeDocument, type KnowledgeImportJob, type KnowledgeRuntime } from "./KnowledgeCenter";
import ConversationCenter, { type ConversationFeedback, type ConversationRecord } from "./ConversationCenter";
import AnalyticsDashboard, { type AnalyticsData } from "./AnalyticsDashboard";
import SkillsPage from "./skills/page";
import ToolsPage from "./tools/page";
import PlannerPage from "./planner/page";
import ModelsPage from "./models/page";
import { apiRequest, type ApiRequestInit } from "./admin/api";

type Employee = { id: string; name: string; department: string; position: string; stage: string; manager: string; hr_partner: string };
type Skill = { id: string; name: string; description: string; prompt: string; enabled: boolean; model: string; effective_model?: string; model_source?: "global" | "skill" | "fixture" | "unconfigured"; version?: string; source_document?: string; temperature: number; max_tokens: number; last_test?: { tested_at: string } };
type Tool = { id: string; name: string; description: string; enabled: boolean; type?: "local" | "http" | "coze_workflow"; source: string; endpoint?: string; method?: string; timeout_ms?: number; auth_env_var?: string; headers?: Record<string, string>; workflow_id?: string; base_url?: string; answer_node_titles?: string[]; input_schema: Record<string, string>; output_schema?: Record<string, string>; last_test?: { tested_at: string; test_id?: string } };
type PlanNode = { id: string; kind: "skill" | "tool"; capability_id: string; goal: string; condition: string; depends_on: string[]; retry: number; enabled?: boolean };
type Plan = { id: string; name: string; description: string; enabled: boolean; nodes: PlanNode[] };
type Step = PlanNode & { name: string; input: unknown; output: unknown; status: string; duration_ms: number; attempts?: number; error?: unknown; provider?: string | null; model?: string | null };
type Evidence = { title: string; category: string; source: string; source_id?: string; version?: string; effective_date?: string };
type Execution = { id: string; conversation_id?: string; response_message_id?: string; created_at: string; updated_at?: string; source?: string; status?: string; question: string; employee?: Employee; employee_id?: string; plan?: { id: string; name: string; rationale: string; selection_mode?: string; route_decision?: { type: string; label: string; confidence: number; reason: string }; selected_skills?: string[]; selected_tools?: string[]; mandatory_capabilities?: string[]; steps: Step[] }; plan_validation?: { valid: boolean; action?: string; errors?: { code: string; message: string }[] }; steps: Step[]; final_reply?: string | null; evidence?: Evidence[]; risk_review?: { risk_level: string; passed: boolean; issues: unknown[]; suggestions: string[] }; mode: string; provider?: string; model?: string; duration_ms?: number; error?: { code?: string; message?: string } | null };
type Trace = { index: number; event: string; node_title?: string; node_type?: string; content?: string; duration_ms?: number; status_code?: number; timestamp?: string };
type CozeSession = { id: string; tool_id: string; question: string; status: string; attempts: number; event_id: string; trace: Trace[]; output?: unknown };
type ToolTest = { id: string; tool_id: string; tool_name: string; created_at: string; status: string; input: unknown; output: unknown; request?: unknown; trace: Trace[]; duration_ms: number; error?: string; rerun_of?: string; session_id?: string };
type LlmRuntime = { configured: boolean; provider: string; mode?: string; model: string; global_model?: string | null; model_source: "global" | "skill" | "fixture" | "unconfigured"; endpoint: string; json_mode: string; timeout_ms: number; max_retries: number; fallback_to_mock: boolean };
type LlmTestResult = Partial<LlmRuntime> & { ok: boolean; error?: string | { code?: string; message?: string }; duration_ms?: number; attempts?: number; output?: unknown };
type Conversation = ConversationRecord;
type Handoff = { id: string; question: string; summary: string; reason: string; risk_level: string; assigned_to: string; status: string; created_at: string };
type BootstrapIssue = { source: string; code: string; message: string };
type Bootstrap = { bootstrap_status?: "ok" | "partial"; bootstrap_errors?: BootstrapIssue[]; employees: Employee[]; skills: Skill[]; tools: Tool[]; plans: Plan[]; logs: Execution[]; tool_tests: ToolTest[]; coze_sessions: CozeSession[]; conversations: Conversation[]; conversation_feedback: ConversationFeedback[]; handoffs: Handoff[]; knowledge_documents: KnowledgeDocument[]; knowledge_stats: { total: number; active: number; review: number; failed: number; indexed: number; chunks: number; categories: number; characters: number }; knowledge_import_jobs: KnowledgeImportJob[]; knowledge_runtime: KnowledgeRuntime; security_events: { id: string; category: string; action: string; risk_level: string; created_at: string }[]; evaluation_cases: EvaluationCase[]; bad_case_evaluation_cases: EvaluationCase[]; evaluation_runs: EvaluationRun[]; access_policies: { id: string; description: string }[]; analytics: AnalyticsData | null; llm: LlmRuntime };

function request(path: "/execute" | `/runs/${string}/retry`, options?: ApiRequestInit): Promise<Execution>;
function request(path: "/llm/test", options?: ApiRequestInit): Promise<LlmTestResult>;
function request<T = unknown>(path: string, options?: ApiRequestInit): Promise<T>;
function request<T = unknown>(path: string, options?: ApiRequestInit) {
  return apiRequest<T>(path, options);
}
const legacyViewAliases: Record<string, string> = { plans: "planner-admin", skills: "skills-admin", tools: "tools-admin", tests: "tools-admin", config: "config-admin" };
const conditions = ["always", "materials", "task", "policy", "training", "contact", "coze", "process"];
const conditionNames: Record<string, string> = { always: "始终", materials: "入职材料", task: "入职任务", policy: "制度问题", training: "培训问题", contact: "联系人问题", coze: "Coze 工作流", process: "办理流程" };
const examples = ["我入职第一天需要做什么？", "我的电脑和账号什么时候可以领取？", "公司请假制度是什么？", "请调用 Coze 工作流查询入职材料"];

function JsonBlock({ value }: { value: unknown }) { return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>; }
function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
function sampleToolInput(tool: Tool) { return Object.fromEntries(Object.keys(tool.input_schema || {}).map((key) => [key, key === "roles" ? [] : key === "query" ? "请假" : key === "USER_INPUT" ? "我明天去北京入职，需要带什么入职材料？" : "E001"])); }
function isCozeTool(tool?: Tool | null) { return Boolean(tool && (tool.type === "coze_workflow" || tool.id.startsWith("run_coze_workflow_"))); }
function safeJson(value: string) { try { return JSON.parse(value); } catch { return value; } }
function statusLabel(status?: string) { return ({ success: "执行成功", needs_input: "需要补充信息", failed: "执行失败", empty_output: "未返回答案", running: "执行中" } as Record<string, string>)[status || ""] || status || "尚未执行"; }
function riskLabel(risk?: string) { return ({ low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险", unknown: "未知风险" } as Record<string, string>)[risk || "unknown"] || risk; }

export default function Home() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [view, setView] = useState("agent");
  const [toast, setToast] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [loadingData, setLoadingData] = useState(true);
  const [bootstrapMessage, setBootstrapMessage] = useState("");
  const [question, setQuestion] = useState(examples[0]);
  const [running, setRunning] = useState(false);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [skillTestInput, setSkillTestInput] = useState("请识别这个入职问题：第一天要做什么？");
  const [skillTestResult, setSkillTestResult] = useState<unknown>(null);
  const [editingTool, setEditingTool] = useState<Tool | null>(null);
  const [creatingTool, setCreatingTool] = useState(false);
  const [inputSchemaText, setInputSchemaText] = useState("{}");
  const [outputSchemaText, setOutputSchemaText] = useState("{}");
  const [headersText, setHeadersText] = useState("{}");
  const [testingTool, setTestingTool] = useState<Tool | null>(null);
  const [toolTestInput, setToolTestInput] = useState("{}");
  // Tool outputs are user-configurable JSON, so the UI intentionally keeps this boundary dynamic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [toolTestResult, setToolTestResult] = useState<any>(null);
  const [resumeData, setResumeData] = useState("");
  const [planDraft, setPlanDraft] = useState<Plan | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [draggedNode, setDraggedNode] = useState<string | null>(null);
  const [llmTestResult, setLlmTestResult] = useState<LlmTestResult | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const executionRef = useRef<HTMLElement>(null);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); };
  const navigateView = (next: string) => {
    const normalized = legacyViewAliases[next] || next;
    setView(normalized);
    setMenuOpen(false);
    window.history.replaceState(null, "", normalized === "agent" ? "/" : `/?view=${encodeURIComponent(normalized)}`);
  };
  const load = async () => {
    setLoadingData(true);
    try {
      const next = await request("/bootstrap") as Bootstrap;
      setData(next);
      const employees = Array.isArray(next.employees) ? next.employees : [];
      setEmployeeId((current) => employees.some((item) => item.id === current) ? current : employees[0]?.id || "");
      setConversationId((current) => current || next.conversations?.find((item: Conversation) => item.employee_id === employeeId)?.id || "");
      setExecution((current) => current || next.logs?.[0] || null);
      setPlanDraft(next.plans?.[0] ? structuredClone(next.plans[0]) : null);
      const issues = next.bootstrap_errors || [];
      setBootstrapMessage(issues.length ? `部分数据加载失败：${issues.map((item) => item.source).join("、")}` : "");
    } catch (error) {
      const message = error instanceof Error ? error.message : "平台初始化失败";
      setBootstrapMessage(message);
      notify(message);
    } finally { setLoadingData(false); }
  };
  // Initial server synchronization is an external-system effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  // Keep the active workspace view addressable without creating a second admin shell.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    if (requested) {
      // Query-string navigation is intentionally synchronized after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setView(legacyViewAliases[requested] || requested);
    }
  }, []);

  const employee = useMemo(() => data?.employees.find((item) => item.id === employeeId), [data, employeeId]);
  const capabilities = useMemo(() => ({ skill: data?.skills || [], tool: data?.tools || [] }), [data]);
  const pageTitle: Record<string, string> = { agent: "Agent 执行", conversations: "会话中心", knowledge: "知识库管理", "planner-admin": "Plan 编排", "skills-admin": "Skill 管理", "tools-admin": "Tool 管理", evaluations: "评测中心", analytics: "运营看板", handoffs: "人工转接", "tool-edit": creatingTool ? "新增 Tool" : "编辑 Tool", "tool-test": "测试 Tool", logs: "执行日志", "config-admin": "配置中心", "skill-edit": "编辑 Skill" };

  const execute = async (payload?: { employee_id: string; question: string; plan_id?: string }) => {
    if (!payload && !employee) { notify("员工数据尚未加载完成，请先重新加载"); return; }
    setRunning(true); setOpenStep(null);
    try {
      const result = await request("/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || { employee_id: employeeId, actor_employee_id: employeeId, question, plan_id: planDraft?.id, conversation_id: conversationId || undefined }) });
      setExecution(result); if (result.conversation_id) setConversationId(result.conversation_id); window.setTimeout(() => executionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80); await load(); notify("执行完成");
    } catch (error) { notify(error instanceof Error ? error.message : "执行失败"); }
    finally { setRunning(false); }
  };

  const openToolEditor = (tool?: Tool) => {
    const value = tool ? structuredClone(tool) : { id: "custom_http_tool", name: "新建 HTTP Tool", description: "调用外部 HTTP API", enabled: true, type: "http" as const, source: "HTTPS API", endpoint: "https://example.com/api", method: "POST", timeout_ms: 30000, auth_env_var: "", headers: {}, answer_node_titles: [], input_schema: { query: "string" }, output_schema: {} };
    setCreatingTool(!tool); setEditingTool(value); setInputSchemaText(JSON.stringify(value.input_schema || {}, null, 2)); setOutputSchemaText(JSON.stringify(value.output_schema || {}, null, 2)); setHeadersText(JSON.stringify(value.headers || {}, null, 2)); setView("tool-edit");
  };

  const saveTool = async () => {
    if (!editingTool) return;
    try {
      const payload = { ...editingTool, input_schema: JSON.parse(inputSchemaText), output_schema: JSON.parse(outputSchemaText), headers: JSON.parse(headersText) };
      await request(creatingTool ? "/tools" : `/tools/${editingTool.id}`, { method: creatingTool ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await load(); setView("tools"); notify(creatingTool ? "Tool 已创建" : "Tool 已保存");
    } catch (error) { notify(error instanceof Error ? error.message : "保存失败"); }
  };

  const openToolTest = (tool: Tool) => { setTestingTool(tool); setToolTestInput(JSON.stringify(sampleToolInput(tool), null, 2)); setToolTestResult(null); setResumeData(""); setView("tool-test"); };
  const runToolTest = async () => {
    if (!testingTool) return;
    try {
      setToolTestResult({ status: "running" });
      const result = await request(`/tools/${testingTool.id}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: JSON.parse(toolTestInput) }) });
      setToolTestResult(result); await load();
    } catch (error) { setToolTestResult({ error: error instanceof Error ? error.message : "测试失败" }); }
  };
  const resumeCoze = async () => {
    const session = toolTestResult?.interrupt_session;
    if (!session || !resumeData.trim()) return;
    try {
      const result = await request(`/coze-sessions/${session.id}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resume_data: resumeData }) });
      setToolTestResult(result); setResumeData(""); await load();
    } catch (error) { notify(error instanceof Error ? error.message : "恢复失败"); }
  };

  const updateNode = (patch: Partial<PlanNode>) => setPlanDraft((plan) => !plan ? plan : ({ ...plan, nodes: plan.nodes.map((node) => node.id === selectedNode ? { ...node, ...patch } : node) }));
  const addPlanNode = () => {
    if (!planDraft) return;
    let index = planDraft.nodes.length + 1; let nodeId = `node_${index}`;
    while (planDraft.nodes.some((node) => node.id === nodeId)) nodeId = `node_${++index}`;
    const node: PlanNode = { id: nodeId, kind: "tool", capability_id: data?.tools[0]?.id || "", goal: "执行新增能力", condition: "always", depends_on: [], retry: 0 };
    setPlanDraft({ ...planDraft, nodes: [...planDraft.nodes, node] }); setSelectedNode(node.id);
  };
  const savePlan = async () => {
    if (!planDraft) return;
    try { await request(`/plans/${planDraft.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(planDraft) }); await load(); notify("Plan 已保存并即时生效"); }
    catch (error) { notify(error instanceof Error ? error.message : "Plan 保存失败"); }
  };
  const dropNode = (targetId: string) => {
    if (!draggedNode || !planDraft || draggedNode === targetId) return;
    const next = [...planDraft.nodes]; const from = next.findIndex((node) => node.id === draggedNode); const to = next.findIndex((node) => node.id === targetId); const [moved] = next.splice(from, 1); next.splice(to, 0, moved); setPlanDraft({ ...planDraft, nodes: next }); setDraggedNode(null);
  };

  const exportConfig = async () => {
    try { const config = await request("/config/export"); const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `peopleflow-config-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); notify("配置已导出，不包含 Token"); } catch (error) { notify(error instanceof Error ? error.message : "导出失败"); }
  };
  const importConfig = async (file?: File) => {
    if (!file) return;
    try { await request("/config/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() }); setPlanDraft(null); await load(); notify("配置导入成功"); } catch (error) { notify(error instanceof Error ? error.message : "导入失败"); }
  };
  const testLlm = async () => {
    setLlmTesting(true); setLlmTestResult(null);
    try { const result = await request("/llm/test", { method: "POST" }); setLlmTestResult(result); const errorMessage = typeof result.error === "string" ? result.error : result.error?.message; notify(result.ok ? (result.mode === "fixture" ? "Fixture 演示链路可用" : "大模型连接成功") : errorMessage || "大模型连接失败"); }
    catch (error) { const message = error instanceof Error ? error.message : "大模型连接失败"; setLlmTestResult({ ok: false, error: message }); notify(message); }
    finally { setLlmTesting(false); }
  };

  const navGroups = [
    { label: "工作区", items: [["agent", "◎", "Agent 执行"], ["conversations", "◌", "会话中心"], ["handoffs", "↗", "人工转接"]] },
    { label: "能力中心", items: [["planner-admin", "⌘", "Plan 编排"], ["skills-admin", "◇", "Skill 管理"], ["tools-admin", "▣", "Tool 管理"], ["knowledge", "▤", "知识库管理"]] },
    { label: "质量与运营", items: [["evaluations", "✓", "评测中心"], ["logs", "≡", "执行日志"], ["analytics", "▥", "运营看板"]] },
    { label: "系统", items: [["config-admin", "⚙", "配置中心"]] },
  ];
  const activeNav = view;
  const selectedPlanNode = planDraft?.nodes.find((node) => node.id === selectedNode) || null;

  return <main className="app-shell">
    <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
      <div className="brand"><span className="brand-mark">P</span><div><strong>PeopleFlow</strong><small>可配置执行平台</small></div></div>
      <nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><small>{group.label}</small>{group.items.map(([id, icon, label]) => <button key={id} className={activeNav === id ? "active" : ""} onClick={() => navigateView(id)}><span>{icon}</span>{label}</button>)}</div>)}<Link className="demo-nav-link" href="/demo"><span>聊</span><div><strong>员工端预览</strong><small>查看真实对话体验</small></div></Link></nav>
      <div className="sidebar-foot"><span className="status-dot"/><div><strong>本地运行中</strong><small>RAG 知识库 · v1.6.0</small></div></div>
    </aside>
    {menuOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMenuOpen(false)}/>}
    <section className="workspace">
      <header className="topbar"><div className="topbar-title"><button className="menu-toggle" aria-label="打开导航" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>☰</button><span className="crumb">企业入职助手</span><span className="slash">/</span><strong>{pageTitle[view] || "管理平台"}</strong></div><div className="top-actions"><Badge tone={bootstrapMessage ? "orange" : "green"}>{bootstrapMessage ? "部分数据异常" : loadingData ? "正在同步" : "系统正常"}</Badge><span className="avatar">管</span></div></header>

      {bootstrapMessage && <section className="bootstrap-alert" role="alert"><div><strong>平台数据未完全加载</strong><span>{bootstrapMessage}。已成功加载的模块仍可使用。</span>{Boolean(data?.bootstrap_errors?.length) && <small>{data?.bootstrap_errors?.map((item) => `${item.source}: ${item.message}`).join("；")}</small>}</div><button className="secondary" onClick={() => void load()} disabled={loadingData}>{loadingData ? "正在重试" : "重新加载"}</button></section>}

      {view === "planner-admin" && <PlannerPage embedded/>}
      {view === "skills-admin" && <SkillsPage embedded/>}
      {view === "tools-admin" && <ToolsPage embedded/>}
      {view === "config-admin" && <ModelsPage embedded/>}

      {view === "agent" && <div className="page">
        <div className="page-heading"><div><h1>Agent 执行</h1><p>按当前可配置 Plan 编排 Skill 与 Tool，并保留完整执行轨迹。</p></div><Badge tone="purple">{planDraft?.name || "默认 Plan"}</Badge></div>
        <div className="agent-grid">
          <section className="panel composer"><div className="conversation-bar"><label>当前会话<select value={conversationId} onChange={(event) => setConversationId(event.target.value)}><option value="">＋ 新建对话</option>{data?.conversations.filter((item) => item.employee_id === employeeId).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.messages.length} 条消息</option>)}</select></label><button className="secondary" onClick={() => { setConversationId(""); setExecution(null); notify("已切换到新对话"); }}>新对话</button></div><label>员工</label><select value={employeeId} disabled={loadingData || !data?.employees.length} onChange={(event) => { setEmployeeId(event.target.value); setConversationId(""); }}><option value="" disabled>{loadingData ? "正在加载员工数据…" : "暂无可用员工，请重新加载"}</option>{data?.employees.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.department} · {item.position}</option>)}</select>{employee && <div className="profile-card"><span className="profile-avatar">{employee.name.slice(0, 1)}</span><div><strong>{employee.name}</strong><span>{employee.id} · {employee.stage}</span></div><div className="profile-meta"><span>直属领导<b>{employee.manager}</b></span><span>HR 对接人<b>{employee.hr_partner}</b></span></div></div>}<label>员工问题</label><textarea value={question} onChange={(event) => setQuestion(event.target.value)}/><div className="chips">{examples.map((item) => <button key={item} onClick={() => setQuestion(item)}>{item}</button>)}</div><button className="primary" disabled={running || !employee} onClick={() => execute()}>{running ? <><span className="spinner"/>正在执行</> : loadingData ? "正在加载员工数据" : "生成 Plan 并执行"}</button></section>
          <section className="panel capabilities capability-strip"><div><span className="eyebrow">RUNTIME STATUS</span><h3>当前能力</h3><p className="muted">Planner 只会从已启用能力中选择</p></div>{loadingData ? <div className="capability-skeleton" aria-label="正在加载能力配置"><i/><i/><i/><i/></div> : <div className="capability-status"><span><b>{data?.skills.filter((item) => item.enabled).length}</b> Skills</span><span><b>{data?.tools.filter((item) => item.enabled).length}</b> Tools</span><span><b>{planDraft?.nodes.length}</b> Plan 节点</span><span className={(data?.coze_sessions.filter((item) => item.status === "waiting_input").length || 0) > 0 ? "attention" : ""}><b>{data?.coze_sessions.filter((item) => item.status === "waiting_input").length}</b> 待续跑</span></div>}</section>
        </div>
        {execution && <section className="execution-section" ref={executionRef}>
          <div className="result-head"><div><span className="eyebrow">EXECUTION TRACE</span><h2>执行结果</h2></div><div className="run-meta"><code>{execution.id}</code><Badge tone={execution.status === "success" ? "green" : execution.status === "blocked" || execution.status === "error" ? "red" : "blue"}>{execution.status || "历史记录"}</Badge><Badge tone="purple">{execution.provider || execution.mode}</Badge><Badge>{execution.model || "未记录模型"}</Badge><Badge tone={execution.risk_review?.risk_level === "critical" || execution.risk_review?.risk_level === "high" ? "red" : execution.risk_review?.risk_level === "medium" ? "orange" : "green"}>{execution.risk_review?.risk_level || "unknown"}</Badge></div></div>
          {execution.plan && <div className="panel plan-card"><div className="route-decision"><div><span className="eyebrow">AGENT ROUTE</span><strong>{execution.plan.route_decision?.label || "通用执行链路"}</strong><small>{execution.plan.route_decision?.reason || "根据问题语义和节点条件选择能力"}</small></div><Badge tone="purple">置信度 {Math.round((execution.plan.route_decision?.confidence || .8) * 100)}%</Badge></div><p>{execution.plan.rationale}</p><div className="agent-pipeline" aria-label="Agent 执行链路"><span>问题识别</span><i>→</i><span>员工与权限</span><i>→</i><span>知识 / 业务查询</span><i>→</i><span>回复生成</span><i>→</i><span>风险审核</span></div><details className="plan-details"><summary>查看本次实际选用的 {execution.plan.steps.length} 个能力</summary><div className="plan-flow">{execution.plan.steps.map((step) => <span key={step.id}>{step.id} · {step.name}</span>)}</div></details>{execution.plan_validation && <div className={`validator-summary ${execution.plan_validation.valid ? "valid" : "invalid"}`}><strong>{execution.plan_validation.valid ? "Plan Validator 已通过" : "Plan Validator 已阻断"}</strong>{execution.plan_validation.errors?.map((item) => <span key={`${item.code}-${item.message}`}>{item.code} · {item.message}</span>)}</div>}</div>}
          <div className="trace-layout"><div className="trace-list">{execution.steps?.map((step, index) => <article className="step-card" key={step.id}><button className="step-summary" onClick={() => setOpenStep(openStep === step.id ? null : step.id)}><span className={`step-index ${step.kind}`}>{index + 1}</span><div><strong>{step.name}</strong><p>{step.goal}</p></div><div className="step-status"><Badge tone={step.status === "success" ? "green" : step.status === "needs_input" ? "orange" : "red"}>{step.status}</Badge><small>{step.duration_ms}ms · {step.attempts || 1} 次</small></div></button>{openStep === step.id && <div className="io-grid"><div><label>INPUT</label><JsonBlock value={step.input}/></div><div><label>OUTPUT / ERROR</label><JsonBlock value={step.error || step.output}/></div></div>}</article>)}</div><div className="final-column"><section className="panel answer-card"><h3>最终回复</h3><div className="answer-text">{execution.final_reply || execution.error?.message || "本次运行没有生成最终回复。"}</div></section>{Boolean(execution.evidence?.length) && <section className="panel evidence-card"><h3>回答依据</h3><div>{execution.evidence?.map((item, index) => <article key={`${item.source}-${item.source_id || index}`}><Badge tone="blue">{item.category}</Badge><strong>{item.title}</strong><small>{item.source}{item.version ? ` · v${item.version}` : ""}{item.effective_date ? ` · ${item.effective_date} 生效` : ""}</small></article>)}</div></section>}<Link className="secondary wide run-detail-link" href={`/runs/${execution.id}`}>查看完整运行详情</Link>{(execution.employee || execution.employee_id) && execution.plan && <button className="secondary wide" onClick={() => execute({ employee_id: execution.employee?.id || execution.employee_id || employeeId, question: execution.question, plan_id: execution.plan?.id })}>重新运行本次执行</button>}</div></div>
        </section>}
      </div>}

      {view === "conversations" && <ConversationCenter conversations={data?.conversations || []} employees={data?.employees || []} feedback={data?.conversation_feedback || []} request={request} onReload={load} notify={notify} onContinue={(conversation) => { setEmployeeId(conversation.employee_id); setConversationId(conversation.id); setQuestion(""); setExecution(null); setView("agent"); notify("已载入会话，可继续追问"); }}/>} 

      {view === "knowledge" && <KnowledgeCenter documents={data?.knowledge_documents || []} stats={data?.knowledge_stats || { total: 0, active: 0, review: 0, failed: 0, indexed: 0, chunks: 0, categories: 0, characters: 0 }} importJobs={data?.knowledge_import_jobs || []} runtime={data?.knowledge_runtime || { documents: 0, active_documents: 0, indexed_documents: 0, chunks: 0, embedding: { provider: "local-hash", model: "local-chinese-ngram-v1", configured: true } }} request={request} onReload={load} notify={notify}/>} 

      {view === "plans" && <div className="page"><div className="page-heading"><div><h1>Plan 可视化编排</h1><p>拖动节点调整顺序，配置能力、条件分支、依赖关系和失败重试。</p></div><div className="heading-actions"><button className="secondary" onClick={addPlanNode}>＋ 新增节点</button><button className="primary compact" onClick={savePlan}>保存并生效</button></div></div>{planDraft && <div className="builder-layout"><section className="panel plan-canvas"><div className="canvas-head"><input value={planDraft.name} onChange={(event) => setPlanDraft({ ...planDraft, name: event.target.value })}/><Badge tone="green">{planDraft.nodes.length} 节点</Badge></div><div className="node-track">{planDraft.nodes.map((node, index) => <article key={node.id} draggable onDragStart={() => setDraggedNode(node.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropNode(node.id)} onClick={() => setSelectedNode(node.id)} className={`flow-node ${selectedNode === node.id ? "selected" : ""}`}><span className={`node-kind ${node.kind}`}>{node.kind === "tool" ? "T" : "S"}</span><div><small>{index + 1} · {conditionNames[node.condition]}</small><strong>{node.capability_id}</strong><p>{node.goal}</p><div className="node-tags"><em>重试 {node.retry}</em>{node.depends_on.map((dep) => <em key={dep}>← {dep}</em>)}</div></div><span className="drag">⋮⋮</span></article>)}</div></section><aside className="panel node-editor">{selectedPlanNode ? <><div className="editor-title"><div><span className={`node-kind ${selectedPlanNode.kind}`}>{selectedPlanNode.kind === "tool" ? "T" : "S"}</span><div><strong>{selectedPlanNode.id}</strong><small>节点配置</small></div></div><button className="danger-link" onClick={() => { setPlanDraft({ ...planDraft, nodes: planDraft.nodes.filter((node) => node.id !== selectedPlanNode.id).map((node) => ({ ...node, depends_on: node.depends_on.filter((dep) => dep !== selectedPlanNode.id) })) }); setSelectedNode(null); }}>删除</button></div><label>节点 ID<input value={selectedPlanNode.id} disabled/></label><label>能力类型<select value={selectedPlanNode.kind} onChange={(event) => { const kind = event.target.value as "skill" | "tool"; updateNode({ kind, capability_id: capabilities[kind][0]?.id || "" }); }}><option value="skill">Skill</option><option value="tool">Tool</option></select></label><label>绑定能力<select value={selectedPlanNode.capability_id} onChange={(event) => updateNode({ capability_id: event.target.value })}>{capabilities[selectedPlanNode.kind].map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>执行条件<select value={selectedPlanNode.condition} onChange={(event) => updateNode({ condition: event.target.value })}>{conditions.map((item) => <option key={item} value={item}>{conditionNames[item]}</option>)}</select></label><label>失败重试<input type="number" min="0" max="3" value={selectedPlanNode.retry} onChange={(event) => updateNode({ retry: Number(event.target.value) })}/></label><label>目标说明<textarea value={selectedPlanNode.goal} onChange={(event) => updateNode({ goal: event.target.value })}/></label><fieldset><legend>依赖节点</legend>{planDraft.nodes.filter((node) => node.id !== selectedPlanNode.id).map((node) => <label className="check" key={node.id}><input type="checkbox" checked={selectedPlanNode.depends_on.includes(node.id)} onChange={(event) => updateNode({ depends_on: event.target.checked ? [...selectedPlanNode.depends_on, node.id] : selectedPlanNode.depends_on.filter((dep) => dep !== node.id) })}/>{node.id}</label>)}</fieldset></> : <div className="empty-state">选择一个节点进行配置</div>}</aside></div>}</div>}

      {view === "skills" && <div className="page"><div className="page-heading"><div><h1>Skill 管理</h1><p>已同步最新版 6 个入职 Skill；所有 Skill 自动跟随当前全局大模型。</p></div><Badge tone="purple">{data?.skills.length || 0} 个 Skill</Badge></div><div className="skill-grid">{data?.skills.map((skill) => <article className={`panel skill-card ${skill.enabled ? "" : "disabled"}`} key={skill.id}><div className="skill-card-head"><span className="cap-icon skill">S</span><div className="skill-version"><Badge tone="blue">v{skill.version || "1.0"}</Badge><label className="switch"><input type="checkbox" checked={skill.enabled} onChange={async () => { await request(`/skills/${skill.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !skill.enabled }) }); await load(); }}/><i/></label></div></div><h3>{skill.name}</h3><p>{skill.description}</p><div className="model-row"><span>{skill.effective_model || skill.model}{skill.model_source === "global" ? " · 全局生效" : skill.model_source === "fixture" ? " · Fixture" : " · Skill 配置"}</span><span>temp {skill.temperature}</span><span>{skill.max_tokens} tokens</span></div><div className="card-actions"><button onClick={() => { setEditingSkill(structuredClone(skill)); setView("skill-edit"); }}>编辑</button><button onClick={async () => { setSkillTestResult(await request(`/skills/${skill.id}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: skillTestInput }) })); notify("Skill 测试完成"); }}>快速测试</button></div></article>)}</div>{Boolean(skillTestResult) && <section className="panel inline-result"><h3>Skill 测试结果</h3><JsonBlock value={skillTestResult}/></section>}</div>}

      {view === "skill-edit" && editingSkill && <div className="page narrow"><button className="back" onClick={() => setView("skills")}>← 返回 Skill 列表</button><div className="page-heading"><div><h1>编辑 Skill</h1><p>{editingSkill.id}</p></div></div><section className="panel form-panel"><div className="form-grid"><label>名称<input value={editingSkill.name} onChange={(event) => setEditingSkill({ ...editingSkill, name: event.target.value })}/></label><label>当前生效模型<input className={data?.llm.global_model ? "global-model-input" : ""} value={data?.llm.global_model || editingSkill.model} disabled={Boolean(data?.llm.global_model)} onChange={(event) => setEditingSkill({ ...editingSkill, model: event.target.value })}/><small className="model-help">{data?.llm.global_model ? `已自动跟随全局模型 ${data.llm.global_model}；请在配置中心对应的 .env 中切换。` : "当前未设置全局模型，使用此 Skill 的独立模型配置。"}</small></label><label className="full">描述<textarea value={editingSkill.description} onChange={(event) => setEditingSkill({ ...editingSkill, description: event.target.value })}/></label><label className="full">Prompt<textarea className="prompt-area" value={editingSkill.prompt} onChange={(event) => setEditingSkill({ ...editingSkill, prompt: event.target.value })}/></label><label>测试输入<input value={skillTestInput} onChange={(event) => setSkillTestInput(event.target.value)}/></label></div><div className="form-actions"><button onClick={() => setView("skills")}>取消</button><button className="primary compact" onClick={async () => { const persistedSkill = structuredClone(editingSkill); delete persistedSkill.effective_model; delete persistedSkill.model_source; await request(`/skills/${editingSkill.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(persistedSkill) }); await load(); setView("skills"); notify("Skill 已保存"); }}>保存</button></div></section></div>}

      {view === "tools" && <div className="page"><div className="page-heading"><div><h1>Tool 管理</h1><p>支持本地 JSON、HTTP API 与 Coze Workflow；凭据仅引用服务端环境变量。</p></div><button className="primary compact" onClick={() => openToolEditor()}>＋ 新增 Tool</button></div><div className="skill-grid">{data?.tools.map((tool) => <article className={`panel skill-card tool-card ${tool.enabled ? "" : "disabled"}`} key={tool.id}><div className="skill-card-head"><span className="cap-icon tool">T</span><label className="switch"><input type="checkbox" checked={tool.enabled} onChange={async () => { await request(`/tools/${tool.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !tool.enabled }) }); await load(); }}/><i/></label></div><div className="card-title-row"><h3>{tool.name}</h3><Badge tone={tool.type === "coze_workflow" ? "purple" : tool.type === "http" ? "blue" : "green"}>{tool.type || "local"}</Badge></div><p>{tool.description}</p><div className="tool-source"><span>DATA SOURCE</span><code>{tool.source}</code></div><div className="model-row">{Object.entries(tool.input_schema || {}).map(([key, type]) => <span key={key}>{key}: {type}</span>)}</div><div className="card-actions three"><button onClick={() => openToolEditor(tool)}>编辑</button><button onClick={() => openToolTest(tool)}>测试</button><button onClick={async () => { await request(`/tools/${tool.id}/duplicate`, { method: "POST" }); await load(); notify("已复制 Tool"); }}>复制</button></div><button className="danger-link card-delete" onClick={async () => { if (!confirm(`确认删除 ${tool.name}？`)) return; try { await request(`/tools/${tool.id}`, { method: "DELETE" }); await load(); notify("Tool 已删除"); } catch (error) { notify(error instanceof Error ? error.message : "删除失败"); } }}>删除 Tool</button></article>)}</div></div>}

      {view === "tool-edit" && editingTool && <div className="page narrow"><button className="back" onClick={() => setView("tools")}>← 返回 Tool 列表</button><div className="page-heading"><div><h1>{creatingTool ? "新增 Tool" : "编辑 Tool"}</h1><p>Token 等敏感值请放入 .env，此处只填写环境变量名。</p></div></div><section className="panel form-panel"><div className="form-grid"><label>Tool ID<input disabled={!creatingTool} value={editingTool.id} onChange={(event) => setEditingTool({ ...editingTool, id: event.target.value })}/></label><label>类型<select value={editingTool.type || "local"} onChange={(event) => setEditingTool({ ...editingTool, type: event.target.value as Tool["type"] })}><option value="local">Local JSON</option><option value="http">HTTP API</option><option value="coze_workflow">Coze Workflow</option></select></label><label>名称<input value={editingTool.name} onChange={(event) => setEditingTool({ ...editingTool, name: event.target.value })}/></label><label>数据源描述<input value={editingTool.source} onChange={(event) => setEditingTool({ ...editingTool, source: event.target.value })}/></label><label className="full">描述<textarea value={editingTool.description} onChange={(event) => setEditingTool({ ...editingTool, description: event.target.value })}/></label>{editingTool.type === "http" && <><label className="full">Endpoint<input value={editingTool.endpoint || ""} onChange={(event) => setEditingTool({ ...editingTool, endpoint: event.target.value })}/></label><label>请求方式<select value={editingTool.method || "POST"} onChange={(event) => setEditingTool({ ...editingTool, method: event.target.value })}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option></select></label></>}{editingTool.type === "coze_workflow" && <><label>Workflow ID<input value={editingTool.workflow_id || ""} onChange={(event) => setEditingTool({ ...editingTool, workflow_id: event.target.value })}/></label><label>API Base URL<input value={editingTool.base_url || "https://api.coze.cn"} onChange={(event) => setEditingTool({ ...editingTool, base_url: event.target.value })}/></label><label className="full">最终答案节点（逗号分隔）<input value={(editingTool.answer_node_titles || []).join(", ")} onChange={(event) => setEditingTool({ ...editingTool, answer_node_titles: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })}/></label></>}<label>超时（ms）<input type="number" value={editingTool.timeout_ms || 30000} onChange={(event) => setEditingTool({ ...editingTool, timeout_ms: Number(event.target.value) })}/></label><label>鉴权环境变量<input placeholder="例如 COZE_API_TOKEN" value={editingTool.auth_env_var || ""} onChange={(event) => setEditingTool({ ...editingTool, auth_env_var: event.target.value })}/></label><label className="full">Headers JSON<textarea className="code-area" value={headersText} onChange={(event) => setHeadersText(event.target.value)}/></label><label className="full">输入 Schema JSON<textarea className="code-area" value={inputSchemaText} onChange={(event) => setInputSchemaText(event.target.value)}/></label><label className="full">输出 Schema JSON<textarea className="code-area" value={outputSchemaText} onChange={(event) => setOutputSchemaText(event.target.value)}/></label></div><div className="form-actions"><button onClick={() => setView("tools")}>取消</button><button className="primary compact" onClick={saveTool}>保存并生效</button></div></section></div>}

      {view === "tool-test" && testingTool && <div className="page coze-test-page">
        <button className="back" onClick={() => setView("tools")}>← 返回 Tool 列表</button>
        <div className="page-heading"><div><span className="eyebrow">{(testingTool.type || "local").toUpperCase()} TOOL · {testingTool.id}</span><h1>测试 {testingTool.name}</h1><p>{isCozeTool(testingTool) ? "填写调用参数，查看 Coze 返回的标准回答、状态与风险等级。" : "填写调用参数，查看 Tool 的结构化输出和执行详情。"}</p></div><Badge tone={testingTool.enabled ? "green" : "red"}>{testingTool.enabled ? "已启用" : "已禁用"}</Badge></div>
        <div className="coze-workbench">
          <section className="panel coze-input-card">
            <div className="coze-card-head"><div><h2>调用参数</h2><p>保持 JSON 字段名与 Tool 输入 Schema 一致。</p></div></div>
            <label>输入 JSON</label>
            <textarea className="json-input" value={toolTestInput} onChange={(event) => setToolTestInput(event.target.value)}/>
            <div className="coze-card-footer"><small>POST /api/tools/{testingTool.id}/test</small><button className="primary compact" disabled={toolTestResult?.status === "running"} onClick={runToolTest}>{toolTestResult?.status === "running" ? "执行中…" : "运行 Tool"}</button></div>
          </section>
          <section className="panel coze-result-card">
            <div className="coze-result-head"><div><h2>执行结果</h2><p>{isCozeTool(testingTool) ? "answer / status / risk_level" : "OUTPUT JSON"}</p></div>{toolTestResult?.output && <div className="coze-badges"><Badge tone={toolTestResult.output?.status === "needs_input" ? "purple" : "green"}>{isCozeTool(testingTool) ? statusLabel(toolTestResult.output?.status || "success") : "执行成功"}</Badge>{isCozeTool(testingTool) && <Badge tone={toolTestResult.output?.risk_level === "high" ? "red" : toolTestResult.output?.risk_level === "medium" ? "orange" : "green"}>{riskLabel(toolTestResult.output?.risk_level)}</Badge>}</div>}</div>
            {toolTestResult?.status === "running" ? <div className="coze-result-empty"><div className="result-loader"/><strong>Tool 执行中</strong><span>{isCozeTool(testingTool) ? "复杂工作流可能需要几分钟，请保持页面打开。" : "正在读取并计算 Tool 输出。"}</span></div> : toolTestResult?.error ? <div className="coze-error"><strong>调用失败</strong><p>{toolTestResult.error}</p><small>展开下方调用详情可核对请求参数；网络类错误会显示 DNS、连接或证书错误码。</small></div> : toolTestResult?.output ? isCozeTool(testingTool) ? <div className="coze-answer"><span className="answer-label">ANSWER</span><div>{toolTestResult.output.answer || "工作流已完成，但没有可展示的 answer。"}</div>{toolTestResult.duration_ms !== undefined && <small>耗时 {(toolTestResult.duration_ms / 1000).toFixed(1)} 秒</small>}</div> : <div className="tool-output-card"><span className="answer-label">OUTPUT</span><JsonBlock value={toolTestResult.output}/>{toolTestResult.duration_ms !== undefined && <small>耗时 {toolTestResult.duration_ms}ms</small>}</div> : <div className="coze-result-empty"><strong>尚未执行</strong><span>在左侧确认参数后点击「运行 Tool」，结果会显示在这里。</span></div>}
            {isCozeTool(testingTool) && toolTestResult?.interrupt_session && <div className="resume-box coze-resume"><h3>请补充信息后继续</h3><p>{toolTestResult.interrupt_session.question}</p><textarea placeholder="例如：明天，北京，研发岗" value={resumeData} onChange={(event) => setResumeData(event.target.value)}/><div><small>已恢复 {toolTestResult.interrupt_session.attempts}/3 次</small><button className="primary compact" onClick={resumeCoze}>继续执行</button></div></div>}
          </section>
        </div>
        {toolTestResult && toolTestResult.status !== "running" && <details className="panel coze-debug"><summary>查看调用详情{toolTestResult.trace?.length ? "与节点轨迹" : ""}</summary><div className="io-grid"><div><label>REQUEST</label><JsonBlock value={toolTestResult.request || safeJson(toolTestInput)}/></div><div><label>OUTPUT</label><JsonBlock value={toolTestResult.output || toolTestResult}/></div></div>{toolTestResult.trace?.length > 0 && <div className="node-trace"><h3>节点轨迹</h3>{toolTestResult.trace.map((trace: Trace, index: number) => <div className="trace-row" key={`${trace.index}-${index}`}><span>{index + 1}</span><div><strong>{trace.event} · {trace.node_title || trace.node_type || "事件"}</strong><small>{trace.content || (trace.status_code ? `HTTP ${trace.status_code}` : "完成")}</small></div></div>)}</div>}</details>}
      </div>}

      {view === "logs" && <div className="page"><div className="page-heading"><div><h1>执行日志</h1><p>查看 Agent 历史执行、失败原因、实际模型和风险结果。</p></div><Badge>{data?.logs.length || 0} 条日志</Badge></div><section className="panel log-table"><div className="log-row log-head"><span>Run ID</span><span>问题</span><span>状态 / 模型</span><span>风险</span><span>时间</span><span>操作</span></div>{data?.logs.map((log) => <div className="log-row" key={log.id}><code>{log.id}</code><span>{log.employee?.name || log.employee_id || "未知员工"}<small>{log.question}</small></span><span><Badge tone={log.status === "success" ? "green" : log.status === "error" || log.status === "blocked" ? "red" : "purple"}>{log.status || log.mode}</Badge><small>{log.model || log.provider || log.mode}</small></span><Badge tone={log.risk_review?.risk_level === "critical" || log.risk_review?.risk_level === "high" ? "red" : log.risk_review?.risk_level === "medium" ? "orange" : "green"}>{log.risk_review?.risk_level || "unknown"}</Badge><span>{new Date(log.created_at).toLocaleString("zh-CN")}</span><div className="log-actions"><Link className="text-button" href={`/runs/${log.id}`}>详情</Link><button className="text-button" onClick={async () => { const result = await request(`/runs/${log.id}/retry`, { method: "POST" }); setExecution(result); await load(); setView("agent"); }}>重跑</button></div></div>)}</section></div>}

      {view === "config" && <div className="page narrow"><div className="page-heading"><div><h1>配置中心</h1><p>统一管理 OpenAI-Compatible 与显式 Fixture 运行状态；密钥永不返回网页。</p></div></div><div className="config-grid"><section className="panel config-card full llm-config-card"><div className="config-title"><span className="config-icon">AI</span><div><h2>统一 LLM Provider</h2><p>真实模式兼容 OpenAI、DeepSeek 和其他 /chat/completions 服务；演示模式使用同一 Agent 主链路。</p></div><Badge tone={data?.llm.configured ? "green" : "orange"}>{data?.llm.mode === "fixture" ? "Fixture 演示" : data?.llm.configured ? "真实模型" : "未配置"}</Badge></div><div className="llm-runtime-grid"><div><span>Provider</span><strong>{data?.llm.provider || "unconfigured"}</strong></div><div><span>实际模型</span><strong>{data?.llm.model || "未设置"}</strong></div><div><span>API 地址</span><code>{data?.llm.endpoint || "未设置"}</code></div><div><span>运行模式</span><strong>{data?.llm.mode || "unconfigured"}</strong></div></div><div className="llm-actions"><button className="primary compact" disabled={llmTesting} onClick={testLlm}>{llmTesting ? "正在测试…" : "测试 Provider"}</button><small>真实模型设置 LLM_PROVIDER=openai-compatible；演示设置 LLM_PROVIDER=classroom-fixture。切换后请重启。</small></div>{llmTestResult && <div className={`llm-test-result ${llmTestResult.ok ? "success" : "failed"}`}><strong>{llmTestResult.ok ? "Provider 可用" : "Provider 不可用"}</strong><JsonBlock value={llmTestResult}/></div>}</section><section className="panel config-card"><span className="config-icon">↓</span><h2>导出配置</h2><p>生成可迁移 JSON，包含全部编排和能力配置，不包含环境变量值和测试历史。</p><button className="primary compact" onClick={exportConfig}>下载配置 JSON</button></section><section className="panel config-card"><span className="config-icon">↑</span><h2>导入配置</h2><p>导入前会校验格式、ID 唯一性和敏感字段，成功后立即写入本地 JSON。</p><input ref={importRef} className="hidden-input" type="file" accept="application/json" onChange={(event) => importConfig(event.target.files?.[0])}/><button className="secondary wide" onClick={() => importRef.current?.click()}>选择配置文件</button></section><section className="panel config-card full"><span className="config-icon">▣</span><h2>Windows 一键运行</h2><p>项目已包含双击启动脚本和本地分发打包脚本。大模型与 Coze Token 均只由本机后端读取。</p><div className="code-note">OpenAI：LLM_BASE_URL=https://api.openai.com/v1<br/>DeepSeek：LLM_BASE_URL=https://api.deepseek.com<br/>通用路径：LLM_API_PATH=/chat/completions</div></section></div></div>}
      {view === "evaluations" && <EvaluationCenter coreCases={data?.evaluation_cases || []} badCases={data?.bad_case_evaluation_cases || []} runs={data?.evaluation_runs || []} onReload={load} notify={notify}/>} 

      {view === "analytics" && data?.analytics && <AnalyticsDashboard analytics={data.analytics} request={request} onReload={load} notify={notify}/>} 

      {view === "handoffs" && <div className="page"><div className="page-heading"><div><h1>人工转接</h1><p>高风险薪资、合同、社保、权限与争议问题自动进入处理队列。</p></div><Badge tone="orange">{data?.handoffs.filter((item) => item.status !== "resolved").length || 0} 待处理</Badge></div><section className="panel handoff-list">{data?.handoffs.length ? data.handoffs.map((item) => <article className="handoff-row" key={item.id}><div><div className="handoff-title"><code>{item.id}</code><Badge tone={item.risk_level === "critical" || item.risk_level === "high" ? "red" : "orange"}>{riskLabel(item.risk_level)}</Badge><Badge tone={item.status === "resolved" ? "green" : "purple"}>{item.status}</Badge></div><strong>{item.summary}</strong><p>{item.question}</p><small>转交：{item.assigned_to} · {item.reason}</small></div><select value={item.status} onChange={async (event) => { await request(`/handoffs/${item.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: event.target.value }) }); await load(); notify("转接状态已更新"); }}><option value="open">待处理</option><option value="processing">处理中</option><option value="resolved">已解决</option></select></article>) : <div className="empty-state">暂无需要人工转接的问题</div>}</section></div>}
      {view === "config" && <div className="page narrow security-extension"><section className="panel config-card full"><span className="config-icon">盾</span><h2>权限与数据安全</h2><p>当前本地版执行本人数据隔离、敏感字段写入脱敏、高风险自动转人工，并禁止前端获取任何 API Key。</p><div className="security-rules">{data?.access_policies.map((policy) => <article key={policy.id}><strong>{policy.id}</strong><span>{policy.description}</span></article>)}</div><div className="code-note">Planner：模型候选 Plan → 能力白名单 → 依赖补全 → Coze 限制 → 强制风险审核<br/>日志：Token / API Key / 身份证号 / 银行卡号 / 密码 / 验证码自动脱敏</div></section></div>}
    </section>
    {toast && <div className="toast">{toast}</div>}
  </main>;
}
