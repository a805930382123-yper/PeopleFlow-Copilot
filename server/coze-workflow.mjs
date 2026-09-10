import dns from "node:dns";
import { getRuntimeEnv } from "./runtime-env.mjs";

const DEFAULT_WORKFLOW_ID = "7659350798523416603";
const DEFAULT_BASE_URL = "https://api.coze.cn";
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_ANSWER_NODE_TITLES = ["追问后重写输出", "质检通过"];

try { dns.setDefaultResultOrder("ipv4first"); } catch {}

const parseJson = (value) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
};

const canonical = (value) => {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (Object.hasOwn(parsed, "answer") || Object.hasOwn(parsed, "status") || Object.hasOwn(parsed, "risk_level")) {
    return {
      answer: typeof parsed.answer === "string" ? parsed.answer : "",
      status: typeof parsed.status === "string" && parsed.status ? parsed.status : "success",
      risk_level: typeof parsed.risk_level === "string" && parsed.risk_level ? parsed.risk_level : "unknown",
    };
  }
  return null;
};

export function normalizeCozeWorkflowOutput(value) {
  const parsed = parseJson(value);
  const direct = canonical(parsed);
  if (direct) return direct;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const key of ["Output", "output"]) {
      if (!Object.hasOwn(parsed, key)) continue;
      const result = canonical(parsed[key]);
      if (result) return result;
      const nested = parseJson(parsed[key]);
      if (nested && typeof nested === "object" && !Array.isArray(nested)) return { answer: "", status: "empty_output", risk_level: "unknown" };
    }
  }
  return { answer: "", status: "empty_output", risk_level: "unknown" };
}

export function selectApprovedMessageOutput(messages, configuredTitles = DEFAULT_ANSWER_NODE_TITLES) {
  const titles = Array.isArray(configuredTitles) && configuredTitles.length ? configuredTitles : DEFAULT_ANSWER_NODE_TITLES;
  const allowed = new Set(titles.map((title) => String(title).trim()).filter(Boolean));
  const contentByTitle = new Map();
  for (const message of messages || []) {
    const title = String(message?.node_title || "").trim();
    if (!allowed.has(title) || typeof message?.content !== "string") continue;
    contentByTitle.set(title, `${contentByTitle.get(title) || ""}${message.content}`);
  }
  for (const title of titles) {
    const answer = contentByTitle.get(String(title).trim())?.trim();
    if (answer) return { answer, status: "success", risk_level: "low" };
  }
  return null;
}

function messageAsOutput(content) {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return null;
  const structured = normalizeCozeWorkflowOutput(text);
  if (structured.answer || structured.status !== "empty_output") return structured;
  return { answer: text, status: "success", risk_level: "low" };
}

export function selectFinalMessageOutput(messages, configuredTitles = DEFAULT_ANSWER_NODE_TITLES) {
  const configured = selectApprovedMessageOutput(messages, configuredTitles);
  if (configured) return configured;

  const rows = Array.isArray(messages) ? messages : [];
  const endIndex = rows.findIndex((message) => message?.node_type === "End" || message?.node_title === "End");
  const candidates = (endIndex >= 0 ? rows.slice(0, endIndex) : rows).filter((message) => {
    const title = String(message?.node_title || "").trim();
    return title && title !== "End" && message?.node_is_finish !== false && typeof message?.content === "string" && message.content.trim();
  });
  return messageAsOutput(candidates.at(-1)?.content);
}

const configuredTimeout = (override) => {
  const value = Number(override || getRuntimeEnv("COZE_TIMEOUT_MS") || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
};

const errorMessage = (payload, fallback) => payload?.msg || payload?.message || payload?.error_message || fallback;

function networkFailure(error, url) {
  const cause = error?.cause || {};
  const code = cause.code || cause.errno || error?.code || "NETWORK_ERROR";
  const reason = cause.message || error?.message || "未知网络错误";
  const host = (() => { try { return new URL(url).hostname; } catch { return "api.coze.cn"; } })();
  const hints = {
    ENOTFOUND: "DNS 无法解析 Coze 域名",
    EAI_AGAIN: "DNS 查询暂时失败",
    ECONNREFUSED: "连接被拒绝，请检查代理或防火墙",
    ECONNRESET: "连接被重置，请检查网络或稍后重试",
    ETIMEDOUT: "连接超时，请检查网络或代理",
    UND_ERR_CONNECT_TIMEOUT: "连接 Coze 超时，请检查网络或代理",
    DEPTH_ZERO_SELF_SIGNED_CERT: "TLS 证书被本机代理替换，请启用系统证书",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS 证书链无法验证，请检查代理证书",
  };
  const detail = hints[code] || reason;
  const wrapped = new Error(`无法连接 Coze API（${host}，${code}）：${detail}`);
  wrapped.code = code;
  wrapped.cause = error;
  return wrapped;
}

async function request(url, options, signal) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal });
      if (!response.ok) throw new Error(`Coze API 请求失败（HTTP ${response.status}）`);
      return response;
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted || /^Coze API 请求失败/.test(error?.message || "")) throw error;
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  throw networkFailure(lastError, url);
}

export function parseCozeSse(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/);
    const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim() || "";
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "";
    const raw = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!raw) return [];
    return [{ id, event, data: parseJson(raw), raw }];
  });
}

