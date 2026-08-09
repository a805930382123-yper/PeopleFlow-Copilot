"use client";

import { useEffect, useMemo, useState } from "react";
import AdminShell, { StatePanel, Status } from "../admin/AdminShell";
import { AdminApiError, adminRequest, jsonRequest } from "../admin/api";

type ToolRef = { id: string; name: string; enabled: boolean };
type Skill = { id: string; name: string; description: string; prompt: string; enabled: boolean; version: string; model: string; model_strategy: "global" | "skill"; effective_model: string; model_source: string; temperature: number; max_tokens: number; dependent_tools: string[]; output_example?: unknown; available_tools: ToolRef[]; referenced_by_plans: string[]; last_test?: { tested_at: string } };
type Version = { id: string; version: string; created_at: string; change_note: string; source: string; content: Skill; diff: { type: "added" | "removed"; line: number; text: string }[] };

export default function SkillsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Skill | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<Version | null>(null);
  const [tab, setTab] = useState<"edit" | "versions" | "test">("edit");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [testInput, setTestInput] = useState("请识别这个入职问题：我需要准备哪些报到材料？");
  const [testResult, setTestResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const load = async (preferredId?: string) => {
    setLoading(true); setNotice(null);
    try {
      const rows = await adminRequest<Skill[]>("/skills");
      setSkills(rows);
      const id = preferredId || selectedId || rows[0]?.id || "";
      const selected = rows.find((item) => item.id === id) || rows[0] || null;
      setSelectedId(selected?.id || ""); setDraft(selected ? structuredClone(selected) : null);
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Skill 加载失败" }); }
    finally { setLoading(false); }
  };
  // Initial server synchronization.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  const selectSkill = (skill: Skill) => { setSelectedId(skill.id); setDraft(structuredClone(skill)); setVersions([]); setSelectedVersion(null); setTab("edit"); setNotice(null); };
  const filtered = useMemo(() => skills.filter((skill) => (filter === "all" || String(skill.enabled) === filter) && `${skill.name} ${skill.id}`.toLowerCase().includes(query.toLowerCase())), [skills, filter, query]);
  const update = <K extends keyof Skill>(key: K, value: Skill[K]) => draft && setDraft({ ...draft, [key]: value });

  const save = async () => {
    if (!draft) return;
    setBusy(true); setNotice(null);
    try {
      const payload = structuredClone(draft) as unknown as Record<string, unknown>;
      for (const key of ["effective_model", "model_source", "available_tools", "referenced_by_plans", "last_test"]) delete payload[key];
      payload.change_note = changeNote || "管理后台更新 Skill";
      await adminRequest(`/skills/${draft.id}`, jsonRequest("PUT", payload));
      setChangeNote(""); setNotice({ tone: "success", text: "Skill 已保存，新版本已生效，旧版本快照已保留。" }); await load(draft.id);
    } catch (error) { setNotice({ tone: "error", text: error instanceof AdminApiError ? `${error.code}：${error.message}` : "Skill 保存失败，旧版本未受影响。" }); }
    finally { setBusy(false); }
  };
  const toggle = async () => { if (!draft) return; setBusy(true); try { await adminRequest(`/skills/${draft.id}/toggle`, jsonRequest("POST", { enabled: !draft.enabled, change_note: `${draft.enabled ? "禁用" : "启用"} ${draft.name}` })); await load(draft.id); } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "状态更新失败" }); } finally { setBusy(false); } };
  const loadVersions = async () => { if (!draft) return; setTab("versions"); try { const rows = await adminRequest<Version[]>(`/skills/${draft.id}/versions`); setVersions(rows); setSelectedVersion(rows[0] || null); } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "版本加载失败" }); } };
  const restore = async (version: Version) => { if (!draft || !confirm(`确认将 ${draft.name} 恢复到 v${version.version}？恢复操作会生成新版本。`)) return; setBusy(true); try { await adminRequest(`/skills/${draft.id}/versions/${version.id}/restore`, jsonRequest("POST", { change_note: `恢复到历史版本 ${version.version}` })); setNotice({ tone: "success", text: "历史版本已恢复为一个新版本。" }); await load(draft.id); setTab("edit"); } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "版本恢复失败" }); } finally { setBusy(false); } };
  const test = async () => { if (!draft) return; setBusy(true); setTestResult(null); try { setTestResult(await adminRequest(`/skills/${draft.id}/test`, jsonRequest("POST", { input: testInput }))); setNotice({ tone: "success", text: "Skill 已通过服务端统一模型链路完成测试。" }); } catch (error) { setTestResult({ ok: false, error: error instanceof AdminApiError ? { code: error.code, message: error.message, details: error.details } : { message: "测试失败" } }); } finally { setBusy(false); } };

  return <AdminShell embedded={embedded} active="/skills" title="Skill 管理" description="编辑 Prompt、模型策略与依赖，保存前自动创建版本快照。" badge={<Status enabled>{skills.filter((item) => item.enabled).length} / {skills.length} 已启用</Status>}>
    {notice && <div className={`admin-alert ${notice.tone}`}>{notice.text}</div>}
    {loading ? <StatePanel state="loading"/> : !skills.length ? <StatePanel state="empty" message="服务端尚未配置 Skill。"/> : <>
      <div className="admin-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或 Skill ID"/><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option><option value="true">仅已启用</option><option value="false">仅已禁用</option></select></div>
      <div className="admin-grid">
        <section className="admin-list-panel">{filtered.map((skill) => <button className={`admin-list-item ${selectedId === skill.id ? "active" : ""}`} key={skill.id} onClick={() => selectSkill(skill)}><div className="admin-list-head"><strong>{skill.name}</strong><Status enabled={skill.enabled}/></div><p>{skill.description}</p><div className="admin-meta"><span className="admin-chip">v{skill.version || "1.0.0"}</span><span className="admin-chip">{skill.effective_model}</span><span className="admin-chip">{skill.model_source}</span></div></button>)}{!filtered.length && <StatePanel state="empty" message="没有符合筛选条件的 Skill。"/>}</section>
        {draft && <section className="admin-editor"><div className="admin-editor-head"><div><h2>{draft.name}</h2><p>{draft.id} · v{draft.version || "1.0.0"}</p></div><div className="admin-actions"><button className="admin-btn" disabled={busy} onClick={toggle}>{draft.enabled ? "禁用" : "启用"}</button><button className="admin-btn primary" disabled={busy} onClick={save}>{busy ? "处理中…" : "保存并生效"}</button></div></div>
          <div className="admin-tabs"><button className={tab === "edit" ? "active" : ""} onClick={() => setTab("edit")}>配置与 Prompt</button><button className={tab === "versions" ? "active" : ""} onClick={loadVersions}>版本历史</button><button className={tab === "test" ? "active" : ""} onClick={() => setTab("test")}>服务端测试</button></div>
          {tab === "edit" && <><div className="admin-form"><label className="admin-field">名称<input value={draft.name} onChange={(event) => update("name", event.target.value)}/></label><label className="admin-field">启用状态<select value={String(draft.enabled)} onChange={(event) => update("enabled", event.target.value === "true")}><option value="true">已启用</option><option value="false">已禁用</option></select></label><label className="admin-field full">描述<textarea value={draft.description} onChange={(event) => update("description", event.target.value)}/></label><label className="admin-field">模型策略<select value={draft.model_strategy || "global"} onChange={(event) => update("model_strategy", event.target.value as Skill["model_strategy"])}><option value="global">跟随全局模型</option><option value="skill">Skill 独立模型</option></select></label><label className="admin-field">模型名称<input disabled={draft.model_strategy !== "skill"} value={draft.model || ""} onChange={(event) => update("model", event.target.value)}/><small className="admin-help">实际生效：{draft.effective_model} · {draft.model_source}</small></label><label className="admin-field">Temperature<input type="number" min="0" max="2" step="0.1" value={draft.temperature} onChange={(event) => update("temperature", Number(event.target.value))}/></label><label className="admin-field">Token 上限<input type="number" min="32" max="32768" value={draft.max_tokens} onChange={(event) => update("max_tokens", Number(event.target.value))}/></label><label className="admin-field full">依赖 Tool<div className="admin-checks">{draft.available_tools.map((tool) => <span className="admin-check" key={tool.id}><input type="checkbox" checked={(draft.dependent_tools || []).includes(tool.id)} onChange={(event) => update("dependent_tools", event.target.checked ? [...(draft.dependent_tools || []), tool.id] : (draft.dependent_tools || []).filter((id) => id !== tool.id))}/>{tool.name}{!tool.enabled && "（已禁用）"}</span>)}</div></label><label className="admin-field full">Prompt 正文<textarea className="prompt" value={draft.prompt} onChange={(event) => update("prompt", event.target.value)}/></label><label className="admin-field full">输出示例 JSON<textarea className="code" value={JSON.stringify(draft.output_example || {}, null, 2)} onChange={(event) => { try { update("output_example", JSON.parse(event.target.value)); } catch {} }}/></label></div><div className="admin-savebar"><label className="admin-field">变更说明<input value={changeNote} onChange={(event) => setChangeNote(event.target.value)} placeholder="例如：补充入职材料识别约束"/></label><button className="admin-btn primary" disabled={busy} onClick={save}>保存并创建版本</button></div></>}
          {tab === "versions" && <>{versions.length ? <div className="two-column"><div className="admin-version-list">{versions.map((version) => <button className="admin-version" key={version.id} onClick={() => setSelectedVersion(version)}><strong>v{version.version}</strong><small>{new Date(version.created_at).toLocaleString()}</small><p>{version.change_note}</p></button>)}</div>{selectedVersion && <div><h3>v{selectedVersion.version} · Prompt diff</h3><div className="admin-diff">{selectedVersion.diff.length ? selectedVersion.diff.map((line, index) => <div className={line.type} key={`${line.type}-${line.line}-${index}`}>{line.type === "added" ? "+" : "-"} {line.line} {line.text}</div>) : "与当前 Prompt 无差异"}</div><button className="admin-btn" disabled={busy} onClick={() => restore(selectedVersion)}>恢复为新版本</button></div>}</div> : <StatePanel state="empty" message="首次修改并保存后会产生版本快照。"/>}</>}
          {tab === "test" && <div className="admin-test"><label className="admin-field">测试输入<textarea value={testInput} onChange={(event) => setTestInput(event.target.value)}/></label><button className="admin-btn primary" disabled={busy || !draft.enabled} onClick={test}>{busy ? "测试中…" : "调用服务端 Skill"}</button>{testResult !== null && <div className="admin-result"><strong>真实测试结果</strong><pre>{JSON.stringify(testResult, null, 2)}</pre></div>}</div>}
        </section>}
      </div></>}
  </AdminShell>;
}
