const LOCAL_DIMENSIONS = 192;

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(8)));
}

function hashFeature(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function features(text = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  const result = [];
  result.push(...normalized.match(/[a-z0-9][a-z0-9_.-]{1,}/g) || []);
  const chinese = normalized.match(/[\u3400-\u9fff]/g) || [];
  for (let size = 1; size <= 3; size += 1) {
    for (let index = 0; index <= chinese.length - size; index += 1) result.push(chinese.slice(index, index + size).join(""));
  }
  return result;
}

export function localEmbedding(text) {
  const vector = Array(LOCAL_DIMENSIONS).fill(0);
  for (const feature of features(text)) {
    const hash = hashFeature(feature);
    vector[hash % LOCAL_DIMENSIONS] += (hash & 1) === 0 ? 1 : -1;
  }
  return normalizeVector(vector);
}

function endpoint(base, path) {
  const baseUrl = String(base || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiPath = String(path || "/embeddings");
  if (/\/embeddings$/i.test(baseUrl) && apiPath === "/embeddings") return baseUrl;
  return `${baseUrl}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
}

export function getEmbeddingRuntimeConfig() {
  const provider = String(process.env.EMBEDDING_PROVIDER || "local-hash").toLowerCase();
  if (provider === "local-hash") return { provider, model: "local-chinese-ngram-v1", dimensions: LOCAL_DIMENSIONS, configured: true, semantic: false, label: "本地字符向量" };
  const model = String(process.env.EMBEDDING_MODEL || "").trim();
  const apiKey = String(process.env.EMBEDDING_API_KEY || "").trim();
  return { provider: "openai-compatible", model, dimensions: null, configured: Boolean(model && apiKey), semantic: true, label: "OpenAI-Compatible Embedding", endpoint: endpoint(process.env.EMBEDDING_BASE_URL || process.env.LLM_BASE_URL, process.env.EMBEDDING_API_PATH) };
}

export async function embedTexts(texts, options = {}) {
  const runtime = options.forceLocal ? { provider: "local-hash", model: "local-chinese-ngram-v1", configured: true } : getEmbeddingRuntimeConfig();
  if (runtime.provider === "local-hash") return { vectors: texts.map(localEmbedding), provider: runtime.provider, model: runtime.model };
  if (!runtime.configured) {
    const error = new Error("Embedding 配置不完整，请填写 EMBEDDING_API_KEY 和 EMBEDDING_MODEL，或将 EMBEDDING_PROVIDER 设为 local-hash");
    error.code = "EMBEDDING_NOT_CONFIGURED";
    throw error;
  }
  const response = await fetch(runtime.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` },
    body: JSON.stringify({ model: runtime.model, input: texts }),
    signal: AbortSignal.timeout(Number(process.env.EMBEDDING_TIMEOUT_MS || 60000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Embedding 请求失败（${response.status}）：${payload?.error?.message || "未知错误"}`);
    error.code = "EMBEDDING_REQUEST_FAILED";
    throw error;
  }
  const vectors = [...(payload.data || [])].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  if (vectors.length !== texts.length || vectors.some((item) => !Array.isArray(item))) throw new Error("Embedding 服务返回的向量数量不正确");
  return { vectors: vectors.map(normalizeVector), provider: runtime.provider, model: runtime.model, usage: payload.usage || null };
}

export function cosineSimilarity(left = [], right = []) {
  if (!left.length || left.length !== right.length) return 0;
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += Number(left[index] || 0) * Number(right[index] || 0);
  return Math.max(-1, Math.min(1, value));
}
