"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AdminShell, { StatePanel, Status } from "../admin/AdminShell";
import { AdminApiError, adminRequest, jsonRequest } from "../admin/api";

type Tool = { id: string; name: string; description: string; enabled: boolean; type: "local" | "http" | "coze_workflow"; version: string; source: string; endpoint?: string; method?: string; timeout_ms?: number; auth_env_var?: string; auth_configured?: boolean; workflow_id?: string; base_url?: string; answer_node_titles?: string[]; input_schema: Record<string, string>; output_schema?: Record<string, string>; output_example?: unknown; referenced_by_skills: string[]; referenced_by_plans: string[]; latest_test?: { status: string; duration_ms: number; created_at: string } };
type TestTrace = { index?: number; event?: string; node_title?: string; node_type?: string; content?: string; status_code?: number; timestamp?: string };
type ToolTest = { id: string; tool_id: string; tool_name: string; created_at: string; status: string; input: unknown; request?: unknown; output?: unknown; error?: string; trace?: TestTrace[]; duration_ms: number; rerun_of?: string; session_id?: string };

function sampleInput(tool: Tool) {
  return Object.fromEntries(Object.entries(tool.input_schema || {}).map(([key, type]) => [key, type === "string[]" ? [] : key === "employee_id" || key === "user_id" ? "E001" : key === "CONVERSATION_NAME" ? "E001" : key === "USER_INPUT" || key === "query" ? "我需要准备哪些入职材料？" : type === "number" ? 0 : type === "boolean" ? false : ""]));
}

