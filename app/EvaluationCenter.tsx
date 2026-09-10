"use client";

import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "./admin/api";

type KeywordRule = { all: string[]; any: string[]; groups: string[][] };
type EvidenceRule = { required: boolean; categories: string[]; sourceIds: string[]; minCount: number };
type RiskRule = { inputRiskLevel: string; replyShouldBeSafe: boolean; replyAllowed: boolean; handoffRequired: boolean; mustRefuseDisclosure?: boolean };
type FailureDetail = {
  code: string;
  category: string;
  dimension: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
};

export type EvaluationCase = {
  id: string;
  name?: string;
  question: string;
  employeeId?: string;
  conversationHistory?: unknown[];
  suite?: "core" | "bad_case";
  isBadCase?: boolean;
  scenario?: string;
  category: string;
  difficulty?: "easy" | "medium" | "hard";
  inputRiskLevel?: string;
  expectedBehavior?: string;
  expectedReply?: string;
  failure_mode?: string;
  expectedKeywords?: KeywordRule;
  forbiddenWords?: string[];
  expectedFacts?: Record<string, unknown>;
  forbiddenFacts?: Record<string, unknown>;
  expectedEvidence?: EvidenceRule;
  expectedRiskResult?: RiskRule;
  requiredCapabilities?: string[];
  forbiddenCapabilities?: string[];
  expectedSkills?: string[];
  expectedTools?: string[];
  evalDimensions?: string[];
  llmJudgeEnabled?: boolean;
  tags?: string[];
  enabled?: boolean;
  sourceRunId?: string | null;
  expected_any?: string[];
  expected_none?: string[];
  expected_risk?: string;
};

type ScoreResult = {
  status: "PASS" | "FAIL" | "REVIEW" | "ERROR";
  passed: boolean;
  overallScore: number | null;
  reason: string;
  keywordHits: string[];
  keywordMisses: string[];
  forbiddenHits: string[];
  matchedFacts: { key: string; value: string }[];
  mismatchedFacts: { key: string; value: string }[];
  capabilityHits: string[];
  capabilityMisses: string[];
  forbiddenCapabilityHits: string[];
  evidenceHits: string[];
  evidenceMisses: string[];
  inputRiskLevel: string;
  detectedInputRiskLevel: string;
  replySafetyPassed: boolean;
  replyAllowed: boolean;
  handoffExpected: boolean;
  handoffTriggered: boolean;
  dimensionScores: Record<string, number>;
  failureDetails?: FailureDetail[];
  runId: string | null;
  error?: { code?: string; message?: string } | null;
};

type EvaluationCaseRun = {
  id: string;
  caseId: string;
  batchId?: string | null;
  runId: string | null;
  question: string;
  employeeId: string;
  status: "PASS" | "FAIL" | "REVIEW" | "ERROR";
  passed: boolean;
  agentStatus: string;
  finalReply: string | null;
  plan?: { selected_skills?: string[]; selected_tools?: string[]; steps?: unknown[] } | null;
  trace: { id?: string; capability_id?: string; name?: string; status?: string; duration_ms?: number; input?: unknown; output?: unknown; error?: unknown }[];
  evidence: { title?: string; category?: string; source?: string; source_id?: string }[];
  riskResult?: { risk_level?: string; passed?: boolean; issues?: unknown[] } | null;
  scoreResult: ScoreResult;
  provider?: string | null;
  model?: string | null;
  createdAt: string;
  durationMs: number;
  error?: { code?: string; message?: string } | null;
};

export type EvaluationRun = {
  id: string;
  name?: string;
  suite?: "core" | "bad_case" | "all";
  created_at: string;
  total: number;
  passed: number;
  failed?: number;
  review?: number;
  error?: number;
  pass_rate: number;
  route_accuracy: number;
  risk_accuracy: number;
  availability_rate?: number;
  duration_ms?: number;
  provider?: string | null;
  model?: string | null;
  quality_gate?: { passed: boolean };
  failure_summary?: { category: string; count: number }[];
  eval_runs?: EvaluationCaseRun[];
  failures?: unknown[];
};

type Overview = {
  cases: EvaluationCase[];
  batches: EvaluationRun[];
  runs: EvaluationCaseRun[];
  skills: { id: string; name: string; enabled: boolean }[];
  tools: { id: string; name: string; enabled: boolean; type?: string }[];
  categories: string[];
  dimensions: string[];
};

type CaseDraft = {
  id?: string;
  name: string;
  question: string;
  employeeId: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  inputRiskLevel: string;
  expectedBehavior: string;
  expectedReply: string;
  requiredCapabilities: string;
  forbiddenCapabilities: string;
  keywordAll: string;
  keywordAny: string;
  forbiddenWords: string;
  expectedFacts: string;
  forbiddenFacts: string;
  evidenceCategories: string;
  evidenceSourceIds: string;
  evalDimensions: string;
  tags: string;
  evidenceRequired: boolean;
  expectHandoff: boolean;
  llmJudgeEnabled: boolean;
  enabled: boolean;
  isBadCase: boolean;
};

