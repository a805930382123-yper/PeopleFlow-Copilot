"use client";

import { useEffect, useState } from "react";
import AdminShell, { StatePanel, Status } from "../admin/AdminShell";
import { AdminApiError, adminRequest, jsonRequest } from "../admin/api";

type Profile = { id: string; name: string; provider: string; description: string; base_url: string; api_path: string; models: string[]; requires_api_key: boolean };
type LlmConfig = { configured: boolean; provider: string; provider_description: string; profile_id: string; mode: string; model: string; global_model?: string; base_url: string; api_path: string; endpoint: string; json_mode: string; timeout_ms: number; max_retries: number; missing: string[]; api_key: { configured: boolean; env_var: string }; profiles: Profile[]; saved: boolean; last_test?: unknown };

export default function ModelsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [draft, setDraft] = useState<LlmConfig | null>(null);
  const [testResult, setTestResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const load = async () => { setLoading(true); try { const result = await adminRequest<LlmConfig>("/llm-config"); setConfig(result); setDraft(structuredClone(result)); } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "模型配置加载失败" }); } finally { setLoading(false); } };
  // Initial server synchronization.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  const switchProfile = async (profile: Profile) => { if (!draft || profile.id === draft.profile_id || !confirm(`确认切换到 ${profile.name}？后续 RunRecord 将记录新的 Provider 和模型。`)) return; setBusy(true); setNotice(null); try { const result = await adminRequest<LlmConfig>("/llm-config/switch", jsonRequest("POST", { profile_id: profile.id })); setConfig(result); setDraft(structuredClone(result)); setNotice({ tone: result.configured ? "success" : "error", text: result.configured ? `已切换到 ${profile.name}，后续运行立即生效。` : `已切换到 ${profile.name}，但配置不完整：${result.missing.join("、")}` }); } catch (error) { setNotice({ tone: "error", text: error instanceof AdminApiError ? `${error.code}：${error.message}` : "Provider 切换失败" }); } finally { setBusy(false); } };
  const save = async () => { if (!draft) return; setBusy(true); try { const result = await adminRequest<LlmConfig>("/llm-config", jsonRequest("PUT", { provider: draft.provider, profile_id: draft.profile_id, model: draft.model, base_url: draft.base_url, api_path: draft.api_path, json_mode: draft.json_mode, timeout_ms: draft.timeout_ms, max_retries: draft.max_retries })); setConfig(result); setDraft(structuredClone(result)); setNotice({ tone: result.configured ? "success" : "error", text: result.configured ? "模型运行配置已保存并立即生效。" : `配置已保存，但缺少：${result.missing.join("、")}` }); } catch (error) { setNotice({ tone: "error", text: error instanceof AdminApiError ? `${error.code}：${error.message}` : "模型配置保存失败" }); } finally { setBusy(false); } };
  const test = async () => { setBusy(true); setTestResult(null); try { const result = await adminRequest("/llm-config/test", jsonRequest("POST")); setTestResult(result); setNotice({ tone: (result as { ok?: boolean }).ok ? "success" : "error", text: (result as { ok?: boolean }).ok ? "Provider 连接测试成功。" : "Provider 测试失败，请查看结构化错误。" }); } catch (error) { setTestResult({ ok: false, error: error instanceof AdminApiError ? { code: error.code, message: error.message, details: error.details } : { message: "连接测试失败" } }); } finally { setBusy(false); } };
  const exportPlatformConfig = async () => {
    try {
      const result = await adminRequest<unknown>("/config/export");
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `peopleflow-config-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      setNotice({ tone: "success", text: "平台配置已导出，文件不包含 API Key 或 Token。" });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "配置导出失败" }); }
  };
  const importPlatformConfig = async (file?: File) => {
    if (!file || !confirm("确认导入该配置？Skill、Tool 与 Planner 配置将按文件内容更新。")) return;
    setBusy(true);
    try {
      await adminRequest("/config/import", jsonRequest("POST", JSON.parse(await file.text())));
      await load();
      setNotice({ tone: "success", text: "平台配置已导入并写入服务端。" });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "配置导入失败" }); }
    finally { setBusy(false); }
  };

  return <AdminShell embedded={embedded} active="/models" title="模型管理" description="统一管理 OpenAI-Compatible 与确定性 Fixture，密钥只保留在服务端环境变量。" badge={config && <Status enabled={config.configured}>{config.mode} · {config.model}</Status>}>
    {notice && <div className={`admin-alert ${notice.tone}`}>{notice.text}</div>}
    {loading ? <StatePanel state="loading"/> : !config || !draft ? <StatePanel state="error" message="未能读取服务端模型配置。" onRetry={load}/> : <>
      <section className={`admin-banner ${draft.mode === "fixture" ? "fixture" : !draft.configured ? "error" : ""}`}><div><h3>{draft.mode === "fixture" ? "当前为确定性演示模式" : draft.configured ? "真实模型运行模式" : "真实 Provider 配置不完整"}</h3><p>{draft.mode === "fixture" ? "Fixture 仍经过 Planner、Validator、Executor、风险审核和 RunRecord，但不代表真实大模型效果。" : draft.configured ? "后续 Planner、Skill 和 RunRecord 将使用当前 Provider。" : `缺少 ${draft.missing.join("、") || "必要配置"}，Agent Run 会返回结构化错误，不会自动降级。`}</p></div><Status enabled={draft.configured}>{draft.configured ? "配置可用" : "需要处理"}</Status></section>
      <div className="provider-grid">{draft.profiles.map((profile) => <button className={`provider-card ${profile.id === draft.profile_id ? "active" : ""}`} key={profile.id} disabled={busy} onClick={() => switchProfile(profile)}><strong>{profile.name}</strong><p>{profile.description}</p><div className="admin-meta"><span className="admin-chip">{profile.provider}</span><span className="admin-chip">{profile.requires_api_key ? "需要 API Key" : "无需密钥"}</span></div></button>)}</div>
      <section className="admin-editor"><div className="admin-editor-head"><div><h2>当前运行配置</h2><p>Provider 切换会影响后续运行，不修改历史 RunRecord。</p></div><div className="admin-actions"><button className="admin-btn" disabled={busy} onClick={test}>{busy ? "测试中…" : "测试连接"}</button><button className="admin-btn primary" disabled={busy} onClick={save}>保存并生效</button></div></div><div className="metric-row"><div><span>Provider</span><strong>{draft.provider}</strong></div><div><span>运行模式</span><strong>{draft.mode}</strong></div><div><span>密钥状态</span><strong>{draft.api_key.configured ? "已配置" : "未配置"}</strong></div><div><span>密钥环境变量</span><code>{draft.api_key.env_var}</code></div></div><div className="admin-form"><label className="admin-field">Profile<select value={draft.profile_id} onChange={(event) => { const profile = draft.profiles.find((item) => item.id === event.target.value); if (profile) void switchProfile(profile); }}>{draft.profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label><label className="admin-field">默认模型<input disabled={draft.provider === "classroom-fixture"} list="model-options" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}/><datalist id="model-options">{draft.profiles.find((item) => item.id === draft.profile_id)?.models.map((model) => <option value={model} key={model}/>)}</datalist></label><label className="admin-field full">Base URL<input disabled={draft.provider === "classroom-fixture"} value={draft.base_url || ""} onChange={(event) => setDraft({ ...draft, base_url: event.target.value })}/></label><label className="admin-field">API Path<input disabled={draft.provider === "classroom-fixture"} value={draft.api_path || ""} onChange={(event) => setDraft({ ...draft, api_path: event.target.value })}/></label><label className="admin-field">JSON Mode<select value={draft.json_mode} onChange={(event) => setDraft({ ...draft, json_mode: event.target.value })}><option value="auto">auto</option><option value="on">on</option><option value="off">off</option></select></label><label className="admin-field">超时（ms）<input type="number" min="1000" max="300000" value={draft.timeout_ms} onChange={(event) => setDraft({ ...draft, timeout_ms: Number(event.target.value) })}/></label><label className="admin-field">最大重试<input type="number" min="0" max="3" value={draft.max_retries} onChange={(event) => setDraft({ ...draft, max_retries: Number(event.target.value) })}/></label></div><p className="admin-help">密钥原文不会从服务端返回，也不会写入配置 JSON、页面、Bundle 或 RunRecord。</p>{testResult !== null && <div className="admin-result"><strong>Provider 测试结果</strong><pre>{JSON.stringify(testResult, null, 2)}</pre></div>}</section>
      <section className="admin-editor platform-config-card"><div className="admin-editor-head"><div><h2>平台配置迁移</h2><p>在统一配置中心导入或导出 Skill、Tool、Planner 等可迁移配置。</p></div><div className="admin-actions"><button className="admin-btn" disabled={busy} onClick={exportPlatformConfig}>导出配置 JSON</button><label className="admin-btn primary file-button">导入配置<input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => void importPlatformConfig(event.target.files?.[0])}/></label></div></div><p className="admin-help">导出文件不包含 LLM API Key、Coze Token、运行日志或员工敏感数据；Windows 本地版仍从 .env 读取密钥。</p></section>
    </>}
  </AdminShell>;
}
