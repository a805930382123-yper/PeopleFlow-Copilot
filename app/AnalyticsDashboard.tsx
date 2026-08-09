"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type UsageBucket = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  calls: number;
  cost: number | null;
  priced_calls: number;
};

type ModelPricing = {
  provider: string;
  model: string;
  input_price_per_million: number;
  output_price_per_million: number;
  cached_input_price_per_million: number | null;
  currency: string;
};

type TokenMonitorConfig = {
  daily_budget_tokens: number;
  monthly_budget_tokens: number;
  warning_threshold_percent: number;
  critical_threshold_percent: number;
  currency: string;
  model_pricing: ModelPricing[];
  updated_at?: string;
};

type BudgetProgress = {
  limit: number;
  used: number;
  ratio: number | null;
  status: "disabled" | "normal" | "warning" | "critical" | "exceeded";
};

type TokenAnalytics = {
  range_days: number;
  source_filter: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  calls: number;
  today_tokens: number;
  month_tokens: number;
  average_tokens_per_run: number;
  reported_runs: number;
  unreported_runs: number;
  fixture_runs: number;
  reporting_rate: number | null;
  estimated_cost: number | null;
  pricing_coverage_rate: number | null;
  currency: string;
  by_model: (UsageBucket & { provider: string; model: string })[];
  by_skill: (UsageBucket & { skill_id: string; average_tokens: number })[];
  by_source: (UsageBucket & { source: string; runs: number; average_tokens: number })[];
  daily: (UsageBucket & { date: string })[];
  high_usage_runs: {
    run_id: string;
    question: string;
    source: string;
    provider: string;
    model: string;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    calls: number;
    cost: number | null;
    duration_ms: number;
    created_at: string;
  }[];
  budgets: {
    daily: BudgetProgress;
    monthly: BudgetProgress;
    warning_threshold_percent: number;
    critical_threshold_percent: number;
  };
  config: TokenMonitorConfig;
  notes: { fixture: string; coze: string; historical: string };
};

export type AnalyticsData = {
  executions: number;
  average_step_duration_ms: number;
  tool_success_rate: number;
  failed_tool_count: number;
  knowledge_gap_count: number;
  open_handoffs: number;
  high_risk_count: number;
  feedback_count: number;
  positive_feedback_rate: number | null;
  security_event_count: number;
  knowledge_document_count: number;
  active_knowledge_document_count: number;
  risk_distribution: Record<string, number>;
  route_distribution: { route: string; count: number }[];
  daily_executions: { date: string; count: number }[];
  top_topics: { topic: string; count: number }[];
  knowledge_gaps: { id: string; question: string; created_at: string; employee_name: string }[];
  slowest_tools: { tool_id: string; average_ms: number; calls: number }[];
  latest_evaluation?: { pass_rate: number; route_accuracy: number; risk_accuracy: number; quality_gate?: { passed: boolean } | null } | null;
  token_usage: TokenAnalytics;
};

type Props = {
  analytics: AnalyticsData;
  request: (path: string, options?: RequestInit) => Promise<unknown>;
  onReload: () => Promise<void>;
  notify: (message: string) => void;
};

const routeNames: Record<string, string> = {
  coze_workflow: "Coze 工作流",
  sensitive_handoff: "敏感问答",
  employee_data: "员工数据",
  onboarding_materials: "入职材料",
  policy_knowledge: "制度知识",
  task_process: "任务流程",
  training_knowledge: "培训知识",
  general_knowledge: "通用知识",
};
const riskNames: Record<string, string> = { low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险" };
const sourceNames: Record<string, string> = { all: "全部来源", workbench: "Agent 工作台", demo: "聊天 Demo", evaluation: "自动评测", retry: "运行重试" };
const skillNames: Record<string, string> = {
  planner: "Planner",
  question_structuring: "问题结构化",
  task_decision: "任务决策",
  process_explanation: "流程解释",
  policy_qa: "制度问答",
  reply_generation: "回复生成",
  risk_review: "风险审核",
  run_total: "运行汇总",
};

const formatTokens = (value: number) => new Intl.NumberFormat("zh-CN", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
const formatPercent = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
const formatCost = (value: number | null, currency: string) => value === null ? "待配置" : new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 4 }).format(value);

