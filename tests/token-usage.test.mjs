import assert from "node:assert/strict";
import test from "node:test";
import { buildTokenAnalytics } from "../server/analytics.mjs";
import { aggregateTokenUsage, estimateTokenCost, normalizeTokenUsage } from "../server/token-usage.mjs";

test("统一规范 OpenAI、DeepSeek 与兼容 Provider 的 usage 字段", () => {
  const standard = normalizeTokenUsage({
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 8 },
  });
  assert.deepEqual(
    {
      input: standard.input_tokens,
      output: standard.output_tokens,
      total: standard.total_tokens,
      cached: standard.cached_tokens,
      reasoning: standard.reasoning_tokens,
      source: standard.usage_source,
    },
    { input: 120, output: 30, total: 150, cached: 20, reasoning: 8, source: "provider" },
  );

  const aliases = normalizeTokenUsage({ input_tokens: 50, output_tokens: 10, prompt_cache_hit_tokens: 12 });
  assert.equal(aliases.total_tokens, 60);
  assert.equal(aliases.cached_tokens, 12);
});

test("Fixture 与未上报调用不会伪装成真实 Token", () => {
  const fixture = normalizeTokenUsage(null, { fixture: true });
  const unavailable = normalizeTokenUsage(null, { calls: 2 });
  assert.equal(fixture.usage_source, "fixture");
  assert.equal(fixture.billable, false);
  assert.equal(unavailable.usage_source, "unavailable");
  assert.equal(unavailable.complete, false);
  assert.equal(unavailable.unreported_calls, 2);
});

test("聚合 Token 并按模型价格估算费用", () => {
  const usage = aggregateTokenUsage([
    normalizeTokenUsage({ prompt_tokens: 100, completion_tokens: 20 }),
    normalizeTokenUsage({ prompt_tokens: 200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 50 } }),
  ]);
  assert.equal(usage.total_tokens, 360);
  assert.equal(usage.calls, 2);
  assert.equal(usage.complete, true);
  assert.equal(estimateTokenCost(usage, {
    input_price_per_million: 10,
    output_price_per_million: 20,
    cached_input_price_per_million: 2,
  }), 0.0038);
});

test("运营聚合区分真实运行、Fixture 与历史未上报数据", () => {
  const plannerUsage = normalizeTokenUsage({ prompt_tokens: 100, completion_tokens: 20 });
  const replyUsage = normalizeTokenUsage({ prompt_tokens: 200, completion_tokens: 40 });
  const logs = [
    {
      id: "RUN-LIVE",
      source: "evaluation",
      mode: "live",
      provider: "openai-compatible",
      model: "demo-model",
      question: "需要准备什么入职材料",
      created_at: "2026-07-30T01:00:00.000Z",
      duration_ms: 1200,
      plan: { token_usage: plannerUsage, planner_runtime: { provider: "openai-compatible", model: "demo-model" } },
      steps: [{ kind: "skill", capability_id: "reply_generation", provider: "openai-compatible", model: "demo-model", token_usage: replyUsage }],
    },
    { id: "RUN-HISTORY", source: "workbench", mode: "live", model: "demo-model", question: "历史运行", created_at: "2026-07-30T02:00:00.000Z", steps: [] },
    { id: "RUN-FIXTURE", source: "demo", mode: "fixture", model: "fixture", question: "演示运行", created_at: "2026-07-30T03:00:00.000Z", steps: [] },
  ];
  const config = {
    daily_budget_tokens: 1000,
    monthly_budget_tokens: 10000,
    warning_threshold_percent: 70,
    critical_threshold_percent: 90,
    currency: "CNY",
    model_pricing: [{ provider: "openai-compatible", model: "demo-model", input_price_per_million: 10, output_price_per_million: 20, cached_input_price_per_million: null }],
  };
  const result = buildTokenAnalytics(logs, config, { days: 7, source: "all", now: "2026-07-30T06:00:00.000Z" });
  assert.equal(result.total_tokens, 360);
  assert.equal(result.reported_runs, 1);
  assert.equal(result.unreported_runs, 1);
  assert.equal(result.fixture_runs, 1);
  assert.equal(result.reporting_rate, 0.5);
  assert.equal(result.by_skill.find((item) => item.skill_id === "planner")?.total_tokens, 120);
  assert.equal(result.by_skill.find((item) => item.skill_id === "reply_generation")?.total_tokens, 240);
  assert.equal(result.by_source.find((item) => item.source === "evaluation")?.total_tokens, 360);
  assert.equal(result.estimated_cost, 0.0042);
  assert.equal(result.budgets.daily.status, "normal");
});
