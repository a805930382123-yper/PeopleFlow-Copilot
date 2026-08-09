const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const firstNumber = (...values) => {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
};

export function normalizeTokenUsage(raw, options = {}) {
  const calls = Math.max(0, Number(options.calls ?? 1) || 0);
  if (options.fixture) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      calls,
      reported_calls: 0,
      unreported_calls: 0,
      usage_source: "fixture",
      billable: false,
      complete: true,
    };
  }

  const inputTokens = firstNumber(raw?.input_tokens, raw?.prompt_tokens);
  const outputTokens = firstNumber(raw?.output_tokens, raw?.completion_tokens);
  const totalTokens = firstNumber(
    raw?.total_tokens,
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
  );
  const cachedTokens = firstNumber(
    raw?.cached_tokens,
    raw?.cache_read_input_tokens,
    raw?.prompt_cache_hit_tokens,
    raw?.prompt_tokens_details?.cached_tokens,
    raw?.input_tokens_details?.cached_tokens,
  );
  const reasoningTokens = firstNumber(
    raw?.reasoning_tokens,
    raw?.completion_tokens_details?.reasoning_tokens,
    raw?.output_tokens_details?.reasoning_tokens,
  );
  const reported = totalTokens !== null || inputTokens !== null || outputTokens !== null;

  return {
    input_tokens: inputTokens ?? 0,
    output_tokens: outputTokens ?? 0,
    total_tokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    cached_tokens: cachedTokens ?? 0,
    reasoning_tokens: reasoningTokens ?? 0,
    calls,
    reported_calls: reported ? 1 : 0,
    unreported_calls: reported ? Math.max(0, calls - 1) : calls,
    usage_source: reported ? (options.source || "provider") : "unavailable",
    billable: options.billable !== false,
    complete: reported && calls <= 1,
  };
}

export function aggregateTokenUsage(usages = [], options = {}) {
  const rows = usages.filter(Boolean);
  const totalCalls = options.total_calls === undefined
    ? rows.reduce((sum, item) => sum + Math.max(0, Number(item.calls || 0)), 0)
    : Math.max(0, Number(options.total_calls || 0));
  const reportedCalls = rows.reduce((sum, item) => sum + Math.max(0, Number(item.reported_calls || 0)), 0);
  const fixtureCalls = rows
    .filter((item) => item.usage_source === "fixture")
    .reduce((sum, item) => sum + Math.max(0, Number(item.calls || 0)), 0);
  const hasReportedUsage = rows.some((item) => ["provider", "estimated"].includes(item.usage_source));
  const onlyFixture = rows.length > 0 && rows.every((item) => item.usage_source === "fixture");
  const unreportedCalls = Math.max(
    rows.reduce((sum, item) => sum + Math.max(0, Number(item.unreported_calls || 0)), 0),
    totalCalls - reportedCalls - fixtureCalls,
  );

  return {
    input_tokens: rows.reduce((sum, item) => sum + Number(item.input_tokens || 0), 0),
    output_tokens: rows.reduce((sum, item) => sum + Number(item.output_tokens || 0), 0),
    total_tokens: rows.reduce((sum, item) => sum + Number(item.total_tokens || 0), 0),
    cached_tokens: rows.reduce((sum, item) => sum + Number(item.cached_tokens || 0), 0),
    reasoning_tokens: rows.reduce((sum, item) => sum + Number(item.reasoning_tokens || 0), 0),
    calls: totalCalls,
    reported_calls: reportedCalls,
    unreported_calls: unreportedCalls,
    usage_source: hasReportedUsage ? "provider" : onlyFixture ? "fixture" : "unavailable",
    billable: rows.some((item) => item.billable && item.usage_source !== "fixture"),
    complete: rows.length > 0 && rows.every((item) => item.complete) && unreportedCalls === 0,
  };
}

export function estimateTokenCost(usage, pricing) {
  if (!usage || !pricing) return null;
  const inputRate = finiteNumber(pricing.input_price_per_million);
  const outputRate = finiteNumber(pricing.output_price_per_million);
  if (inputRate === null || outputRate === null) return null;
  const cachedRate = finiteNumber(pricing.cached_input_price_per_million);
  const cachedTokens = Math.min(Number(usage.cached_tokens || 0), Number(usage.input_tokens || 0));
  const regularInputTokens = Math.max(0, Number(usage.input_tokens || 0) - cachedTokens);
  const cost = (
    regularInputTokens * inputRate
    + cachedTokens * (cachedRate ?? inputRate)
    + Number(usage.output_tokens || 0) * outputRate
  ) / 1_000_000;
  return Number(cost.toFixed(6));
}

export function pricingFor(config, provider, model) {
  const rows = Array.isArray(config?.model_pricing) ? config.model_pricing : [];
  return rows.find((item) => item.provider === provider && item.model === model)
    || rows.find((item) => !item.provider && item.model === model)
    || null;
}
