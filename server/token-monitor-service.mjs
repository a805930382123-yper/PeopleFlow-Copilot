import { readJsonOr, writeJson } from "./json-store.mjs";

const FILE = "token_monitor_config.json";
const DEFAULT_CONFIG = {
  daily_budget_tokens: 0,
  monthly_budget_tokens: 0,
  warning_threshold_percent: 70,
  critical_threshold_percent: 90,
  currency: "CNY",
  model_pricing: [],
};

const nonNegative = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} 必须是大于等于 0 的数字`);
  return number;
};

export async function getTokenMonitorConfig() {
  const saved = await readJsonOr(FILE, DEFAULT_CONFIG);
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    model_pricing: Array.isArray(saved.model_pricing) ? saved.model_pricing : [],
  };
}

export async function updateTokenMonitorConfig(input) {
  const warning = nonNegative(input.warning_threshold_percent, "预警阈值");
  const critical = nonNegative(input.critical_threshold_percent, "严重阈值");
  if (warning > 100 || critical > 100 || warning >= critical) {
    throw new Error("预警阈值必须小于严重阈值，且两者都不能超过 100%");
  }
  const pricing = (Array.isArray(input.model_pricing) ? input.model_pricing : []).map((item, index) => {
    const model = String(item.model || "").trim();
    if (!model) throw new Error(`第 ${index + 1} 条模型价格缺少模型名称`);
    return {
      provider: String(item.provider || "").trim(),
      model,
      input_price_per_million: nonNegative(item.input_price_per_million, `${model} 输入单价`),
      output_price_per_million: nonNegative(item.output_price_per_million, `${model} 输出单价`),
      cached_input_price_per_million: item.cached_input_price_per_million === "" || item.cached_input_price_per_million == null
        ? null
        : nonNegative(item.cached_input_price_per_million, `${model} 缓存输入单价`),
      currency: String(item.currency || input.currency || "CNY").trim().toUpperCase(),
    };
  });
  const next = {
    daily_budget_tokens: Math.round(nonNegative(input.daily_budget_tokens, "每日预算")),
    monthly_budget_tokens: Math.round(nonNegative(input.monthly_budget_tokens, "每月预算")),
    warning_threshold_percent: warning,
    critical_threshold_percent: critical,
    currency: String(input.currency || "CNY").trim().toUpperCase(),
    model_pricing: pricing,
    updated_at: new Date().toISOString(),
  };
  await writeJson(FILE, next);
  return next;
}