export default function ToolsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Tool | null>(null);
  const [inputSchema, setInputSchema] = useState("{}");
  const [outputSchema, setOutputSchema] = useState("{}");
  const [outputExample, setOutputExample] = useState("{}");
  const [testInput, setTestInput] = useState("{}");
  const [testResult, setTestResult] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [tab, setTab] = useState<"config" | "test" | "history">("config");
  const [testHistory, setTestHistory] = useState<ToolTest[]>([]);
  const [selectedTest, setSelectedTest] = useState<ToolTest | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const historyRequest = useRef(0);

  const loadTestHistory = async (toolId: string, preferredTestId?: string) => {
    const requestId = ++historyRequest.current;
    setHistoryLoading(true);
    try {
      const rows = await adminRequest<ToolTest[]>(`/tools/${toolId}/tests`);
      if (requestId !== historyRequest.current) return;
      setTestHistory(rows);
      setSelectedTest((current) => rows.find((item) => item.id === (preferredTestId || current?.id)) || rows[0] || null);
    } catch (error) {
      if (requestId !== historyRequest.current) return;
      setTestHistory([]);
      setSelectedTest(null);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "测试历史加载失败" });
    } finally {
      if (requestId === historyRequest.current) setHistoryLoading(false);
    }
  };
  const select = (tool: Tool) => { setSelectedId(tool.id); setDraft(structuredClone(tool)); setInputSchema(JSON.stringify(tool.input_schema || {}, null, 2)); setOutputSchema(JSON.stringify(tool.output_schema || {}, null, 2)); setOutputExample(JSON.stringify(tool.output_example || {}, null, 2)); setTestInput(JSON.stringify(sampleInput(tool), null, 2)); setTestResult(null); setTab("config"); setTestHistory([]); setSelectedTest(null); void loadTestHistory(tool.id); };
  const load = async (preferredId?: string) => { setLoading(true); try { const rows = await adminRequest<Tool[]>("/tools"); setTools(rows); const next = rows.find((item) => item.id === (preferredId || selectedId)) || rows[0]; if (next) select(next); } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Tool 加载失败" }); } finally { setLoading(false); } };
  // Initial server synchronization.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  const filtered = useMemo(() => tools.filter((tool) => (filter === "all" || tool.type === filter) && `${tool.name} ${tool.id}`.toLowerCase().includes(query.toLowerCase())), [tools, filter, query]);

  const save = async () => { if (!draft) return; setBusy(true); setNotice(null); try { const payload = { name: draft.name, description: draft.description, enabled: draft.enabled, type: draft.type, source: draft.source, endpoint: draft.endpoint, method: draft.method, timeout_ms: draft.timeout_ms, auth_env_var: draft.auth_env_var, workflow_id: draft.workflow_id, base_url: draft.base_url, answer_node_titles: draft.answer_node_titles, input_schema: JSON.parse(inputSchema), output_schema: JSON.parse(outputSchema), output_example: JSON.parse(outputExample), change_note: "管理后台更新 Tool" }; await adminRequest(`/tools/${draft.id}`, jsonRequest("PUT", payload)); setNotice({ tone: "success", text: "Tool 配置已保存，旧版本快照已保留。" }); await load(draft.id); } catch (error) { setNotice({ tone: "error", text: error instanceof SyntaxError ? "Schema 或输出示例不是合法 JSON。" : error instanceof AdminApiError ? `${error.code}：${error.message}` : "Tool 保存失败" }); } finally { setBusy(false); } };
  const toggle = async () => { if (!draft) return; setBusy(true); try { await adminRequest(`/tools/${draft.id}/toggle`, jsonRequest("POST", { enabled: !draft.enabled, change_note: `${draft.enabled ? "禁用" : "启用"} ${draft.name}` })); await load(draft.id); } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "状态更新失败" }); } finally { setBusy(false); } };
  const test = async () => { if (!draft) return; setBusy(true); setTestResult(null); try { const input = JSON.parse(testInput); const result = await adminRequest(`/tools/${draft.id}/test`, jsonRequest("POST", { input })); setTestResult({ ok: true, ...result as object }); setNotice({ tone: "success", text: "Tool 已由服务端真实执行，记录已写入测试历史。" }); } catch (error) { setTestResult({ ok: false, error: error instanceof AdminApiError ? { code: error.code, message: error.message, details: error.details } : { code: "INVALID_TEST_INPUT", message: error instanceof Error ? error.message : "Tool 测试失败" } }); } finally { await loadTestHistory(draft.id); setBusy(false); } };
  const rerun = async (record: ToolTest) => { if (!draft) return; setBusy(true); try { await adminRequest(`/tool-tests/${record.id}/rerun`, jsonRequest("POST")); await loadTestHistory(draft.id); setNotice({ tone: "success", text: "已重新运行，最新结果已加入测试历史。" }); } catch (error) { await loadTestHistory(draft.id); setNotice({ tone: "error", text: error instanceof Error ? error.message : "重新运行失败" }); } finally { setBusy(false); } };

  return <AdminShell embedded={embedded} active="/tools" title="Tool 管理" description="查看真实 Schema、依赖关系与服务端调用结果，客户端不会伪造成功。" badge={<Status enabled>{tools.filter((item) => item.enabled).length} / {tools.length} 已启用</Status>}>
    {notice && <div className={`admin-alert ${notice.tone}`}>{notice.text}</div>}
    {loading ? <StatePanel state="loading"/> : !tools.length ? <StatePanel state="empty" message="尚未配置 Tool。"/> : <><div className="admin-toolbar"><input placeholder="搜索名称或 Tool ID" value={query} onChange={(event) => setQuery(event.target.value)}/><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部类型</option><option value="local">Local JSON</option><option value="http">HTTP API</option><option value="coze_workflow">Coze Workflow</option></select></div><div className="admin-grid"><section className="admin-list-panel">{filtered.map((tool) => <button key={tool.id} className={`admin-list-item ${selectedId === tool.id ? "active" : ""}`} onClick={() => select(tool)}><div className="admin-list-head"><strong>{tool.name}</strong><Status enabled={tool.enabled}/></div><p>{tool.description}</p><div className="admin-meta"><span className="admin-chip">{tool.type}</span><span className="admin-chip">v{tool.version || "1.0.0"}</span>{tool.latest_test && <span className="admin-chip">最近 {tool.latest_test.status} · {tool.latest_test.duration_ms}ms</span>}</div></button>)}</section>
      {draft && <section className="admin-editor"><div className="admin-editor-head"><div><h2>{draft.name}</h2><p>{draft.id} · {draft.type} · v{draft.version || "1.0.0"}</p></div><div className="admin-actions"><button className="admin-btn" disabled={busy} onClick={toggle}>{draft.enabled ? "禁用" : "启用"}</button><button className="admin-btn primary" disabled={busy} onClick={save}>保存配置</button></div></div><div className="admin-tabs"><button className={tab === "config" ? "active" : ""} onClick={() => setTab("config")}>配置与 Schema</button><button className={tab === "test" ? "active" : ""} onClick={() => setTab("test")}>在线测试</button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>测试历史 {testHistory.length ? `(${testHistory.length})` : ""}</button></div>
      {tab === "config" && <div className="admin-form"><label className="admin-field">名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label><label className="admin-field">类型<select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as Tool["type"] })}><option value="local">local</option><option value="http">http</option><option value="coze_workflow">coze_workflow</option></select></label><label className="admin-field full">描述<textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })}/></label><label className="admin-field">数据源<input value={draft.source || ""} onChange={(event) => setDraft({ ...draft, source: event.target.value })}/></label><label className="admin-field">超时（ms）<input type="number" min="1000" value={draft.timeout_ms || 30000} onChange={(event) => setDraft({ ...draft, timeout_ms: Number(event.target.value) })}/></label>{draft.type === "http" && <><label className="admin-field full">Endpoint<input value={draft.endpoint || ""} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}/></label><label className="admin-field">Method<select value={draft.method || "POST"} onChange={(event) => setDraft({ ...draft, method: event.target.value })}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option></select></label></>}{draft.type === "coze_workflow" && <><label className="admin-field">Workflow ID<input value={draft.workflow_id || ""} onChange={(event) => setDraft({ ...draft, workflow_id: event.target.value })}/></label><label className="admin-field">最终节点<input value={(draft.answer_node_titles || []).join("，")} onChange={(event) => setDraft({ ...draft, answer_node_titles: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })}/></label></>}<label className="admin-field">鉴权环境变量<input value={draft.auth_env_var || ""} onChange={(event) => setDraft({ ...draft, auth_env_var: event.target.value })}/><small className="admin-help">{draft.auth_configured ? "服务端已配置；密钥不会返回页面。" : "服务端尚未检测到该环境变量。"}</small></label><label className="admin-field full">输入 Schema<textarea className="code" value={inputSchema} onChange={(event) => setInputSchema(event.target.value)}/></label><label className="admin-field full">输出 Schema<textarea className="code" value={outputSchema} onChange={(event) => setOutputSchema(event.target.value)}/></label><label className="admin-field full">输出示例<textarea className="code" value={outputExample} onChange={(event) => setOutputExample(event.target.value)}/></label><div className="admin-field full"><span>引用关系</span><div className="admin-meta"><span className="admin-chip">Plans：{draft.referenced_by_plans?.join("、") || "无"}</span><span className="admin-chip">Skills：{draft.referenced_by_skills?.join("、") || "无"}</span></div></div></div>}
      {tab === "test" && <div className="admin-test"><label className="admin-field">测试输入 JSON<textarea value={testInput} onChange={(event) => setTestInput(event.target.value)}/></label><button className="admin-btn primary" disabled={busy || !draft.enabled} onClick={test}>{busy ? "执行中…" : "调用服务端 Tool"}</button>{testResult !== null && <div className="admin-result"><strong>真实输入、输出、耗时与错误</strong><pre>{JSON.stringify(testResult, null, 2)}</pre></div>}</div>}
      {tab === "history" && <div className="tool-history">
        <div className="tool-history-intro"><div><strong>测试历史</strong><p>只展示当前 Tool 的服务端真实测试记录，可查看请求、输出、错误、耗时和节点轨迹。</p></div><button className="admin-btn" disabled={historyLoading} onClick={() => void loadTestHistory(draft.id)}>{historyLoading ? "刷新中…" : "刷新"}</button></div>
        {historyLoading && !testHistory.length ? <StatePanel state="loading" message="正在读取当前 Tool 的测试记录"/> : !testHistory.length ? <StatePanel state="empty" message="当前 Tool 暂无测试记录，请先运行一次在线测试。"/> : <div className="tool-history-grid"><div className="tool-history-list">{testHistory.map((record) => <button key={record.id} className={`tool-history-row ${selectedTest?.id === record.id ? "active" : ""}`} onClick={() => setSelectedTest(record)}><div><code>{record.id}</code><strong>{new Date(record.created_at).toLocaleString("zh-CN")}</strong><small>{record.rerun_of ? `重跑自 ${record.rerun_of}` : "首次运行"}</small></div><div><span className={`tool-test-status ${record.status}`}>{record.status}</span><small>{record.duration_ms || 0}ms</small></div></button>)}</div>{selectedTest && <div className="tool-history-detail"><div className="tool-history-head"><div><code>{selectedTest.id}</code><h3>{selectedTest.tool_name}</h3></div><button className="admin-btn primary" disabled={busy || !draft.enabled} onClick={() => void rerun(selectedTest)}>{busy ? "运行中…" : "重新运行"}</button></div><label>INPUT</label><pre>{JSON.stringify(selectedTest.input, null, 2)}</pre><label>REQUEST</label><pre>{JSON.stringify(selectedTest.request ?? {}, null, 2)}</pre><label>OUTPUT / ERROR</label><pre>{JSON.stringify(selectedTest.error ? { error: selectedTest.error } : selectedTest.output, null, 2)}</pre><div className="tool-trace-head"><strong>节点轨迹</strong><span>{selectedTest.trace?.length || 0} 个事件</span></div>{selectedTest.trace?.length ? <div className="tool-trace-list">{selectedTest.trace.map((trace, index) => <div className="tool-trace-item" key={`${trace.index ?? index}-${index}`}><b>{index + 1}</b><div><strong>{trace.event || "事件"} · {trace.node_title || trace.node_type || "未命名节点"}</strong><small>{trace.content || (trace.status_code ? `HTTP ${trace.status_code}` : "完成")}</small></div></div>)}</div> : <p className="admin-help">本次测试没有返回节点级轨迹。</p>}</div>}</div>}
      </div>}
      </section>}</div></>}
  </AdminShell>;
}
