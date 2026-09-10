import { readJson, updateJson } from "../json-store.mjs";
import { getSkill, saveSkill, skillVersion, skillVersions, toggleSkill, restoreSkillVersion } from "../skill-registry.mjs";
import { createTool, deleteTool, duplicateTool, getTool, saveTool, toolVersion, toolVersions, restoreToolVersion } from "../tool-registry.mjs";
import { getPlan, getPlannerConfig, plannerVersion, plannerVersions, restorePlannerVersion, savePlan } from "../plan-registry.mjs";
import { testSkill } from "../executor.mjs";
import { getLlmConfig, switchLlmProvider, testManagedLlmConnection, updateLlmConfig } from "../llm-config-service.mjs";
import { readRequestBody, send, sendData } from "../http.mjs";

export async function handleManagementRoutes(req, res, url, local) {
  if (req.method === "GET" && url.pathname === "/api/skills") {
    sendData(res, 200, await local.managementSkills());
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/tools") {
    sendData(res, 200, await local.managementTools());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/tools") {
    send(res, 201, await createTool(await readRequestBody(req)));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/planner") {
    sendData(res, 200, { planner: await getPlannerConfig(), skills: await local.listSkills(), tools: (await local.listTools()).map(local.publicTool), versions: await plannerVersions() });
    return true;
  }
  if (req.method === "PUT" && url.pathname === "/api/planner") {
    sendData(res, 200, await savePlan("default_onboarding_plan", await readRequestBody(req)));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/planner/preview") {
    sendData(res, 200, await local.previewPlanner(await readRequestBody(req)));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/planner/versions") {
    sendData(res, 200, await plannerVersions());
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/llm-config") {
    sendData(res, 200, await getLlmConfig());
    return true;
  }
  if (req.method === "PUT" && url.pathname === "/api/llm-config") {
    sendData(res, 200, await updateLlmConfig(await readRequestBody(req)));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/llm-config/switch") {
    sendData(res, 200, await switchLlmProvider(await readRequestBody(req)));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/llm-config/test") {
    sendData(res, 200, await testManagedLlmConnection());
    return true;
  }

  const plannerVersionRestore = url.pathname.match(/^\/api\/planner\/versions\/([^/]+)\/restore$/);
  const plannerVersionMatch = url.pathname.match(/^\/api\/planner\/versions\/([^/]+)$/);
  if (req.method === "GET" && plannerVersionMatch) {
    sendData(res, 200, await plannerVersion("default_onboarding_plan", plannerVersionMatch[1]));
    return true;
  }
  if (req.method === "POST" && plannerVersionRestore) {
    sendData(res, 200, await restorePlannerVersion("default_onboarding_plan", plannerVersionRestore[1], (await readRequestBody(req)).change_note));
    return true;
  }

  const skillVersionRestore = url.pathname.match(/^\/api\/skills\/([^/]+)\/versions\/([^/]+)\/restore$/);
  const skillVersionMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/versions\/([^/]+)$/);
  const skillVersionsMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/versions$/);
  const skillToggleMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/toggle$/);
  const skillTestMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/test$/);
  const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (req.method === "GET" && skillVersionsMatch) {
    sendData(res, 200, await skillVersions(skillVersionsMatch[1]));
    return true;
  }
  if (req.method === "GET" && skillVersionMatch) {
    sendData(res, 200, await skillVersion(skillVersionMatch[1], skillVersionMatch[2]));
    return true;
  }
  if (req.method === "POST" && skillVersionRestore) {
    sendData(res, 200, await restoreSkillVersion(skillVersionRestore[1], skillVersionRestore[2], (await readRequestBody(req)).change_note));
    return true;
  }
  if (req.method === "POST" && skillToggleMatch) {
    const payload = await readRequestBody(req);
    sendData(res, 200, await toggleSkill(skillToggleMatch[1], payload.enabled, payload.change_note));
    return true;
  }
  if (req.method === "GET" && skillMatch) {
    sendData(res, 200, await getSkill(skillMatch[1], false));
    return true;
  }
  if (req.method === "PUT" && skillMatch) {
    send(res, 200, await saveSkill(skillMatch[1], await readRequestBody(req)));
    return true;
  }
  if (req.method === "POST" && skillTestMatch) {
    const skill = await getSkill(skillTestMatch[1], false);
    const payload = await readRequestBody(req);
    const result = await testSkill(skill, payload.input || "");
    await saveSkill(skill.id, { last_test: { input: payload.input, output: result, tested_at: new Date().toISOString() } });
    send(res, 200, result);
    return true;
  }

  const planMatch = url.pathname.match(/^\/api\/plans\/([^/]+)$/);
  if (req.method === "GET" && planMatch) {
    send(res, 200, await getPlan(planMatch[1]));
    return true;
  }
  if (req.method === "PUT" && planMatch) {
    send(res, 200, await savePlan(planMatch[1], await readRequestBody(req)));
    return true;
  }

  const toolVersionRestore = url.pathname.match(/^\/api\/tools\/([^/]+)\/versions\/([^/]+)\/restore$/);
  const toolVersionMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/versions\/([^/]+)$/);
  const toolVersionsMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/versions$/);
  const toolTestsMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/tests$/);
  const toolToggleMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/toggle$/);
  const toolDuplicate = url.pathname.match(/^\/api\/tools\/([^/]+)\/duplicate$/);
  const toolTestMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/test$/);
  const toolMatch = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
  if (req.method === "GET" && toolVersionsMatch) {
    sendData(res, 200, await toolVersions(toolVersionsMatch[1]));
    return true;
  }
  if (req.method === "GET" && toolVersionMatch) {
    sendData(res, 200, await toolVersion(toolVersionMatch[1], toolVersionMatch[2]));
    return true;
  }
  if (req.method === "POST" && toolVersionRestore) {
    sendData(res, 200, await restoreToolVersion(toolVersionRestore[1], toolVersionRestore[2], (await readRequestBody(req)).change_note));
    return true;
  }
  if (req.method === "GET" && toolTestsMatch) {
    sendData(res, 200, (await readJson("tool_test_logs.json")).filter((item) => item.tool_id === toolTestsMatch[1]));
    return true;
  }
  if (req.method === "POST" && toolToggleMatch) {
    const payload = await readRequestBody(req);
    sendData(res, 200, await saveTool(toolToggleMatch[1], { enabled: payload.enabled, change_note: payload.change_note }));
    return true;
  }
  if (req.method === "GET" && toolMatch) {
    sendData(res, 200, local.publicTool(await getTool(toolMatch[1], false)));
    return true;
  }
  if (req.method === "POST" && toolDuplicate) {
    send(res, 201, await duplicateTool(toolDuplicate[1]));
    return true;
  }
  if (req.method === "POST" && toolTestMatch) {
    const tool = await getTool(toolTestMatch[1], false);
    if (!tool.enabled) throw new Error(`Tool 已禁用：${tool.name}`);
    const payload = await readRequestBody(req);
    send(res, 200, await local.runToolTest(tool, payload.input && typeof payload.input === "object" ? payload.input : {}));
    return true;
  }
  if (req.method === "PUT" && toolMatch) {
    send(res, 200, await saveTool(toolMatch[1], await readRequestBody(req)));
    return true;
  }
  if (req.method === "DELETE" && toolMatch) {
    await updateJson("plans.json", (plans) => plans.map((plan) => {
      const removed = new Set(plan.nodes.filter((node) => node.capability_id === toolMatch[1]).map((node) => node.id));
      return removed.size ? { ...plan, nodes: plan.nodes.filter((node) => !removed.has(node.id)).map((node) => ({ ...node, depends_on: node.depends_on.filter((dep) => !removed.has(dep)) })) } : plan;
    }), []);
    send(res, 200, await deleteTool(toolMatch[1]));
    return true;
  }

  const testRerun = url.pathname.match(/^\/api\/tool-tests\/([^/]+)\/rerun$/);
  if (req.method === "POST" && testRerun) {
    const previous = (await readJson("tool_test_logs.json")).find((item) => item.id === testRerun[1]);
    if (!previous) throw new Error("Tool 测试记录不存在");
    send(res, 200, await local.runToolTest(await getTool(previous.tool_id, false), previous.input, previous.id));
    return true;
  }
  return false;
}