const emptyDraft: CaseDraft = { name: "", question: "", employeeId: "E001", category: "unknown", difficulty: "medium", inputRiskLevel: "low", expectedBehavior: "", expectedReply: "", requiredCapabilities: "reply_generation, risk_review", forbiddenCapabilities: "", keywordAll: "", keywordAny: "", forbiddenWords: "", expectedFacts: "{}", forbiddenFacts: "{}", evidenceCategories: "", evidenceSourceIds: "", evalDimensions: "intentAccuracy, answerRelevance, factualAccuracy, capabilityRouting, evidenceGrounding, riskSafety", tags: "", evidenceRequired: true, expectHandoff: false, llmJudgeEnabled: false, enabled: true, isBadCase: false };
const categoryNames: Record<string, string> = { materials: "入职材料", tasks: "入职任务", policy: "制度政策", sensitive: "敏感信息", contact: "联系人", training: "培训学习", coze: "Coze 工作流", unknown: "知识边界", system: "系统与权限", context: "多轮上下文", "答非所问": "答非所问", "敏感信息": "敏感信息" };
const dimensionNames: Record<string, string> = { intentAccuracy: "意图准确", answerRelevance: "回答相关", factualAccuracy: "事实准确", capabilityRouting: "能力路由", evidenceGrounding: "知识依据", riskSafety: "风险安全", responseCompleteness: "回答完整" };
const failureCategoryNames: Record<string, string> = { capability: "能力编排", answer: "回答内容", fact: "事实准确性", evidence: "知识依据", risk: "风险合规", system: "系统执行", other: "其他问题" };

function csv(value: string) { return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean); }
function statusClass(status?: string) { return status === "PASS" ? "green" : status === "FAIL" || status === "ERROR" ? "red" : status === "REVIEW" ? "orange" : "neutral"; }
function riskLabel(risk?: string) { return risk === "critical" ? "严重" : risk === "high" ? "高风险" : risk === "medium" ? "中风险" : "低风险"; }

function failureDetailsFor(run: EvaluationCaseRun): FailureDetail[] {
  if (run.scoreResult.failureDetails?.length) return run.scoreResult.failureDetails;
  if (run.status === "PASS") return [];
  if (run.status === "ERROR") return [{
    code: run.error?.code || "AGENT_RUN_ERROR",
    category: "system",
    dimension: "systemAvailability",
    message: run.error?.message || run.scoreResult.reason || "Agent 执行失败",
  }];
  const details: FailureDetail[] = [];
  if (run.scoreResult.capabilityMisses?.length) details.push({ code: "CAPABILITY_MISSING", category: "capability", dimension: "capabilityRouting", message: `缺少能力：${run.scoreResult.capabilityMisses.join("、")}` });
  if (run.scoreResult.forbiddenCapabilityHits?.length) details.push({ code: "FORBIDDEN_CAPABILITY_USED", category: "capability", dimension: "capabilityRouting", message: `错误调用：${run.scoreResult.forbiddenCapabilityHits.join("、")}` });
  if (run.scoreResult.keywordMisses?.length) details.push({ code: "KEYWORD_MISSING", category: "answer", dimension: "answerRelevance", message: `关键词缺失：${run.scoreResult.keywordMisses.join("、")}` });
  if (run.scoreResult.forbiddenHits?.length) details.push({ code: "FORBIDDEN_CONTENT_HIT", category: "answer", dimension: "factualAccuracy", message: `命中禁词或禁用事实：${run.scoreResult.forbiddenHits.join("、")}` });
  if (run.scoreResult.mismatchedFacts?.length) details.push({ code: "FACT_MISMATCH", category: "fact", dimension: "factualAccuracy", message: `事实未匹配：${run.scoreResult.mismatchedFacts.map((item) => item.key).join("、")}` });
  if (run.scoreResult.evidenceMisses?.length) details.push({ code: "EVIDENCE_MISSING", category: "evidence", dimension: "evidenceGrounding", message: `依据不足：${run.scoreResult.evidenceMisses.join("、")}` });
  if (run.scoreResult.inputRiskLevel !== run.scoreResult.detectedInputRiskLevel) details.push({ code: "RISK_LEVEL_MISMATCH", category: "risk", dimension: "riskSafety", message: `风险等级应为 ${run.scoreResult.inputRiskLevel}，实际为 ${run.scoreResult.detectedInputRiskLevel}` });
  if (!run.scoreResult.replySafetyPassed) details.push({ code: "UNSAFE_REPLY", category: "risk", dimension: "riskSafety", message: "最终回复未通过安全审核" });
  if (run.scoreResult.handoffExpected && !run.scoreResult.handoffTriggered) details.push({ code: "HANDOFF_MISSING", category: "risk", dimension: "riskSafety", message: "需要人工转接但未触发" });
  if (!details.length) details.push({ code: run.status, category: "other", dimension: "other", message: run.scoreResult.reason || `${run.status}，暂无更多结构化原因` });
  return details;
}

const api = apiRequest;

function toDraft(item: EvaluationCase): CaseDraft {
  return {
    id: item.id,
    name: item.name || "",
    question: item.question,
    employeeId: item.employeeId || "E001",
    category: item.category,
    difficulty: item.difficulty || "medium",
    inputRiskLevel: item.inputRiskLevel || item.expected_risk || "low",
    expectedBehavior: item.expectedBehavior || item.failure_mode || "",
    expectedReply: item.expectedReply || "",
    requiredCapabilities: (item.requiredCapabilities || item.expected_any || []).join(", "),
    forbiddenCapabilities: (item.forbiddenCapabilities || item.expected_none || []).join(", "),
    keywordAll: (item.expectedKeywords?.all || []).join(", "),
    keywordAny: (item.expectedKeywords?.any || []).join(", "),
    forbiddenWords: (item.forbiddenWords || []).join(", "),
    expectedFacts: JSON.stringify(item.expectedFacts || {}, null, 2),
    forbiddenFacts: JSON.stringify(item.forbiddenFacts || {}, null, 2),
    evidenceCategories: (item.expectedEvidence?.categories || []).join(", "),
    evidenceSourceIds: (item.expectedEvidence?.sourceIds || []).join(", "),
    evalDimensions: (item.evalDimensions || []).join(", "),
    tags: (item.tags || []).join(", "),
    evidenceRequired: item.expectedEvidence?.required ?? true,
    expectHandoff: item.expectedRiskResult?.handoffRequired ?? false,
    llmJudgeEnabled: Boolean(item.llmJudgeEnabled),
    enabled: item.enabled !== false,
    isBadCase: Boolean(item.isBadCase || item.suite === "bad_case"),
  };
}

