"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import "./run-detail.css";

type ValidationIssue = { code: string; capability_id?: string | null; message: string; severity: string };
type Step = { step_id?: string; id?: string; name?: string; capability_id: string; kind: string; goal?: string; status: string; duration_ms?: number; attempts?: number; input?: unknown; output?: unknown; error?: unknown; provider?: string | null; model?: string | null };
type Run = {
  id: string; question: string; source?: string; employee_id?: string; created_at: string; updated_at?: string; status?: string; final_reply?: string | null;
  provider?: string; model?: string; mode?: string; duration_ms?: number; plan?: { name?: string; rationale?: string; route_decision?: { label?: string; reason?: string; confidence?: number }; selected_skills?: string[]; selected_tools?: string[]; mandatory_capabilities?: string[] };
  plan_validation?: { valid: boolean; action?: string; errors?: ValidationIssue[]; warnings?: ValidationIssue[] };
  steps?: Step[]; evidence?: { title: string; category?: string; source?: string; source_id?: string; version?: string }[];
  risk_review?: { risk_level?: string; passed?: boolean; review_decision?: string; issues?: unknown[]; suggestions?: string[] };
  error?: { code?: string; message?: string; details?: unknown } | null; handoff?: { id: string; status: string; assigned_to?: string } | null;
  annotations?: { id: string; tags?: string[]; issue?: string; expected_answer?: string; author?: string; created_at: string }[];
  skill_versions?: Record<string, string>; tool_versions?: Record<string, string>;
};

const API = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8787/api";
const Json = ({ value }: { value: unknown }) => <pre>{JSON.stringify(value, null, 2)}</pre>;

