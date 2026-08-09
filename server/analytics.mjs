import { readJson } from "./json-store.mjs";
import { getTokenMonitorConfig } from "./token-monitor-service.mjs";
import { aggregateTokenUsage, estimateTokenCost, pricingFor } from "./token-usage.mjs";

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

function dateKey(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function monthKey(value = new Date()) {
  return dateKey(value).slice(0, 7);
}

function tokenEntries(run) {
  const rows = [];
  if (run.plan?.token_usage?.calls) {
    rows.push({
      capability_id: "planner",
      provider: run.plan?.planner_runtime?.provider || run.provider || "",
      model: run.plan?.planner_runtime?.model || run.model || "",
      usage: run.plan.token_usage,
    });
  }
  for (const step of run.steps || []) {
    if (step.kind !== "skill" || !step.token_usage?.calls) continue;
    rows.push({
      capability_id: step.capability_id || step.id || "unknown_skill",
      provider: step.provider || run.provider || "",
      model: step.model || run.model || "",
      usage: step.token_usage,
    });
  }
  if (!rows.length && run.token_usage?.calls) {
    rows.push({
      capability_id: "run_total",
      provider: run.provider || "",
      model: run.model || "",
      usage: run.token_usage,
    });
  }
  return rows;
}

function addUsage(target, usage, cost = null) {
  target.input_tokens += Number(usage.input_tokens || 0);
  target.output_tokens += Number(usage.output_tokens || 0);
  target.total_tokens += Number(usage.total_tokens || 0);
  target.cached_tokens += Number(usage.cached_tokens || 0);
  target.reasoning_tokens += Number(usage.reasoning_tokens || 0);
  target.calls += Number(usage.calls || 0);
  if (cost !== null) {
    target.cost = Number(((target.cost || 0) + cost).toFixed(6));
    target.priced_calls += Number(usage.calls || 0);
  }
}

function emptyUsageBucket(extra = {}) {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    calls: 0,
    cost: null,
    priced_calls: 0,
    ...extra,
  };
}

function budgetStatus(used, limit, config) {
  if (!limit) return { limit: 0, used, ratio: null, status: "disabled" };
  const ratio = used / limit;
  const percent = ratio * 100;
  const status = percent >= 100
    ? "exceeded"
    : percent >= config.critical_threshold_percent
      ? "critical"
      : percent >= config.warning_threshold_percent
        ? "warning"
        : "normal";
  return { limit, used, ratio: Number(ratio.toFixed(4)), status };
}

