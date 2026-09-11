"use client";

import { useEffect, useState } from "react";
import { apiRequest, jsonRequest } from "./admin/api";

type RecordItem = { id: string; [key: string]: unknown };
type EnterpriseData = { members: RecordItem[]; tasks: RecordItem[]; contacts: RecordItem[]; handoffs: RecordItem[] };
const fieldLabels: Record<string, string> = { name: "姓名 / 名称", department: "部门", position: "岗位", manager: "直属负责人", hr_partner: "HR 对接人", owner: "办理负责人", description: "办理说明", recommended_time: "建议办理时间", deadline_days: "入职后期限（天）", role: "职责", email: "邮箱", channel: "联系渠道", assigned_to: "处理负责人", status: "处理状态", note: "处理结果 / 回复员工" };
const editable: Record<string, string[]> = { members: ["name", "department", "position", "manager", "hr_partner"], tasks: ["name", "owner", "description", "recommended_time", "deadline_days"], contacts: ["name", "role", "department", "email", "channel"], handoffs: ["assigned_to", "status", "note"] };
const titles: Record<string, string> = { members: "成员与分工", "service-settings": "办事配置", handoffs: "员工请求" };
const statuses: Record<string, string> = { open: "待受理", processing: "处理中", resolved: "已解决" };
const string = (value: unknown) => String(value ?? "");