export default function RunDetailPage() {
  const params = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [issue, setIssue] = useState("");
  const [expectedAnswer, setExpectedAnswer] = useState("");
  const runId = typeof params?.runId === "string" ? decodeURIComponent(params.runId) : "";

  const request = useCallback(async (path: string, options?: RequestInit) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${API}${path}`, { ...options, signal: options?.signal || controller.signal });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const serverError = result?.error;
        throw new Error(typeof serverError === "string" ? serverError : serverError?.message || "请求失败");
      }
      return result;
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") throw new Error("读取运行记录超时，请检查本地服务是否正常运行。");
      throw caught;
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    if (!runId) { setError("运行记录地址缺少 Run ID。"); setLoading(false); return; }
    try { setRun(await request(`/runs/${runId}`)); setError(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "加载失败"); }
    finally { setLoading(false); }
  }, [request, runId]);

  // Initial server synchronization is an external-system effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const action = async (name: string, path: string, body: unknown) => {
    setBusy(name);
    try {
      const result = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (name === "retry") window.location.href = `/runs/${result.id}`;
      else await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); }
    finally { setBusy(""); }
  };

  if (loading) return <main className="run-page"><div className="loading">正在读取运行记录...</div></main>;
  if (error && !run) return <main className="run-page"><Link href="/">← 返回工作台</Link><section className="run-error"><h1>运行记录无法打开</h1><p>{error}</p><button onClick={() => void load()}>重新读取</button></section></main>;
  if (!run) return <main className="run-page"><Link href="/">← 返回工作台</Link><section className="run-error"><h1>没有找到运行记录</h1><p>请返回执行日志重新选择一条记录。</p></section></main>;

  const risk = run.risk_review?.risk_level || "unknown";
  return <main className="run-page">
    <header className="run-top"><Link href="/">← 返回工作台</Link><div><span>RUN DETAIL</span><strong>{run.id}</strong></div><button disabled={busy === "retry"} onClick={() => action("retry", `/runs/${run.id}/retry`, {})}>{busy === "retry" ? "重试中…" : "重试运行"}</button></header>
    <section className="run-hero"><div><p>{run.source || "workbench"} · {new Date(run.created_at).toLocaleString("zh-CN")}</p><h1>{run.question}</h1><div className="run-chips"><span className={`status ${run.status}`}>{run.status || "unknown"}</span><span className={`risk ${risk}`}>{risk} risk</span><span>{run.provider || "unknown provider"}</span><span>{run.model || "unknown model"}</span><span>{run.duration_ms || 0}ms</span></div></div><aside><small>最终回复</small><p>{run.final_reply || "本次运行没有生成可展示回复。"}</p></aside></section>

    <div className="run-grid">
      <section className="run-card"><h2>Plan 与校验</h2><div className="route"><strong>{run.plan?.route_decision?.label || run.plan?.name || "历史 Plan"}</strong><span>{run.plan?.route_decision?.reason || run.plan?.rationale}</span></div><h3>选择的 Skills</h3><div className="token-row">{(run.plan?.selected_skills || Object.keys(run.skill_versions || {})).map((item) => <span key={item}>{item}</span>)}</div><h3>选择的 Tools</h3><div className="token-row">{(run.plan?.selected_tools || Object.keys(run.tool_versions || {})).map((item) => <span key={item}>{item}</span>)}</div><div className={`validation ${run.plan_validation?.valid ? "valid" : "invalid"}`}><strong>{run.plan_validation?.valid ? "Plan Validator：通过" : "Plan Validator：未通过或旧记录无校验结果"}</strong>{run.plan_validation?.errors?.map((item) => <p key={`${item.code}-${item.capability_id}`}>{item.code} · {item.message}</p>)}</div></section>
      <section className="run-card"><h2>风险审核</h2><div className={`risk-panel ${risk}`}><strong>{risk.toUpperCase()}</strong><span>{run.risk_review?.review_decision || (run.risk_review?.passed ? "pass" : "needs review")}</span></div>{run.risk_review?.issues?.map((item, index) => <p key={index}>{typeof item === "string" ? item : JSON.stringify(item)}</p>)}{run.risk_review?.suggestions?.map((item) => <p key={item}>建议：{item}</p>)}{run.error && <div className="error-box"><strong>{run.error.code || "RUN_ERROR"}</strong><p>{run.error.message}</p></div>}{run.handoff && <div className="handoff-box">已转交 {run.handoff.assigned_to || "人工处理"} · {run.handoff.status}</div>}<button className="secondary" disabled={busy === "handoff"} onClick={() => action("handoff", `/runs/${run.id}/handoff`, { reason: "运行详情页人工接管" })}>标记人工接管</button></section>
    </div>

    <section className="run-card trace"><h2>执行 Trace</h2>{run.steps?.length ? run.steps.map((step, index) => <details key={step.step_id || step.id || index}><summary><b>{index + 1}</b><span><strong>{step.name || step.capability_id}</strong><small>{step.kind} · {step.capability_id}</small></span><em className={step.status}>{step.status}</em><time>{step.duration_ms || 0}ms · {step.attempts || 1}次</time></summary><div className="io"><div><label>INPUT</label><Json value={step.input}/></div><div><label>OUTPUT / ERROR</label><Json value={step.error || step.output}/></div></div></details>) : <p>该历史记录没有保存步骤。</p>}</section>

    <div className="run-grid">
      <section className="run-card"><h2>回答依据</h2>{run.evidence?.length ? run.evidence.map((item) => <article className="evidence" key={`${item.source}-${item.source_id}-${item.title}`}><span>{item.category || "知识"}</span><strong>{item.title}</strong><small>{item.source}{item.source_id ? ` · ${item.source_id}` : ""}{item.version ? ` · v${item.version}` : ""}</small></article>) : <p>没有可展示的证据记录。</p>}</section>
      <section className="run-card"><h2>人工标注</h2><textarea value={issue} onChange={(event) => setIssue(event.target.value)} placeholder="记录答非所问、风险误判或缺少证据等问题"/><textarea value={expectedAnswer} onChange={(event) => setExpectedAnswer(event.target.value)} placeholder="可选：填写期望答案"/><button disabled={!issue.trim() || busy === "annotate"} onClick={() => action("annotate", `/runs/${run.id}/annotate`, { tags: ["人工复核"], issue, expected_answer: expectedAnswer, add_to_bad_case: true })}>保存并加入 Bad Case</button>{run.annotations?.map((item) => <article className="annotation" key={item.id}><strong>{item.tags?.join("、") || "标注"}</strong><p>{item.issue}</p><small>{item.author} · {new Date(item.created_at).toLocaleString("zh-CN")}</small></article>)}</section>
    </div>
  </main>;
}