export function buildTokenAnalytics(logs, config, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const days = [7, 30].includes(Number(options.days)) ? Number(options.days) : 30;
  const source = String(options.source || "all");
  const today = dateKey(now);
  const month = monthKey(now);
  const dailyMap = new Map();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = dateKey(new Date(now.getTime() - offset * 86400000));
    dailyMap.set(day, emptyUsageBucket({ date: day }));
  }
  const sourceLogs = source === "all" ? logs : logs.filter((run) => run.source === source);
  const rangeLogs = sourceLogs.filter((run) => dailyMap.has(dateKey(run.created_at)));
  const liveRangeLogs = rangeLogs.filter((run) => run.mode === "live");
  const reportedRangeLogs = liveRangeLogs.filter((run) => tokenEntries(run).some((entry) => entry.usage?.usage_source === "provider"));
  const globalLiveLogs = logs.filter((run) => run.mode === "live");
  const modelMap = new Map();
  const skillMap = new Map();
  const sourceMap = new Map();
  const highRuns = [];
  const summary = emptyUsageBucket();

  for (const run of rangeLogs) {
    const entries = tokenEntries(run).filter((entry) => entry.usage?.usage_source === "provider");
    if (!entries.length) continue;
    const runUsage = aggregateTokenUsage(entries.map((entry) => entry.usage));
    let runCost = null;
    for (const entry of entries) {
      const pricing = pricingFor(config, entry.provider, entry.model);
      const cost = estimateTokenCost(entry.usage, pricing);
      addUsage(summary, entry.usage, cost);

      const modelKey = `${entry.provider || "unknown"}::${entry.model || "unknown"}`;
      const modelBucket = modelMap.get(modelKey) || emptyUsageBucket({ provider: entry.provider || "unknown", model: entry.model || "unknown" });
      addUsage(modelBucket, entry.usage, cost);
      modelMap.set(modelKey, modelBucket);

      const skillBucket = skillMap.get(entry.capability_id) || emptyUsageBucket({ skill_id: entry.capability_id });
      addUsage(skillBucket, entry.usage, cost);
      skillMap.set(entry.capability_id, skillBucket);

      const sourceBucket = sourceMap.get(run.source || "workbench") || emptyUsageBucket({ source: run.source || "workbench", runs: new Set() });
      addUsage(sourceBucket, entry.usage, cost);
      sourceBucket.runs.add(run.id);
      sourceMap.set(sourceBucket.source, sourceBucket);

      if (cost !== null) runCost = Number(((runCost || 0) + cost).toFixed(6));
    }
    const dayBucket = dailyMap.get(dateKey(run.created_at));
    if (dayBucket) addUsage(dayBucket, runUsage, runCost);
    highRuns.push({
      run_id: run.id,
      question: run.question,
      source: run.source || "workbench",
      provider: run.provider || entries[0]?.provider || "unknown",
      model: run.model || entries[0]?.model || "unknown",
      total_tokens: runUsage.total_tokens,
      input_tokens: runUsage.input_tokens,
      output_tokens: runUsage.output_tokens,
      calls: runUsage.calls,
      cost: runCost,
      duration_ms: Number(run.duration_ms || 0),
      created_at: run.created_at,
    });
  }

  const usageFor = (rows) => aggregateTokenUsage(rows.flatMap((run) => tokenEntries(run).map((entry) => entry.usage).filter((usage) => usage?.usage_source === "provider")));
  const todayUsage = usageFor(sourceLogs.filter((run) => dateKey(run.created_at) === today));
  const monthUsage = usageFor(sourceLogs.filter((run) => monthKey(run.created_at) === month));
  const globalTodayUsage = usageFor(globalLiveLogs.filter((run) => dateKey(run.created_at) === today));
  const globalMonthUsage = usageFor(globalLiveLogs.filter((run) => monthKey(run.created_at) === month));
  const reportingRate = liveRangeLogs.length ? reportedRangeLogs.length / liveRangeLogs.length : null;
  const pricingCoverageRate = summary.calls ? summary.priced_calls / summary.calls : null;

  return {
    range_days: days,
    source_filter: source,
    input_tokens: summary.input_tokens,
    output_tokens: summary.output_tokens,
    total_tokens: summary.total_tokens,
    cached_tokens: summary.cached_tokens,
    reasoning_tokens: summary.reasoning_tokens,
    calls: summary.calls,
    today_tokens: todayUsage.total_tokens,
    month_tokens: monthUsage.total_tokens,
    average_tokens_per_run: reportedRangeLogs.length ? Math.round(summary.total_tokens / reportedRangeLogs.length) : 0,
    reported_runs: reportedRangeLogs.length,
    unreported_runs: Math.max(0, liveRangeLogs.length - reportedRangeLogs.length),
    fixture_runs: rangeLogs.filter((run) => run.mode === "fixture").length,
    reporting_rate: reportingRate === null ? null : Number(reportingRate.toFixed(4)),
    estimated_cost: summary.cost,
    pricing_coverage_rate: pricingCoverageRate === null ? null : Number(pricingCoverageRate.toFixed(4)),
    currency: config.currency,
    by_model: [...modelMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_skill: [...skillMap.values()].map((item) => ({ ...item, average_tokens: item.calls ? Math.round(item.total_tokens / item.calls) : 0 })).sort((a, b) => b.total_tokens - a.total_tokens),
    by_source: [...sourceMap.values()].map((item) => ({ ...item, runs: item.runs.size, average_tokens: item.runs.size ? Math.round(item.total_tokens / item.runs.size) : 0 })).sort((a, b) => b.total_tokens - a.total_tokens),
    daily: [...dailyMap.values()],
    high_usage_runs: highRuns.sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 12),
    budgets: {
      daily: budgetStatus(globalTodayUsage.total_tokens, config.daily_budget_tokens, config),
      monthly: budgetStatus(globalMonthUsage.total_tokens, config.monthly_budget_tokens, config),
      warning_threshold_percent: config.warning_threshold_percent,
      critical_threshold_percent: config.critical_threshold_percent,
    },
    config,
    notes: {
      fixture: "Fixture 演示调用不计入真实 Token 与费用。",
      coze: "Coze 工作流内部 Token 未通过当前接口上报，因此仅监测调用次数和耗时。",
      historical: "历史 RunRecord 没有 usage 时记为未上报，不按 0 Token 参与均值。",
    },
  };
}