export default function EnterpriseWorkspace({ view, notify, onReload }: { view: string; notify: (message: string) => void; onReload: () => Promise<void> }) {
  const [data, setData] = useState<EnterpriseData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("tasks");
  const [filter, setFilter] = useState("open");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<RecordItem | null>(null);
  const [formError, setFormError] = useState("");
  const [reload, setReload] = useState(0);
  const kind = view === "service-settings" ? tab : view === "members" ? "members" : "handoffs";
  useEffect(() => {
    let ignore = false; setLoading(true); setError("");
    apiRequest<EnterpriseData>("/enterprise-workspace").then((result) => { if (!ignore) setData(result); }).catch((err) => { if (!ignore) setError(err.message); }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [reload]);
  const rows = (data?.[kind as keyof EnterpriseData] || []).filter((item) => (kind !== "handoffs" || filter === "all" || (filter === "open" ? item.status !== "resolved" : item.status === "resolved")) && (!query || [item.name, item.department, item.position, item.question, item.assigned_to, item.owner, item.role].some((value) => string(value).toLowerCase().includes(query.toLowerCase()))));
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!editing || busy) return;
    setBusy(true); setFormError("");
    const patch = Object.fromEntries(editable[kind].map((key) => [key, key === "deadline_days" ? Number(editing[key]) : string(editing[key])]));
    try {
      const result = await apiRequest<RecordItem>(`/enterprise-workspace/${kind}/${encodeURIComponent(editing.id)}`, jsonRequest("PATCH", patch));
      setData((current) => current ? { ...current, [kind]: current[kind as keyof EnterpriseData].map((row) => row.id === result.id ? result : row) } : current);
      setEditing(null); notify(kind === "handoffs" ? "处理结果已保存，员工可在处理进度中查看" : "配置已保存并生效");
      void onReload();
    } catch (err) { setFormError(err instanceof Error ? err.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  };
  return <div className="page service-page">
    <div className="page-heading"><div><h1>{titles[view]}</h1><p>{view === "members" ? "维护员工资料和对接人员，让助手找到正确的负责人。" : view === "handoffs" ? "受理员工问题，填写处理结果，员工可在处理进度中查看。" : "维护入职事项和服务联系人，保存后供助手查询使用。"}</p></div><button className="secondary" disabled={busy || loading} onClick={() => setReload((value) => value + 1)}>刷新数据</button></div>
    {view === "members" && <div className="service-scope-note">当前为单企业演示，成员分工用于业务联系。真实登录和角色访问控制尚未接入。</div>}
    <div className="service-controls"><label className="service-search">搜索<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={kind === "members" ? "姓名、部门或岗位" : kind === "handoffs" ? "问题或负责人" : "名称或负责人"}/></label>{view === "service-settings" && <div className="service-filters" aria-label="办事配置类型">{[["tasks", "入职事项"], ["contacts", "服务联系人"]].map(([id, label]) => <button key={id} disabled={busy} aria-pressed={tab === id} onClick={() => { setTab(id); setQuery(""); setEditing(null); }}>{label}</button>)}</div>}{kind === "handoffs" && <div className="service-filters" aria-label="员工请求筛选">{[["open", "待处理"], ["resolved", "已解决"], ["all", "全部"]].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>}<span>{rows.length} 条记录</span></div>
    {error && <div className="service-error" role="alert">{error}<button onClick={() => setReload((value) => value + 1)}>重试</button></div>}
    {editing && <section className="panel service-editor" aria-labelledby="record-editor-title"><div className="service-editor-head"><div><h2 id="record-editor-title">{kind === "handoffs" ? "处理员工请求" : "编辑资料"}</h2><p>{string(editing.name || editing.question)}</p></div><button className="secondary" disabled={busy} onClick={() => setEditing(null)}>取消编辑</button></div><form onSubmit={save}><div className="service-edit-grid">{editable[kind].map((key) => <label key={key} className={["description", "note"].includes(key) ? "full" : ""}>{fieldLabels[key]}{key === "status" ? <select value={string(editing[key])} disabled={busy} onChange={(event) => setEditing({ ...editing, [key]: event.target.value })}>{Object.entries(statuses).map(([id, title]) => <option value={id} key={id}>{title}</option>)}</select> : ["description", "note"].includes(key) ? <textarea maxLength={2000} value={string(editing[key])} disabled={busy} required={key === "description" || editing.status === "resolved"} onChange={(event) => setEditing({ ...editing, [key]: event.target.value })}/> : <input type={key === "deadline_days" ? "number" : key === "email" ? "email" : "text"} min={key === "deadline_days" ? 0 : undefined} max={key === "deadline_days" ? 365 : undefined} maxLength={160} required={key !== "email"} value={string(editing[key])} disabled={busy} onChange={(event) => setEditing({ ...editing, [key]: event.target.value })}/>}</label>)}</div>{kind === "handoffs" && <p className="service-editor-help">处理说明会展示给该员工。请填写办理结果或下一步安排，避免包含内部备注和敏感信息。</p>}{formError && <p className="service-error" role="alert">{formError}</p>}<div className="service-editor-actions"><button className="primary compact" disabled={busy}>{busy ? "正在保存…" : kind === "handoffs" ? "保存并更新员工进度" : "保存修改"}</button></div></form></section>}
    {loading && !data ? <div className="panel service-empty">正在加载企业资料…</div> : !rows.length ? <div className="panel service-empty">{error ? "资料加载失败，请重试。" : query ? "没有符合搜索条件的记录。" : "当前没有这类记录。"}</div> : <section className="panel service-list">{rows.map((item) => <article key={item.id}><div>{kind === "handoffs" && <span className={`service-status ${string(item.status)}`}>{statuses[string(item.status)] || string(item.status)}</span>}<h2>{string(item.name || item.question)}</h2>{kind === "members" && <><p>{string(item.department)} · {string(item.position)}</p><small>直属负责人：{string(item.manager)}　HR 对接人：{string(item.hr_partner)}</small></>}{kind === "tasks" && <><p>{string(item.description)}</p><small>负责人：{string(item.owner)}　建议时间：{string(item.recommended_time)}　期限：入职后 {string(item.deadline_days)} 天</small></>}{kind === "contacts" && <><p>{string(item.department)} · {string(item.role)}</p><small>{string(item.channel)}　{string(item.email)}</small></>}{kind === "handoffs" && <><p>员工：{string(data?.members.find((person) => person.id === item.employee_id)?.name || item.employee_id)}　负责人：{string(item.assigned_to)}</p><small>提交于 {new Date(string(item.created_at)).toLocaleString("zh-CN")} · {item.id}</small>{Boolean(item.note) && <p className="service-result">{string(item.note)}</p>}</>}</div><button className="secondary" disabled={busy} onClick={() => { setEditing({ ...item }); setFormError(""); window.scrollTo({ top: 0, behavior: "smooth" }); }}>{kind === "handoffs" ? "处理 / 回复" : "编辑"}</button></article>)}</section>}
  </div>;
}