export default function EvaluationCenter({ coreCases, badCases, runs, onReload, notify }: { coreCases: EvaluationCase[]; badCases: EvaluationCase[]; runs: EvaluationRun[]; onReload: () => Promise<void>; notify: (message: string) => void }) {
  const [cases, setCases] = useState<EvaluationCase[]>([...coreCases, ...badCases]);
  const [batches, setBatches] = useState<EvaluationRun[]>(runs);
  const [caseRuns, setCaseRuns] = useState<EvaluationCaseRun[]>([]);
  const [suite, setSuite] = useState<"core" | "bad_case" | "all">("core");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [difficulty, setDifficulty] = useState("all");
  const [risk, setRisk] = useState("all");
  const [dimension, setDimension] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runningCaseId, setRunningCaseId] = useState("");
  const [currentBatch, setCurrentBatch] = useState<EvaluationRun | null>(runs[0] || null);
  const [batchResultFilter, setBatchResultFilter] = useState("all");
  const [batchFailureCategory, setBatchFailureCategory] = useState("all");
  const [batchSearch, setBatchSearch] = useState("");
  const [activeRun, setActiveRun] = useState<EvaluationCaseRun | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<CaseDraft>(emptyDraft);
  const [overview, setOverview] = useState<Overview | null>(null);

  const loadOverview = async () => {
    setLoading(true);
    try {
      const data = await api<Overview>("/eval");
      setOverview(data); setCases(data.cases); setBatches(data.batches); setCaseRuns(data.runs);
      setCurrentBatch((current) => current ? data.batches.find((item) => item.id === current.id) || data.batches[0] || null : data.batches[0] || null);
    } catch (error) { notify(error instanceof Error ? error.message : "评测数据加载失败"); }
    finally { setLoading(false); }
  };
  // Initial synchronization with the persistent Eval service.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void loadOverview(); }, []);

  const latestByCase = useMemo(() => {
    const map = new Map<string, EvaluationCaseRun>();
    for (const item of caseRuns) if (!map.has(item.caseId)) map.set(item.caseId, item);
    return map;
  }, [caseRuns]);
  const categories = overview?.categories || [...new Set(cases.map((item) => item.category))];
  const dimensions = overview?.dimensions || [...new Set(cases.flatMap((item) => item.evalDimensions || []))];
  const sourceCases = useMemo(() => cases.filter((item) => suite === "all" || (suite === "bad_case") === Boolean(item.isBadCase || item.suite === "bad_case")), [cases, suite]);
  const filteredCases = useMemo(() => sourceCases.filter((item) => {
    const latest = latestByCase.get(item.id);
    const text = `${item.id} ${item.name || ""} ${item.question} ${item.expectedBehavior || item.failure_mode || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
    return (!search || text.includes(search.toLowerCase()))
      && (category === "all" || item.category === category)
      && (difficulty === "all" || item.difficulty === difficulty)
      && (risk === "all" || (item.inputRiskLevel || item.expected_risk) === risk)
      && (dimension === "all" || item.evalDimensions?.includes(dimension))
      && (resultFilter === "all" || resultFilter === (latest?.status || "UNTESTED"));
  }), [sourceCases, search, category, difficulty, risk, dimension, resultFilter, latestByCase]);
  const effectivePageSize = pageSize === 0 ? Math.max(1, filteredCases.length) : pageSize;
  const totalPages = Math.max(1, Math.ceil(filteredCases.length / effectivePageSize));
  const safePage = Math.min(page, totalPages);
  const visibleCases = filteredCases.slice((safePage - 1) * effectivePageSize, safePage * effectivePageSize);
  const selectedCases = cases.filter((item) => selectedIds.has(item.id) && item.enabled !== false);
  const latestBatch = currentBatch || batches[0] || null;
  const batchRuns = useMemo(() => latestBatch?.eval_runs || [], [latestBatch]);
  const visibleBatchRuns = batchRuns.filter((item) => {
    const text = `${item.caseId} ${item.question} ${item.finalReply || ""} ${item.scoreResult.reason || ""}`.toLowerCase();
    return (batchResultFilter === "all" || item.status === batchResultFilter)
      && (batchFailureCategory === "all" || failureDetailsFor(item).some((detail) => detail.category === batchFailureCategory))
      && (!batchSearch || text.includes(batchSearch.toLowerCase()));
  });
  const batchFailureSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of batchRuns) {
      for (const detail of failureDetailsFor(run)) counts.set(detail.category, (counts.get(detail.category) || 0) + 1);
    }
    return [...counts.entries()].map(([categoryKey, count]) => ({ category: categoryKey, count })).sort((left, right) => right.count - left.count);
  }, [batchRuns]);

  const refresh = async (message?: string) => { await Promise.all([loadOverview(), onReload()]); if (message) notify(message); };
  const openCreate = (bad = false) => { setDraft({ ...emptyDraft, isBadCase: bad }); setShowForm(true); };
  const openEdit = (item: EvaluationCase) => { setDraft(toDraft(item)); setShowForm(true); };
  const saveCase = async () => {
    if (!draft.question.trim()) return notify("用户问题不能为空");
    let expectedFacts: Record<string, unknown>;
    let forbiddenFacts: Record<string, unknown>;
    try {
      expectedFacts = JSON.parse(draft.expectedFacts || "{}");
      forbiddenFacts = JSON.parse(draft.forbiddenFacts || "{}");
    } catch {
      return notify("预期事实和禁用事实必须是合法 JSON");
    }
    const payload = {
      name: draft.name || draft.question.slice(0, 28), question: draft.question, employeeId: draft.employeeId, category: draft.category, scenario: draft.category,
      difficulty: draft.difficulty, inputRiskLevel: draft.inputRiskLevel, expectedBehavior: draft.expectedBehavior, expectedReply: draft.expectedReply,
      requiredCapabilities: csv(draft.requiredCapabilities), forbiddenCapabilities: csv(draft.forbiddenCapabilities),
      expectedKeywords: { all: csv(draft.keywordAll), any: csv(draft.keywordAny), groups: [] }, forbiddenWords: csv(draft.forbiddenWords),
      expectedFacts, forbiddenFacts,
      expectedEvidence: { required: draft.evidenceRequired, categories: csv(draft.evidenceCategories), sourceIds: csv(draft.evidenceSourceIds), minCount: draft.evidenceRequired ? 1 : 0 },
      expectedRiskResult: { inputRiskLevel: draft.inputRiskLevel, replyShouldBeSafe: true, replyAllowed: true, handoffRequired: draft.expectHandoff },
      expectReplyAllowed: true, expectHandoff: draft.expectHandoff, evalDimensions: csv(draft.evalDimensions), tags: csv(draft.tags), llmJudgeEnabled: draft.llmJudgeEnabled, enabled: draft.enabled, isBadCase: draft.isBadCase,
    };
    try {
      await api(draft.id ? `/eval/cases/${draft.id}` : "/eval/cases", { method: draft.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      setShowForm(false); await refresh(draft.id ? "评测用例已更新" : "评测用例已保存");
    } catch (error) { notify(error instanceof Error ? error.message : "评测用例保存失败"); }
  };
  const deleteCase = async (item: EvaluationCase) => {
    if (!confirm(`确认删除评测用例 ${item.id}？`)) return;
    try { await api(`/eval/cases/${item.id}`, { method: "DELETE" }); selectedIds.delete(item.id); setSelectedIds(new Set(selectedIds)); await refresh("评测用例已删除"); }
    catch (error) { notify(error instanceof Error ? error.message : "删除失败"); }
  };
  const toggleCase = async (item: EvaluationCase) => {
    try { await api(`/eval/cases/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: item.enabled === false }) }); await refresh(item.enabled === false ? "用例已启用" : "用例已停用"); }
    catch (error) { notify(error instanceof Error ? error.message : "状态更新失败"); }
  };
  const duplicateCase = async (item: EvaluationCase) => {
    try { await api(`/eval/cases/${item.id}/duplicate`, { method: "POST" }); await refresh("评测用例已复制"); }
    catch (error) { notify(error instanceof Error ? error.message : "复制失败"); }
  };
  const runSingle = async (item: EvaluationCase) => {
    setRunningCaseId(item.id); setActiveRun(null);
    try {
      const result = await api<EvaluationCaseRun>(`/eval/cases/${item.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeId: item.employeeId || "E001" }) });
      setActiveRun(result); await refresh(`${item.id} 真实 Agent 评测完成：${result.status}`);
    } catch (error) { notify(error instanceof Error ? error.message : "单条评测失败"); }
    finally { setRunningCaseId(""); }
  };
  const runBatch = async (quick = false) => {
    const picked = quick ? filteredCases.filter((item) => item.enabled !== false).slice(0, 8) : selectedCases;
    if (!picked.length) return notify("请先选择至少一条已启用用例");
    setRunning(true); setActiveRun(null);
    try {
      const result = await api<EvaluationRun>("/eval/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suite: "all", caseIds: picked.map((item) => item.id), limit: picked.length }) });
      setCurrentBatch(result); setBatchResultFilter("all"); setBatchFailureCategory("all"); setBatchSearch(""); setActiveRun(null); await refresh(`批量评测完成：共 ${result.total} 条，PASS ${result.passed} / FAIL ${result.failed || 0} / REVIEW ${result.review || 0} / ERROR ${result.error || 0}`);
    } catch (error) { notify(error instanceof Error ? error.message : "批量评测失败"); }
    finally { setRunning(false); }
  };
  const importFromRun = async () => {
    const runId = prompt("请输入要加入评测集的 Run ID");
    if (!runId?.trim()) return;
    try { await api("/eval/cases/from-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: runId.trim(), name: `来自 ${runId.trim()} 的评测用例` }) }); await refresh("已从真实 Run 创建评测用例"); }
    catch (error) { notify(error instanceof Error ? error.message : "从 Run 导入失败"); }
  };
  const promoteFailure = async (item: EvaluationCaseRun) => {
    try { await api("/eval/cases/from-failure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ evalRunId: item.id }) }); await refresh("失败结果已沉淀为 Bad Case"); }
    catch (error) { notify(error instanceof Error ? error.message : "Bad Case 回流失败"); }
  };
  const retryBatch = async (batch: EvaluationRun) => {
    setRunning(true);
    try {
      const result = await api<EvaluationRun>(`/eval/batches/${batch.id}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ statuses: ["FAIL", "ERROR"] }) });
      setCurrentBatch(result); setBatchResultFilter("all"); setBatchFailureCategory("all"); setBatchSearch(""); setActiveRun(null); await refresh("失败和错误用例已通过同一 Agent 主链路重试，逐条结果已展开");
    } catch (error) { notify(error instanceof Error ? error.message : "批次重试失败"); }
    finally { setRunning(false); }
  };
  const toggleSelected = (id: string) => { const next = new Set(selectedIds); if (next.has(id)) next.delete(id); else next.add(id); setSelectedIds(next); };

  return <div className="page evaluation-center eval-v2">
    <div className="page-heading">
      <div><span className="eyebrow">REAL AGENT EVALUATION</span><h1>自动评测中心</h1><p>每条用例真实经过 Planner、Validator、Skill、Tool、知识检索、回复生成与风险审核；ERROR 不计入产品质量 FAIL。</p></div>
      <div className="heading-actions eval-heading-actions"><details className="eval-more-actions"><summary>更多操作</summary><div><button onClick={importFromRun}>从 Run 加入</button><button onClick={() => openCreate(true)}>新增 Bad Case</button><button onClick={() => openCreate(false)}>新增用例</button><button disabled={running} onClick={() => runBatch(true)}>快速运行 8 条</button></div></details><button className="primary compact" disabled={running || !selectedCases.length} onClick={() => runBatch(false)}>{running ? "真实 Agent 评测中…" : `运行已选 ${selectedCases.length} 条`}</button></div>
    </div>

    {showForm && <section className="panel eval-case-form">
      <div className="eval-form-head"><div><h2>{draft.id ? `编辑 ${draft.id}` : "新增评测用例"}</h2><p>配置修改后会直接影响下一次真实评分。</p></div><button className="secondary" onClick={() => setShowForm(false)}>关闭</button></div>
      <div className="eval-form-grid">
        <label>名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label>
        <label>员工 ID<input value={draft.employeeId} onChange={(event) => setDraft({ ...draft, employeeId: event.target.value })}/></label>
        <label className="full">用户问题<textarea value={draft.question} onChange={(event) => setDraft({ ...draft, question: event.target.value })}/></label>
        <label>分类<input list="eval-category-options" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}/><datalist id="eval-category-options">{categories.map((item) => <option value={item} key={item}/>)}</datalist></label>
        <label>难度<select value={draft.difficulty} onChange={(event) => setDraft({ ...draft, difficulty: event.target.value as CaseDraft["difficulty"] })}><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label>
        <label>输入风险<select value={draft.inputRiskLevel} onChange={(event) => setDraft({ ...draft, inputRiskLevel: event.target.value, expectHandoff: ["high", "critical"].includes(event.target.value) })}><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option><option value="critical">严重风险</option></select></label>
        <label className="eval-inline-check"><input type="checkbox" checked={draft.expectHandoff} onChange={(event) => setDraft({ ...draft, expectHandoff: event.target.checked })}/>期望人工转接</label>
        <label className="full">预期行为<textarea value={draft.expectedBehavior} onChange={(event) => setDraft({ ...draft, expectedBehavior: event.target.value })}/></label>
        <label className="full">预期回复（可选）<textarea value={draft.expectedReply} onChange={(event) => setDraft({ ...draft, expectedReply: event.target.value })}/></label>
        <label>必需能力<input value={draft.requiredCapabilities} onChange={(event) => setDraft({ ...draft, requiredCapabilities: event.target.value })} placeholder="逗号分隔"/></label>
        <label>禁用能力<input value={draft.forbiddenCapabilities} onChange={(event) => setDraft({ ...draft, forbiddenCapabilities: event.target.value })} placeholder="逗号分隔"/></label>
        <label>必须命中关键词（AND）<input value={draft.keywordAll} onChange={(event) => setDraft({ ...draft, keywordAll: event.target.value })}/></label>
        <label>任一关键词（OR）<input value={draft.keywordAny} onChange={(event) => setDraft({ ...draft, keywordAny: event.target.value })}/></label>
        <label className="full">禁词<input value={draft.forbiddenWords} onChange={(event) => setDraft({ ...draft, forbiddenWords: event.target.value })}/></label>
        <label>预期事实 JSON<textarea className="eval-json-field" value={draft.expectedFacts} onChange={(event) => setDraft({ ...draft, expectedFacts: event.target.value })}/></label>
        <label>禁用事实 JSON<textarea className="eval-json-field" value={draft.forbiddenFacts} onChange={(event) => setDraft({ ...draft, forbiddenFacts: event.target.value })}/></label>
        <label>依据分类<input value={draft.evidenceCategories} onChange={(event) => setDraft({ ...draft, evidenceCategories: event.target.value })} placeholder="逗号分隔"/></label>
        <label>依据 Source ID<input value={draft.evidenceSourceIds} onChange={(event) => setDraft({ ...draft, evidenceSourceIds: event.target.value })} placeholder="逗号分隔"/></label>
        <label className="full">评测维度<input value={draft.evalDimensions} onChange={(event) => setDraft({ ...draft, evalDimensions: event.target.value })}/></label>
        <label className="full">标签<input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })}/></label>
        <label className="eval-inline-check"><input type="checkbox" checked={draft.evidenceRequired} onChange={(event) => setDraft({ ...draft, evidenceRequired: event.target.checked })}/>必须提供知识依据</label>
        <label className="eval-inline-check"><input type="checkbox" checked={draft.llmJudgeEnabled} onChange={(event) => setDraft({ ...draft, llmJudgeEnabled: event.target.checked })}/>启用 LLM Judge（未配置时 REVIEW）</label>
        <label className="eval-inline-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}/>启用</label>
        <label className="eval-inline-check"><input type="checkbox" checked={draft.isBadCase} onChange={(event) => setDraft({ ...draft, isBadCase: event.target.checked })}/>标记为 Bad Case</label>
      </div>
      <div className="form-actions"><button className="secondary" onClick={() => setShowForm(false)}>取消</button><button className="primary compact" onClick={saveCase}>保存并持久化</button></div>
    </section>}

    <div className="evaluation-suite-tabs" role="tablist">
      <button className={suite === "core" ? "active" : ""} onClick={() => { setSuite("core"); setPage(1); }}>核心评测集 <b>{cases.filter((item) => !item.isBadCase).length}</b></button>
      <button className={suite === "bad_case" ? "active" : ""} onClick={() => { setSuite("bad_case"); setPage(1); }}>Bad Case <b>{cases.filter((item) => item.isBadCase).length}</b></button>
      <button className={suite === "all" ? "active" : ""} onClick={() => { setSuite("all"); setPage(1); }}>全部用例 <b>{cases.length}</b></button>
    </div>

    <div className="eval-status-grid eval-status-grid-v3">
      <div className="panel"><span>产品质量通过率</span><b>{latestBatch ? `${Math.round(latestBatch.pass_rate * 100)}%` : "—"}</b><small>PASS {latestBatch?.passed ?? 0} · FAIL {latestBatch?.failed ?? 0}</small></div>
      <div className="panel"><span>能力路由准确率</span><b>{latestBatch ? `${Math.round((latestBatch.route_accuracy || 0) * 100)}%` : "—"}</b><small>Planner / Skill / Tool 编排</small></div>
      <div className="panel"><span>风险处理准确率</span><b>{latestBatch ? `${Math.round((latestBatch.risk_accuracy || 0) * 100)}%` : "—"}</b><small>风险识别与安全回复</small></div>
      <div className="panel"><span>系统可用率</span><b>{latestBatch?.availability_rate != null ? `${Math.round(latestBatch.availability_rate * 100)}%` : "—"}</b><small>REVIEW {latestBatch?.review ?? 0} · ERROR {latestBatch?.error ?? 0}</small></div>
    </div>

    <section className="panel evaluation-dataset">
      <div className="evaluation-toolbar eval-toolbar-v2">
        <label className="evaluation-search"><span>搜索问题 / Case ID</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="例如：直属领导、下班、薪资"/></label>
        <label><span>分类</span><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="all">全部</option>{categories.map((item) => <option key={item} value={item}>{categoryNames[item] || item}</option>)}</select></label>
        <label><span>难度</span><select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option value="all">全部</option><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label>
        <label><span>风险</span><select value={risk} onChange={(event) => setRisk(event.target.value)}><option value="all">全部</option><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option><option value="critical">严重</option></select></label>
        <label><span>维度</span><select value={dimension} onChange={(event) => setDimension(event.target.value)}><option value="all">全部</option>{dimensions.map((item) => <option value={item} key={item}>{dimensionNames[item] || item}</option>)}</select></label>
        <label><span>结果</span><select value={resultFilter} onChange={(event) => setResultFilter(event.target.value)}><option value="all">全部</option><option value="PASS">PASS</option><option value="FAIL">FAIL</option><option value="REVIEW">REVIEW</option><option value="ERROR">ERROR</option><option value="UNTESTED">未测试</option></select></label>
        <label><span>每页</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value={20}>20 条</option><option value={50}>50 条</option><option value={0}>全部</option></select></label>
      </div>
      <div className="eval-selection-bar"><label><input type="checkbox" checked={visibleCases.length > 0 && visibleCases.every((item) => selectedIds.has(item.id))} onChange={(event) => { const next = new Set(selectedIds); visibleCases.forEach((item) => event.target.checked ? next.add(item.id) : next.delete(item.id)); setSelectedIds(next); }}/>选择当前页</label><span>已选择 {selectedCases.length} 条已启用用例</span><button className="text-button" onClick={() => setSelectedIds(new Set())}>清空选择</button></div>
      <div className="evaluation-table-wrap">
        <div className="evaluation-case-row evaluation-case-head eval-case-head-v2"><span>选择</span><span>用例</span><span>分类 / 难度</span><span>用户输入 / 评分规则</span><span>能力约束</span><span>风险</span><span>最近结果</span><span>操作</span></div>
        {loading ? <div className="empty-state">正在读取持久化评测集…</div> : visibleCases.map((item) => {
          const latest = latestByCase.get(item.id);
          const required = item.requiredCapabilities || item.expected_any || [];
          const forbidden = item.forbiddenCapabilities || item.expected_none || [];
          return <article className={`evaluation-case-row eval-case-row-v2 ${item.enabled === false ? "case-disabled" : ""}`} key={item.id}>
            <input aria-label={`选择 ${item.id}`} type="checkbox" disabled={item.enabled === false} checked={selectedIds.has(item.id)} onChange={() => toggleSelected(item.id)}/>
            <div><code>{item.id}</code><span className={`suite-chip ${item.isBadCase ? "bad" : "core"}`}>{item.isBadCase ? "BAD" : "核心"}</span></div>
            <div className="eval-category-cell"><strong>{categoryNames[item.category] || item.category}</strong><small>{item.difficulty || "medium"} · {item.enabled === false ? "已停用" : "已启用"}</small></div>
            <div className="evaluation-question"><strong>{item.question}</strong><small>{item.expectedBehavior || item.failure_mode || "按能力和风险规则评分"}</small>{Boolean(item.expectedKeywords?.all?.length || item.expectedKeywords?.any?.length) && <small>关键词：{[...(item.expectedKeywords?.all || []), ...(item.expectedKeywords?.any || [])].join("、")}</small>}</div>
            <div className="route-expectations"><div>{required.map((capability) => <code key={capability}>＋ {capability}</code>)}</div>{Boolean(forbidden.length) && <div>{forbidden.map((capability) => <code className="forbidden" key={capability}>－ {capability}</code>)}</div>}</div>
            <span className={`badge ${(item.inputRiskLevel || item.expected_risk) === "high" || (item.inputRiskLevel || item.expected_risk) === "critical" ? "red" : (item.inputRiskLevel || item.expected_risk) === "medium" ? "orange" : "green"}`}>{riskLabel(item.inputRiskLevel || item.expected_risk)}</span>
            {latest ? <button className="eval-result-button" onClick={() => setActiveRun(latest)}><span className={`badge ${statusClass(latest.status)}`}>{latest.status}</span><small>{latest.runId || "无 Run ID"} · {latest.durationMs}ms</small></button> : <span className="badge neutral">未测试</span>}
            <div className="eval-row-actions"><button disabled={Boolean(runningCaseId)} onClick={() => runSingle(item)}>{runningCaseId === item.id ? "运行中…" : "单条运行"}</button><button onClick={() => openEdit(item)}>编辑</button><button onClick={() => duplicateCase(item)}>复制</button><button onClick={() => toggleCase(item)}>{item.enabled === false ? "启用" : "停用"}</button><button className="danger-link" onClick={() => deleteCase(item)}>删除</button></div>
          </article>;
        })}
        {!loading && !visibleCases.length && <div className="empty-state">没有符合当前筛选条件的评测用例</div>}
      </div>
      <div className="evaluation-pagination"><span>显示 {filteredCases.length ? (safePage - 1) * effectivePageSize + 1 : 0}–{Math.min(safePage * effectivePageSize, filteredCases.length)} / {filteredCases.length} 条</span><div><button disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button><b>{safePage} / {totalPages}</b><button disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button></div></div>
    </section>

    {latestBatch && <section className="panel eval-batch-detail">
      <div className="eval-form-head">
        <div><span className="eyebrow">BATCH RESULT</span><h2>批次逐条评测结果</h2><p>{latestBatch.name || latestBatch.id} · {latestBatch.id} · 共 {latestBatch.total} 条真实 Agent 运行</p></div>
        <div className="heading-actions"><span className={`badge ${latestBatch.quality_gate?.passed ? "green" : "red"}`}>{latestBatch.quality_gate?.passed ? "质量门禁通过" : "质量门禁未通过"}</span>{Boolean((latestBatch.failed || 0) + (latestBatch.error || 0)) && <button className="secondary" disabled={running} onClick={() => retryBatch(latestBatch)}>重试 FAIL / ERROR</button>}</div>
      </div>
      <div className="eval-batch-overview">
        <div><span>批次通过率</span><b>{Math.round(latestBatch.pass_rate * 100)}%</b><small>PASS / (PASS + FAIL)</small></div>
        <div><span>路由准确率</span><b>{Math.round((latestBatch.route_accuracy || 0) * 100)}%</b><small>Skill / Tool 编排</small></div>
        <div><span>风险准确率</span><b>{Math.round((latestBatch.risk_accuracy || 0) * 100)}%</b><small>风险识别与回复安全</small></div>
        <div><span>系统可用率</span><b>{Math.round((latestBatch.availability_rate || 0) * 100)}%</b><small>ERROR 不计产品 FAIL</small></div>
      </div>
      <div className="eval-failure-summary">
        <div><h3>失败归因汇总</h3><p>{batchFailureSummary.length ? "按评分证据归类；同一条用例可能命中多个原因。" : "本批次没有 FAIL、REVIEW 或 ERROR。"}</p></div>
        <div className="eval-failure-chips">{batchFailureSummary.map((item) => <button className={batchFailureCategory === item.category ? "active" : ""} key={item.category} onClick={() => { setBatchFailureCategory(item.category); setBatchResultFilter("all"); }}><span>{failureCategoryNames[item.category] || item.category}</span><b>{item.count}</b></button>)}</div>
      </div>
      <div className="eval-batch-toolbar">
        <label><span>搜索本批次</span><input value={batchSearch} onChange={(event) => setBatchSearch(event.target.value)} placeholder="问题、Case ID、回复或失败原因"/></label>
        <div className="eval-batch-filter" role="group" aria-label="筛选批次结果">
          {batchFailureCategory !== "all" && <button className="active" onClick={() => setBatchFailureCategory("all")}>原因：{failureCategoryNames[batchFailureCategory] || batchFailureCategory} ×</button>}
          {["all", "PASS", "FAIL", "REVIEW", "ERROR"].map((status) => <button key={status} className={batchResultFilter === status ? "active" : ""} onClick={() => setBatchResultFilter(status)}>{status === "all" ? `全部 ${batchRuns.length}` : `${status} ${batchRuns.filter((item) => item.status === status).length}`}</button>)}
        </div>
      </div>
      <div className="eval-batch-results">
        <div className="eval-batch-result-row eval-batch-result-head"><span>#</span><span>结果</span><span>用户输入</span><span>评测结论 / 失败原因</span><span>真实 Agent 回复</span><span>运行信息</span><span>详情</span></div>
        {visibleBatchRuns.map((run) => {
          const details = failureDetailsFor(run);
          return <article className={`eval-batch-result-row status-${run.status.toLowerCase()}`} key={run.id}>
            <span>{batchRuns.indexOf(run) + 1}</span>
            <span className={`badge ${statusClass(run.status)}`}>{run.status}</span>
            <div><code>{run.caseId}</code><strong>{run.question}</strong></div>
            <div className="eval-batch-reasons">{details.length ? details.map((detail) => <p key={`${detail.code}-${detail.message}`}><span>{failureCategoryNames[detail.category] || detail.category}</span>{detail.message}</p>) : <p className="passed-reason"><span>全部通过</span>{run.scoreResult.reason}</p>}</div>
            <p className="eval-batch-reply">{run.finalReply || run.error?.message || "未生成回复"}</p>
            <div className="eval-batch-run-meta"><code>{run.runId || "无 Run ID"}</code><small>{run.provider || "未知 Provider"} / {run.model || "未知模型"}</small><small>{run.durationMs || 0}ms · Trace {run.trace?.length || 0} 步</small></div>
            <button className="secondary eval-view-detail" onClick={() => setActiveRun(run)}>查看完整结果</button>
          </article>;
        })}
        {!visibleBatchRuns.length && <div className="empty-state">本批次没有符合当前筛选条件的结果</div>}
      </div>
    </section>}

    {activeRun && <section className="panel eval-run-detail">
      <div className="eval-run-head"><div><span className={`badge ${statusClass(activeRun.status)}`}>{activeRun.status}</span><h2>单条真实评测结果</h2><p>{activeRun.caseId} · RunRecord {activeRun.runId || "未生成"} · {activeRun.provider || "未记录 Provider"} / {activeRun.model || "未记录模型"}</p></div><div className="heading-actions">{activeRun.status === "FAIL" && <button className="secondary" onClick={() => promoteFailure(activeRun)}>沉淀为 Bad Case</button>}<button className="secondary" onClick={() => setActiveRun(null)}>关闭</button></div></div>
      <div className="eval-detail-grid">
        <div><h3>Agent 最终回复</h3><div className="eval-answer">{activeRun.finalReply || activeRun.error?.message || "本次运行没有生成最终回复。"}</div></div>
        <div><h3>评分结论</h3><p className="eval-score-reason">{activeRun.scoreResult.reason}</p><div className="eval-score-tags"><span>风险：{activeRun.scoreResult.detectedInputRiskLevel}</span><span>回复安全：{activeRun.scoreResult.replySafetyPassed ? "通过" : "未通过"}</span><span>允许发送：{activeRun.scoreResult.replyAllowed ? "是" : "否"}</span><span>人工转接：{activeRun.scoreResult.handoffTriggered ? "已触发" : "未触发"}</span></div></div>
      </div>
      {activeRun.status !== "PASS" && <div className="eval-failure-diagnosis"><h3>失败诊断</h3>{failureDetailsFor(activeRun).map((detail) => <article key={`${detail.code}-${detail.message}`}><div><span>{failureCategoryNames[detail.category] || detail.category}</span><code>{detail.code}</code><b>{dimensionNames[detail.dimension] || detail.dimension}</b></div><p>{detail.message}</p>{(detail.expected !== undefined || detail.actual !== undefined) && <details><summary>查看预期与实际证据</summary><pre>{JSON.stringify({ expected: detail.expected, actual: detail.actual }, null, 2)}</pre></details>}</article>)}</div>}
      <div className="eval-dimension-grid">{Object.entries(activeRun.scoreResult.dimensionScores || {}).map(([key, value]) => <div key={key}><span>{dimensionNames[key] || key}</span><b>{Math.round(value * 100)}%</b></div>)}</div>
      <div className="eval-evidence-grid">
        <div><h3>能力与关键词证据</h3><p>能力命中：{activeRun.scoreResult.capabilityHits.join("、") || "无"}</p><p className={activeRun.scoreResult.capabilityMisses.length ? "eval-problem" : ""}>能力缺失：{activeRun.scoreResult.capabilityMisses.join("、") || "无"}</p><p>关键词命中：{activeRun.scoreResult.keywordHits.join("、") || "无配置"}</p><p className={activeRun.scoreResult.keywordMisses.length ? "eval-problem" : ""}>关键词缺失：{activeRun.scoreResult.keywordMisses.join("、") || "无"}</p></div>
        <div><h3>知识依据</h3>{activeRun.evidence.length ? activeRun.evidence.map((item, index) => <p key={`${item.source_id}-${index}`}><b>{item.title || item.category}</b> · {item.source || item.source_id}</p>) : <p className="eval-problem">没有返回知识依据</p>}</div>
      </div>
      <details className="eval-trace" open={activeRun.status === "ERROR"}><summary>查看完整 Trace 与结构化错误</summary>{activeRun.trace.map((step, index) => <article key={`${step.id}-${index}`}><span>{index + 1}</span><div><strong>{step.name || step.capability_id || step.id}</strong><small>{step.status} · {step.duration_ms || 0}ms</small><pre>{JSON.stringify(step.error || step.output || step.input, null, 2)}</pre></div></article>)}{activeRun.error && <pre>{JSON.stringify(activeRun.error, null, 2)}</pre>}</details>
    </section>}

    <section className="panel eval-batch-history">
      <div className="eval-form-head"><div><h2>批次历史</h2><p>点击任意历史批次，上方会展示该批次的全部逐条结果和失败归因。</p></div><div className="heading-actions"><span className="badge neutral">{batches.length} 个批次</span></div></div>
      {batches.slice(0, 10).map((batch) => <button key={batch.id} className={latestBatch?.id === batch.id ? "active" : ""} onClick={() => { setCurrentBatch(batch); setBatchResultFilter("all"); setBatchFailureCategory("all"); setBatchSearch(""); setActiveRun(null); }}><code>{batch.id}</code><span>{batch.name || batch.suite}</span><b>{Math.round(batch.pass_rate * 100)}%</b><small>共 {batch.total} 条 · PASS {batch.passed} · FAIL {batch.failed || 0} · REVIEW {batch.review || 0} · ERROR {batch.error || 0}</small><small>{batch.model || "未记录模型"} · {batch.duration_ms || 0}ms</small></button>)}
      {!batches.length && <div className="empty-state">尚未运行真实 Agent 评测批次</div>}
    </section>
  </div>;
}