export async function getAnalytics(options = {}) {
  const [logs, toolTests, handoffs, evalRuns, feedback, securityEvents, documents, tokenConfig] = await Promise.all([
    readJson("execution_logs.json"),
    readJson("tool_test_logs.json"),
    readJson("handoffs.json"),
    readJson("evaluation_runs.json"),
    readJson("conversation_feedback.json"),
    readJson("security_events.json"),
    readJson("knowledge_documents.json"),
    getTokenMonitorConfig(),
  ]);
  const riskDistribution = { low: 0, medium: 0, high: 0, critical: 0 };
  logs.forEach((log) => { const level = log.risk_review?.risk_level || "low"; riskDistribution[level] = (riskDistribution[level] || 0) + 1; });
  const durations = logs.flatMap((log) => log.steps || []).map((step) => Number(step.duration_ms || 0));
  const failedTools = toolTests.filter((test) => test.status === "failed");
  const gaps = logs.filter((log) => /未查询到相关信息|未查询到与/.test(log.final_reply || ""));
  const questions = new Map();
  logs.forEach((log) => { const topic = log.plan?.context ? Object.entries(log.plan.context).filter(([key, value]) => key !== "always" && value).map(([key]) => key).join("+") || "general" : "general"; questions.set(topic, (questions.get(topic) || 0) + 1); });
  const routeDistribution = new Map();
  logs.forEach((log) => { const route = log.plan?.route_decision?.type || "general_knowledge"; routeDistribution.set(route, (routeDistribution.get(route) || 0) + 1); });
  const daily = new Map();
  for (let offset = 6; offset >= 0; offset -= 1) { const date = dateKey(new Date(Date.now() - offset * 86400000)); daily.set(date, 0); }
  logs.forEach((log) => { const date = dateKey(log.created_at); if (daily.has(date)) daily.set(date, daily.get(date) + 1); });
  const toolDurations = new Map();
  logs.flatMap((log) => log.steps || []).filter((step) => step.kind === "tool").forEach((step) => { const current = toolDurations.get(step.capability_id) || []; current.push(Number(step.duration_ms || 0)); toolDurations.set(step.capability_id, current); });
  const positive = feedback.filter((item) => item.rating === "up").length;
  const rated = feedback.filter((item) => ["up", "down"].includes(item.rating)).length;
  return {
    executions: logs.length,
    average_step_duration_ms: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    tool_success_rate: toolTests.length ? Number(((toolTests.length - failedTools.length) / toolTests.length).toFixed(3)) : 1,
    failed_tool_count: failedTools.length,
    knowledge_gap_count: gaps.length,
    open_handoffs: handoffs.filter((item) => item.status === "open").length,
    high_risk_count: (riskDistribution.high || 0) + (riskDistribution.critical || 0),
    feedback_count: feedback.length,
    positive_feedback_rate: rated ? Number((positive / rated).toFixed(3)) : null,
    security_event_count: securityEvents.length,
    knowledge_document_count: documents.length,
    active_knowledge_document_count: documents.filter((item) => item.status === "active").length,
    risk_distribution: riskDistribution,
    route_distribution: [...routeDistribution.entries()].sort((a, b) => b[1] - a[1]).map(([route, count]) => ({ route, count })),
    daily_executions: [...daily.entries()].map(([date, count]) => ({ date, count })),
    top_topics: [...questions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([topic, count]) => ({ topic, count })),
    knowledge_gaps: gaps.slice(0, 8).map((log) => ({ id: log.id, question: log.question, created_at: log.created_at, employee_name: log.employee?.name || "未知员工" })),
    slowest_tools: [...toolDurations.entries()].map(([tool_id, values]) => ({ tool_id, average_ms: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length), calls: values.length })).sort((a, b) => b.average_ms - a.average_ms).slice(0, 6),
    latest_evaluation: evalRuns[0] ? { id: evalRuns[0].id, pass_rate: evalRuns[0].pass_rate, route_accuracy: evalRuns[0].route_accuracy, risk_accuracy: evalRuns[0].risk_accuracy, quality_gate: evalRuns[0].quality_gate || null, created_at: evalRuns[0].created_at } : null,
    token_usage: buildTokenAnalytics(logs, tokenConfig, options),
  };
}
