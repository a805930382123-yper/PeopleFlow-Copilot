import { readJson } from "../json-store.mjs";
import { getAnalytics } from "../analytics.mjs";
import { getLlmRuntimeConfig, testLlmConnection } from "../llm.mjs";
import { getTokenMonitorConfig, updateTokenMonitorConfig } from "../token-monitor-service.mjs";
import { getRuntimeEnv, reloadRuntimeSecrets } from "../runtime-env.mjs";
import { readRequestBody, send } from "../http.mjs";

export async function handleSystemRoutes(req, res, url, local) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    const llm = getLlmRuntimeConfig();
    send(res, 200, {
      ok: true,
      mode: llm.mode,
      llm_mode: llm.mode,
      llm_provider: llm.provider,
      llm_model: llm.model,
      llm_model_source: llm.model_source,
      planner_mode: (getRuntimeEnv("PLANNER_MODE") || "hybrid").toLowerCase(),
      llm_endpoint: llm.endpoint,
      llm_configured: llm.configured,
      coze_mode: getRuntimeEnv("COZE_API_TOKEN") ? "live" : (getRuntimeEnv("COZE_MOCK_MODE") || "false").toLowerCase() === "true" ? "mock" : "unconfigured",
      version: "1.6.0",
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/system/reload-env") {
    const result = reloadRuntimeSecrets();
    const llm = getLlmRuntimeConfig();
    send(res, 200, { ok: true, ...result, llm_configured: llm.configured, missing: llm.missing });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    send(res, 200, await local.bootstrap());
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/system/data-health") {
    send(res, 200, await local.dataHealth());
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/employees") {
    send(res, 200, await readJson("employees.json"));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/demo/bootstrap") {
    send(res, 200, await local.demoBootstrap(url.searchParams.get("employee_id") || "E001"));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/analytics") {
    send(res, 200, await getAnalytics({ days: Number(url.searchParams.get("days") || 30), source: url.searchParams.get("source") || "all" }));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/token-monitor/config") {
    send(res, 200, await getTokenMonitorConfig());
    return true;
  }
  if (req.method === "PUT" && url.pathname === "/api/token-monitor/config") {
    send(res, 200, await updateTokenMonitorConfig(await readRequestBody(req)));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/llm/test") {
    send(res, 200, await testLlmConnection());
    return true;
  }
  return false;
}