function executeIdFrom(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.execute_id === "string") return value.execute_id;
  const debugUrl = value.debug_url || value.debugUrl || "";
  return typeof debugUrl === "string" ? debugUrl.match(/execute[_-]?id[=/]([^&/?#]+)/i)?.[1] || "" : "";
}

function traceFrame(frame, index) {
  const data = frame.data && typeof frame.data === "object" ? frame.data : {};
  return {
    index,
    event: frame.event || data.event || data.event_type || "Message",
    node_title: data.node_title || data.node_name || "",
    node_type: data.node_type || "",
    node_seq_id: data.node_seq_id ?? null,
    node_is_finish: data.node_is_finish ?? null,
    content: typeof data.content === "string" ? data.content : "",
    timestamp: new Date().toISOString(),
  };
}

async function readRunHistory(baseUrl, workflowId, executeId, headers, signal) {
  if (!executeId) return { answer: "", status: "empty_output", risk_level: "unknown" };
  const response = await request(`${baseUrl}/v1/workflows/${workflowId}/run_histories/${executeId}`, { headers }, signal);
  const payload = await response.json();
  if (payload?.code && payload.code !== 0) throw new Error(errorMessage(payload, "Coze 运行记录查询失败"));
  let data = payload?.data ?? payload;
  if (Array.isArray(data)) data = data[0] || {};
  return normalizeCozeWorkflowOutput(data?.output ?? data?.Output ?? data);
}

function credentials(config = {}) {
  const token = getRuntimeEnv(config.auth_env_var || "COZE_API_TOKEN")?.trim();
  const baseUrl = (config.base_url || getRuntimeEnv("COZE_API_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const workflowId = String(config.workflow_id || getRuntimeEnv("COZE_WORKFLOW_ID") || DEFAULT_WORKFLOW_ID);
  return { token, baseUrl, workflowId, headers: token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : {} };
}

async function consumeStream(response, context) {
  const frames = parseCozeSse(await response.text());
  const trace = frames.map(traceFrame);
  let endContent = "";
  let executeId = "";
  let lastMessage = "";
  const messageOutputs = [];

  for (const frame of frames) {
    const payload = frame.data && typeof frame.data === "object" ? frame.data : {};
    const event = frame.event || payload.event || payload.event_type || "";
    if (payload.code && payload.code !== 0) throw new Error(errorMessage(payload, "Coze 工作流运行失败"));
    if (/error/i.test(event)) throw new Error(errorMessage(payload, "Coze 工作流运行失败"));
    if (/message/i.test(event) && typeof payload.content === "string") {
      lastMessage += payload.content;
      messageOutputs.push({ node_title: payload.node_title || "", content: payload.content, node_is_finish: payload.node_is_finish });
      if (payload.node_type === "End" || payload.node_title === "End") endContent += payload.content;
    }
    if (/interrupt/i.test(event)) {
      const interruptData = payload.interrupt_data || {};
      const question = lastMessage.trim() || payload.node_title || "工作流需要补充信息";
      return {
        output: { answer: question, status: "needs_input", risk_level: "low" },
        trace,
        interrupt: {
          event_id: interruptData.event_id || "",
          interrupt_type: Number(interruptData.type || 0),
          question,
          node_title: payload.node_title || "",
          workflow_id: context.workflowId,
        },
      };
    }
    if (/done/i.test(event)) executeId = executeIdFrom(payload) || executeId;
  }

  let output = endContent ? normalizeCozeWorkflowOutput(endContent) : await readRunHistory(context.baseUrl, context.workflowId, executeId, context.headers, context.signal);
  if (!output.answer && output.status === "empty_output") output = selectFinalMessageOutput(messageOutputs, context.answerNodeTitles) || output;
  return { output, trace, interrupt: null, execute_id: executeId };
}

async function runStream(endpoint, body, config = {}) {
  const started = Date.now();
  const { token, baseUrl, workflowId, headers } = credentials(config);
  if (!token) {
    if ((getRuntimeEnv("COZE_MOCK_MODE") || "true").toLowerCase() !== "true") throw new Error(`未配置 ${config.auth_env_var || "COZE_API_TOKEN"}`);
    return { output: { answer: "这是 Coze 工作流 Tool 的模拟结果。", status: "success", risk_level: "unknown" }, trace: [{ index: 0, event: "Done", node_title: "Mock End", content: "模拟结果", timestamp: new Date().toISOString() }], interrupt: null, mock: true, duration_ms: Date.now() - started };
  }
  const controller = new AbortController();
  const timeout = configuredTimeout(config.timeout_ms);
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await request(`${baseUrl}${endpoint}`, { method: "POST", headers, body: JSON.stringify({ workflow_id: workflowId, ...body }) }, controller.signal);
    return { ...(await consumeStream(response, { baseUrl, workflowId, headers, signal: controller.signal, answerNodeTitles: config.answer_node_titles })), duration_ms: Date.now() - started };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Coze 工作流在 ${timeout}ms 内未完成`);
    throw error;
  } finally { clearTimeout(timer); }
}

export async function runCozeWorkflowDetailed(input, config = {}) {
  for (const key of ["user_id", "CONVERSATION_NAME", "USER_INPUT"]) if (typeof input?.[key] !== "string" || !input[key].trim()) throw new Error(`${key} 必须是非空字符串`);
  return runStream("/v1/workflow/stream_run", { parameters: input }, config);
}

export async function resumeCozeWorkflowDetailed(session, resumeData, config = {}) {
  if (!session?.event_id) throw new Error("缺少工作流中断 event_id");
  if (typeof resumeData !== "string" || !resumeData.trim()) throw new Error("resume_data 必须是非空字符串");
  return runStream("/v1/workflow/stream_resume", { event_id: session.event_id, interrupt_type: Number(session.interrupt_type), resume_data: resumeData }, { ...config, workflow_id: session.workflow_id || config.workflow_id });
}

export async function runCozeWorkflow7659350798523416603(input, config = {}) {
  return (await runCozeWorkflowDetailed(input, { ...config, workflow_id: config.workflow_id || DEFAULT_WORKFLOW_ID })).output;
}
