"use client";

import { useEffect, useRef, useState } from "react";
import { apiRequest, jsonRequest } from "./admin/api";

type Person = { id: string; name: string; department: string; position: string; manager: string; hr_partner: string };
type Evidence = { title: string; version?: string };
type Message = { id: string; role: string; content: string; evidence?: Evidence[] };
type Task = { id: string; name: string; description: string; owner: string; recommended_time: string; completed: boolean; blocked_by: string[] };
type Case = { id: string; question: string; assigned_to: string; status: string; note?: string; created_at: string; updated_at?: string };
type EmployeeData = { employee: Person; progress: number; tasks: Task[]; conversations: { id: string; name: string; messages: Message[] }[]; handoffs: Case[] };
const statusNames: Record<string, string> = { open: "待受理", processing: "处理中", resolved: "已解决" };
const suggestions = ["我今天需要完成哪些入职事项？", "电脑和账号应该找谁办理？", "公司的请假流程是什么？"];

export default function EmployeeWorkspace({ view, employees, employeeId, onEmployeeChange, navigate }: { view: string; employees: Person[]; employeeId: string; onEmployeeChange: (id: string) => void; navigate: (view: string) => void }) {
  const [data, setData] = useState<EmployeeData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState("pending");
  const identity = useRef(employeeId);
  identity.current = employeeId;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setConversationId(""); setMessages([]); setQuestion(""); setNotice(""); setBusy(false);
  }, [employeeId]);
  useEffect(() => {
    if (!employeeId) { setLoading(false); return; }
    let ignore = false;
    setLoading(true); setError(""); setData(null);
    apiRequest<EmployeeData>(`/employee-workspace/${encodeURIComponent(employeeId)}`).then((result) => { if (!ignore) setData(result); }).catch((err) => { if (!ignore) setError(err.message); }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [employeeId, reload, view]);
  useEffect(() => { if (messages.length) end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages]);
  const refresh = () => setReload((value) => value + 1);
  const send = async (handoff = false) => {
    const text = question.trim() || (handoff ? [...messages].reverse().find((item) => item.role === "user")?.content || "" : "");
    if (!text || !employeeId || busy) return;
    const currentId = employeeId;
    setBusy(true); setError(""); setNotice("");
    try {
      if (handoff) {
        const result = await apiRequest<{ id: string }>(`/employee-workspace/${encodeURIComponent(currentId)}/handoff`, jsonRequest("POST", { question: text, conversation_id: conversationId || undefined }));
        if (identity.current !== currentId) return;
        setNotice(`已提交人工协助。可在“处理进度”查看回复，编号 ${result.id}。`); refresh();
      } else {
        const result = await apiRequest<{ conversation_id: string; reply: string; evidence: Evidence[]; handoff: { id: string } | null }>(`/employee-workspace/${encodeURIComponent(currentId)}/ask`, { ...jsonRequest("POST", { question: text, conversation_id: conversationId || undefined }), timeoutMs: 180000, timeoutMessage: "回答等待超时，请先刷新查看会话或处理进度，避免重复提交。" });
        if (identity.current !== currentId) return;
        setMessages((items) => [...items, { id: `u-${Date.now()}`, role: "user", content: text }, { id: `a-${Date.now()}`, role: "assistant", content: result.reply, evidence: result.evidence }]);
        setConversationId(result.conversation_id); setQuestion("");
        if (result.handoff) setNotice("该问题已转交人工，请在处理进度中查看后续结果。");
        refresh();
      }
    } catch (err) { if (identity.current === currentId) setError(err instanceof Error ? err.message : "提交失败，请重试"); }
    finally { if (identity.current === currentId) setBusy(false); }
  };
  const tasks = data?.tasks.filter((task) => filter === "all" || (filter === "done" ? task.completed : !task.completed)) || [];
  return <div className="page service-page">
    <div className="service-identity"><label>体验身份<select aria-label="选择体验员工" disabled={busy || !employees.length} value={employeeId} onChange={(event) => onEmployeeChange(event.target.value)}><option value="" disabled>请选择员工</option>{employees.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.department}</option>)}</select></label><span>演示身份 · 使用模拟员工资料</span><button className="secondary" disabled={loading || busy} onClick={refresh}>刷新数据</button></div>
    {error && <div className="service-error" role="alert">{error}<button onClick={refresh} disabled={busy}>重新加载</button></div>}
    {notice && <div className="service-notice" role="status">{notice}</div>}
    {view === "employee-chat" && <>
      <div className="page-heading"><div><h1>{data?.employee.name ? `${data.employee.name}，有什么需要帮忙？` : "有什么需要帮忙？"}</h1><p>查询企业制度、了解办理步骤，或联系人工协助。</p></div></div>
      <div className="employee-columns"><section className="panel employee-chat">
        <div className="employee-chat-toolbar"><label>对话<select aria-label="选择历史对话" disabled={busy} value={conversationId} onChange={(event) => { setConversationId(event.target.value); setMessages(data?.conversations.find((item) => item.id === event.target.value)?.messages || []); setNotice(""); }}><option value="">新对话</option>{data?.conversations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="secondary" disabled={busy} onClick={() => { setConversationId(""); setMessages([]); setNotice(""); }}>新建对话</button></div>
        <div className="employee-messages" aria-live="polite">{!messages.length && <div className="employee-welcome"><strong>从一件具体的事开始</strong><p>告诉我你想办什么，我会结合企业资料为你查找答案。</p><div className="employee-suggestions">{suggestions.map((text) => <button key={text} disabled={busy} onClick={() => setQuestion(text)}>{text}</button>)}</div></div>}{messages.map((message) => <article className={`employee-message ${message.role}`} key={message.id}><small>{message.role === "user" ? "我" : "员工服务助手"}</small><div>{message.content}</div>{Boolean(message.evidence?.length) && <details><summary>查看回答依据</summary>{message.evidence?.map((item, index) => <p key={index}>{item.title}{item.version ? ` · ${item.version}` : ""}</p>)}</details>}</article>)}{busy && <p className="muted" role="status">正在处理，请稍候…</p>}<div ref={end}/></div>
        <form className="employee-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}><label htmlFor="employee-question">你的问题</label><textarea id="employee-question" maxLength={3000} value={question} disabled={busy} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：我的电脑还没有领取，应该联系谁？"/><div><button type="button" className="secondary" disabled={busy || !data || (!question.trim() && !messages.length)} onClick={() => void send(true)}>申请人工协助</button><button className="primary compact" disabled={busy || !data || !question.trim()}>{busy ? "处理中…" : "发送问题"}</button></div><small>请勿在对话中填写密码、身份证号或银行卡号。</small></form>
      </section><aside className="employee-aside"><section className="panel"><h2>我的入职待办</h2><strong className="service-count">{data ? data.tasks.filter((item) => !item.completed).length : "—"}<small> 项待完成</small></strong><p>已完成 {data ? Math.round(data.progress * 100) : 0}%</p><progress aria-label="入职完成进度" max={1} value={data?.progress || 0}/><button className="secondary wide" onClick={() => navigate("employee-tasks")}>查看我的待办</button></section><section className="panel"><h2>需要找人帮忙？</h2><dl><dt>HR 对接人</dt><dd>{data?.employee.hr_partner || "待加载"}</dd><dt>直属负责人</dt><dd>{data?.employee.manager || "待加载"}</dd></dl><button className="secondary wide" onClick={() => navigate("employee-progress")}>查看处理进度</button></section></aside></div>
    </>}
    {view === "employee-tasks" && <><div className="page-heading"><div><h1>我的待办</h1><p>按入职安排完成事项；完成状态以业务记录为准。</p></div><div className="service-filters" aria-label="待办筛选">{[["pending", "待完成"], ["done", "已完成"], ["all", "全部"]].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div></div>{loading ? <div className="panel service-empty">正在加载待办…</div> : tasks.length ? <section className="panel service-list">{tasks.map((task) => <article key={task.id}><div><span className={`service-status ${task.completed ? "resolved" : "open"}`}>{task.completed ? "已完成" : task.blocked_by.length ? "等待前置事项" : "待办理"}</span><h2>{task.name}</h2><p>{task.description}</p><small>负责人：{task.owner}　建议时间：{task.recommended_time}</small>{!task.completed && Boolean(task.blocked_by.length) && <p>先完成：{task.blocked_by.map((id) => data?.tasks.find((item) => item.id === id)?.name || id).join("、")}</p>}</div><button className="secondary" onClick={() => { setQuestion(`请问“${task.name}”具体如何办理？`); navigate("employee-chat"); }}>咨询办理方式</button></article>)}</section> : <div className="panel service-empty">{error ? "待办暂时不可用，请重新加载。" : "当前没有这类待办。"}</div>}</>}
    {view === "employee-progress" && <><div className="page-heading"><div><h1>处理进度</h1><p>查看人工受理状态和最新处理结果。</p></div></div>{loading ? <div className="panel service-empty">正在加载处理记录…</div> : data?.handoffs.length ? <section className="panel service-list">{data.handoffs.map((item) => <article key={item.id}><div><span className={`service-status ${item.status}`}>{statusNames[item.status] || item.status}</span><h2>{item.question}</h2><small>负责人：{item.assigned_to} · 提交于 {new Date(item.created_at).toLocaleString("zh-CN")}</small><p className="service-result">{item.note || (item.status === "resolved" ? "已标记解决，处理说明尚未填写。" : "受理后会在此更新处理结果，请稍后刷新查看。")}</p><small>编号：{item.id}</small></div></article>)}</section> : <div className="panel service-empty">{error ? "处理记录暂时不可用，请重试。" : "暂无人工处理记录。遇到问题时，可以在问问助手中申请人工协助。"}<button className="secondary" onClick={() => navigate("employee-chat")}>去问问助手</button></div>}</>}
  </div>;
}