function BudgetBar({ label, value }: { label: string; value: BudgetProgress }) {
  const percent = value.ratio === null ? 0 : Math.min(100, value.ratio * 100);
  const statusText = value.status === "disabled" ? "未设置预算" : value.status === "exceeded" ? "已超预算" : value.status === "critical" ? "严重预警" : value.status === "warning" ? "接近预算" : "正常";
  return <div className={`token-budget-row ${value.status}`}>
    <div><strong>{label}</strong><span>{statusText}</span></div>
    <div className="token-budget-track"><i style={{ width: `${percent}%` }}/></div>
    <small>{formatTokens(value.used)} / {value.limit ? formatTokens(value.limit) : "未设置"}</small>
  </div>;
}

export default function AnalyticsDashboard({ analytics, request, onReload, notify }: Props) {
  const [tab, setTab] = useState<"business" | "tokens">("business");
  const [tokenData, setTokenData] = useState(analytics.token_usage);
  const [days, setDays] = useState(analytics.token_usage.range_days || 30);
  const [source, setSource] = useState(analytics.token_usage.source_filter || "all");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState<TokenMonitorConfig>(structuredClone(analytics.token_usage.config));

  const dailyMax = Math.max(1, ...analytics.daily_executions.map((item) => item.count));
  const routeMax = Math.max(1, ...analytics.route_distribution.map((item) => item.count));
  const riskMax = Math.max(1, ...Object.values(analytics.risk_distribution));
  const tokenDailyMax = Math.max(1, ...tokenData.daily.map((item) => item.total_tokens));
  const tokenModelMax = Math.max(1, ...tokenData.by_model.map((item) => item.total_tokens));
  const tokenSkillMax = Math.max(1, ...tokenData.by_skill.map((item) => item.total_tokens));
  const availableSources = useMemo(() => ["all", "workbench", "demo", "evaluation", "retry"], []);

  const loadTokens = async (nextDays = days, nextSource = source) => {
    setLoading(true);
    try {
      const result = await request(`/analytics?days=${nextDays}&source=${encodeURIComponent(nextSource)}`) as AnalyticsData;
      setTokenData(result.token_usage);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Token 统计加载失败");
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const saved = await request("/token-monitor/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configDraft),
      }) as TokenMonitorConfig;
      setConfigDraft(structuredClone(saved));
      await loadTokens();
      await onReload();
      setConfigOpen(false);
      notify("Token 预算与模型单价已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Token 配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const updatePricing = (index: number, patch: Partial<ModelPricing>) => {
    setConfigDraft((current) => ({ ...current, model_pricing: current.model_pricing.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));
  };

  const addPricing = () => {
    const candidate = tokenData.by_model.find((item) => !configDraft.model_pricing.some((price) => price.provider === item.provider && price.model === item.model));
    setConfigDraft((current) => ({
      ...current,
      model_pricing: [...current.model_pricing, {
        provider: candidate?.provider || "",
        model: candidate?.model || "",
        input_price_per_million: 0,
        output_price_per_million: 0,
        cached_input_price_per_million: null,
        currency: current.currency,
      }],
    }));
  };

  return <div className="page analytics-dashboard">
    <div className="page-heading analytics-heading">
      <div><h1>运营看板</h1><p>{tab === "business" ? "观察问答质量、Tool 稳定性、风险事件和评测门禁。" : "监测 Planner 与 Skill 的真实 Token 消耗、费用和预算状态。"}</p></div>
      <span className={`badge ${tab === "tokens" ? tokenData.budgets.daily.status === "critical" || tokenData.budgets.daily.status === "exceeded" ? "red" : "blue" : analytics.latest_evaluation?.quality_gate?.passed ? "green" : "orange"}`}>
        {tab === "tokens" ? `usage 覆盖率 ${formatPercent(tokenData.reporting_rate)}` : analytics.latest_evaluation ? analytics.latest_evaluation.quality_gate?.passed ? "质量门禁通过" : "质量门禁待提升" : "等待首次评测"}
      </span>
    </div>

    <div className="analytics-tabs" role="tablist" aria-label="运营看板视图">
      <button role="tab" aria-selected={tab === "business"} className={tab === "business" ? "active" : ""} onClick={() => setTab("business")}>业务指标</button>
      <button role="tab" aria-selected={tab === "tokens"} className={tab === "tokens" ? "active" : ""} onClick={() => setTab("tokens")}>Token 消耗</button>
    </div>

    {tab === "business" ? <>
      <div className="dashboard-metrics analytics-metrics">
        <div className="panel"><b>{analytics.executions}</b><span>累计问答</span><small>平均节点 {analytics.average_step_duration_ms}ms</small></div>
        <div className="panel"><b>{Math.round(analytics.tool_success_rate * 100)}%</b><span>Tool 成功率</span><small>{analytics.failed_tool_count} 次失败</small></div>
        <div className="panel"><b>{analytics.positive_feedback_rate === null ? "—" : `${Math.round(analytics.positive_feedback_rate * 100)}%`}</b><span>回答满意度</span><small>{analytics.feedback_count} 条反馈</small></div>
        <div className="panel"><b>{analytics.knowledge_gap_count}</b><span>知识缺口</span><small>{analytics.active_knowledge_document_count} 个启用文档</small></div>
        <div className="panel"><b>{analytics.high_risk_count}</b><span>高风险问答</span><small>{analytics.security_event_count} 条安全事件</small></div>
        <div className="panel"><b>{analytics.open_handoffs}</b><span>待处理转接</span><small>需 HR / 法务跟进</small></div>
      </div>
      <div className="analytics-dashboard-grid">
        <section className="panel analytics-card wide"><div className="analytics-title"><div><h2>近 7 天问答趋势</h2><p>Agent 实际执行次数</p></div></div><div className="daily-chart">{analytics.daily_executions.map((item) => <div key={item.date}><span>{item.count}</span><i style={{ height: `${Math.max(6, item.count / dailyMax * 100)}%` }}/><small>{item.date.slice(5)}</small></div>)}</div></section>
        <section className="panel analytics-card"><h2>路由分布</h2><p>Agent 自主选择的处理路径</p>{analytics.route_distribution.length ? analytics.route_distribution.map((item) => <div className="bar-row route-bar" key={item.route}><span>{routeNames[item.route] || item.route}</span><div><i style={{ width: `${item.count / routeMax * 100}%` }}/></div><b>{item.count}</b></div>) : <div className="empty-state">暂无路由数据</div>}</section>
        <section className="panel analytics-card"><h2>风险分布</h2><p>最终风控审核等级</p>{Object.entries(analytics.risk_distribution).map(([level, count]) => <div className={`bar-row risk-${level}`} key={level}><span>{riskNames[level] || level}</span><div><i style={{ width: `${count / riskMax * 100}%` }}/></div><b>{count}</b></div>)}</section>
        <section className="panel analytics-card"><h2>高频主题</h2><p>问题意图与能力条件组合</p>{analytics.top_topics.length ? analytics.top_topics.map((item) => <div className="topic-row" key={item.topic}><code>{item.topic}</code><b>{item.count}</b></div>) : <div className="empty-state">暂无执行数据</div>}</section>
        <section className="panel analytics-card"><h2>Tool 性能</h2><p>按平均执行时间排序</p>{analytics.slowest_tools.length ? analytics.slowest_tools.map((item) => <div className="tool-performance" key={item.tool_id}><div><strong>{item.tool_id}</strong><small>{item.calls} 次调用</small></div><b>{item.average_ms}ms</b></div>) : <div className="empty-state">暂无 Tool 调用数据</div>}</section>
        <section className="panel analytics-card wide"><div className="analytics-title"><div><h2>知识缺口队列</h2><p>未找到可靠依据的问题，可优先补充知识文档或加入 Bad Case</p></div><span className="badge orange">{analytics.knowledge_gaps.length} 条待处理</span></div>{analytics.knowledge_gaps.length ? <div className="gap-list">{analytics.knowledge_gaps.map((item) => <article key={item.id}><code>{item.id}</code><div><strong>{item.question}</strong><small>{item.employee_name} · {new Date(item.created_at).toLocaleString("zh-CN")}</small></div></article>)}</div> : <div className="empty-state">当前没有检测到知识缺口</div>}</section>
        {analytics.latest_evaluation && <section className="panel quality-gate-card"><div><span className={analytics.latest_evaluation.quality_gate?.passed ? "gate-pass" : "gate-warn"}>{analytics.latest_evaluation.quality_gate?.passed ? "✓" : "!"}</span><div><h2>自动评测质量门禁</h2><p>持续关注总体、路由与风险准确率</p></div></div><div className="quality-values"><span><b>{Math.round(analytics.latest_evaluation.pass_rate * 100)}%</b>总体</span><span><b>{Math.round(analytics.latest_evaluation.route_accuracy * 100)}%</b>路由</span><span><b>{Math.round(analytics.latest_evaluation.risk_accuracy * 100)}%</b>风险</span></div></section>}
      </div>
    </> : <>
      <div className="token-toolbar panel">
        <div className="token-segment" aria-label="统计周期">{[7, 30].map((value) => <button className={days === value ? "active" : ""} key={value} disabled={loading} onClick={() => { setDays(value); void loadTokens(value, source); }}>{value} 天</button>)}</div>
        <label><span>来源</span><select value={source} disabled={loading} onChange={(event) => { const value = event.target.value; setSource(value); void loadTokens(days, value); }}>{availableSources.map((item) => <option value={item} key={item}>{sourceNames[item]}</option>)}</select></label>
        <button className="secondary token-config-button" onClick={() => setConfigOpen((value) => !value)}>{configOpen ? "收起配置" : "预算与单价"}</button>
      </div>

      {configOpen && <section className="panel token-config-panel">
        <div className="token-section-head"><div><h2>Token 预算与模型单价</h2><p>预算设为 0 表示不启用；单价按每百万 Token 计算。</p></div><button className="primary compact" disabled={saving} onClick={() => void saveConfig()}>{saving ? "保存中…" : "保存配置"}</button></div>
        <div className="token-config-grid">
          <label>每日预算 Token<input type="number" min="0" value={configDraft.daily_budget_tokens} onChange={(event) => setConfigDraft({ ...configDraft, daily_budget_tokens: Number(event.target.value) })}/></label>
          <label>每月预算 Token<input type="number" min="0" value={configDraft.monthly_budget_tokens} onChange={(event) => setConfigDraft({ ...configDraft, monthly_budget_tokens: Number(event.target.value) })}/></label>
          <label>预警阈值 %<input type="number" min="1" max="99" value={configDraft.warning_threshold_percent} onChange={(event) => setConfigDraft({ ...configDraft, warning_threshold_percent: Number(event.target.value) })}/></label>
          <label>严重阈值 %<input type="number" min="2" max="100" value={configDraft.critical_threshold_percent} onChange={(event) => setConfigDraft({ ...configDraft, critical_threshold_percent: Number(event.target.value) })}/></label>
        </div>
        <div className="token-pricing-head"><strong>模型价格</strong><button className="secondary" onClick={addPricing}>＋ 添加模型</button></div>
        {configDraft.model_pricing.length ? <div className="token-pricing-list">{configDraft.model_pricing.map((price, index) => <div className="token-pricing-row" key={`${price.provider}-${price.model}-${index}`}>
          <label>Provider<input value={price.provider} onChange={(event) => updatePricing(index, { provider: event.target.value })}/></label>
          <label>模型<input value={price.model} onChange={(event) => updatePricing(index, { model: event.target.value })}/></label>
          <label>输入单价<input type="number" min="0" step="0.0001" value={price.input_price_per_million} onChange={(event) => updatePricing(index, { input_price_per_million: Number(event.target.value) })}/></label>
          <label>输出单价<input type="number" min="0" step="0.0001" value={price.output_price_per_million} onChange={(event) => updatePricing(index, { output_price_per_million: Number(event.target.value) })}/></label>
          <label>缓存单价<input type="number" min="0" step="0.0001" value={price.cached_input_price_per_million ?? ""} onChange={(event) => updatePricing(index, { cached_input_price_per_million: event.target.value === "" ? null : Number(event.target.value) })}/></label>
          <button className="token-remove-price" title="删除模型价格" aria-label={`删除 ${price.model || "模型"} 价格`} onClick={() => setConfigDraft((current) => ({ ...current, model_pricing: current.model_pricing.filter((_, itemIndex) => itemIndex !== index) }))}>×</button>
        </div>)}</div> : <div className="token-empty-config">尚未配置模型单价，费用将显示为“待配置”。</div>}
      </section>}

      <div className="dashboard-metrics analytics-metrics token-metrics">
        <div className="panel"><b>{formatTokens(tokenData.today_tokens)}</b><span>今日 Token</span><small>{sourceNames[source] || source}</small></div>
        <div className="panel"><b>{formatTokens(tokenData.month_tokens)}</b><span>本月 Token</span><small>按上海时区统计</small></div>
        <div className="panel"><b>{formatTokens(tokenData.average_tokens_per_run)}</b><span>平均每次问答</span><small>{tokenData.reported_runs} 次有数据</small></div>
        <div className="panel"><b>{formatTokens(tokenData.calls)}</b><span>模型调用</span><small>Planner + Skills</small></div>
        <div className="panel"><b>{formatCost(tokenData.estimated_cost, tokenData.currency)}</b><span>周期预估费用</span><small>单价覆盖 {formatPercent(tokenData.pricing_coverage_rate)}</small></div>
        <div className="panel"><b>{formatPercent(tokenData.reporting_rate)}</b><span>usage 覆盖率</span><small>{tokenData.unreported_runs} 次未上报</small></div>
      </div>

      <div className="token-notices">
        <span>{tokenData.notes.fixture}</span><span>{tokenData.notes.coze}</span><span>{tokenData.notes.historical}</span>
      </div>

      <div className="analytics-dashboard-grid token-dashboard-grid">
        <section className="panel analytics-card wide">
          <div className="token-section-head"><div><h2>Token 消耗趋势</h2><p>输入、输出 Token 按天堆叠展示</p></div><div className="token-legend"><span className="input">输入</span><span className="output">输出</span></div></div>
          <div className="token-chart-scroll"><div className="token-chart" style={{ gridTemplateColumns: `repeat(${Math.max(1, tokenData.daily.length)}, minmax(24px, 1fr))` }}>{tokenData.daily.map((item) => <div className="token-day" key={item.date}><span>{item.total_tokens ? formatTokens(item.total_tokens) : "0"}</span><div className="token-stack"><i style={{ height: `${item.input_tokens / tokenDailyMax * 100}%` }}/><em style={{ height: `${item.output_tokens / tokenDailyMax * 100}%` }}/></div><small>{item.date.slice(5)}</small></div>)}</div></div>
        </section>

        <section className="panel analytics-card"><h2>模型消耗</h2><p>按 Provider 与模型汇总</p>{tokenData.by_model.length ? tokenData.by_model.map((item) => <div className="token-ranking" key={`${item.provider}-${item.model}`}><div><strong>{item.model}</strong><small>{item.provider} · {item.calls} 次</small></div><div className="token-ranking-bar"><i style={{ width: `${item.total_tokens / tokenModelMax * 100}%` }}/></div><b>{formatTokens(item.total_tokens)}</b></div>) : <div className="empty-state">当前周期没有真实 Token 数据</div>}</section>
        <section className="panel analytics-card"><h2>Skill 消耗排行</h2><p>包含 Planner 与所有大模型 Skill</p>{tokenData.by_skill.length ? tokenData.by_skill.map((item) => <div className="token-ranking" key={item.skill_id}><div><strong>{skillNames[item.skill_id] || item.skill_id}</strong><small>{item.calls} 次 · 均值 {formatTokens(item.average_tokens)}</small></div><div className="token-ranking-bar skill"><i style={{ width: `${item.total_tokens / tokenSkillMax * 100}%` }}/></div><b>{formatTokens(item.total_tokens)}</b></div>) : <div className="empty-state">当前周期没有 Skill 用量数据</div>}</section>

        <section className="panel analytics-card"><h2>来源分布</h2><p>区分正式问答、Demo、Eval 与重试</p>{tokenData.by_source.length ? tokenData.by_source.map((item) => <div className="token-source-row" key={item.source}><div><strong>{sourceNames[item.source] || item.source}</strong><small>{item.runs} 次运行 · 均值 {formatTokens(item.average_tokens)}</small></div><b>{formatTokens(item.total_tokens)}</b></div>) : <div className="empty-state">当前周期没有来源数据</div>}</section>
        <section className="panel analytics-card"><h2>预算状态</h2><p>预算统计始终覆盖全部真实运行来源</p><div className="token-budget-list"><BudgetBar label="每日预算" value={tokenData.budgets.daily}/><BudgetBar label="每月预算" value={tokenData.budgets.monthly}/></div></section>

        <section className="panel analytics-card wide token-run-section">
          <div className="token-section-head"><div><h2>高消耗运行</h2><p>定位高 Token 问题、模型和执行来源</p></div><span className="badge blue">{tokenData.high_usage_runs.length} 条</span></div>
          {tokenData.high_usage_runs.length ? <div className="token-run-table-wrap"><div className="token-run-table">
            <div className="token-run-row token-run-head"><span>Run ID</span><span>问题</span><span>来源</span><span>模型</span><span>输入 / 输出</span><span>总 Token</span><span>费用</span><span>操作</span></div>
            {tokenData.high_usage_runs.map((run) => <div className="token-run-row" key={run.run_id}><code>{run.run_id}</code><span title={run.question}>{run.question}</span><span>{sourceNames[run.source] || run.source}</span><span title={run.model}>{run.model}</span><span>{formatTokens(run.input_tokens)} / {formatTokens(run.output_tokens)}</span><b>{formatTokens(run.total_tokens)}</b><span>{formatCost(run.cost, tokenData.currency)}</span><Link href={`/runs/${run.run_id}`}>详情</Link></div>)}
          </div></div> : <div className="empty-state">暂无可展示的真实 Token 运行记录</div>}
        </section>
      </div>
    </>}
  </div>;
}
