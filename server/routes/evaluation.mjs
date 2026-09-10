import { readJson, updateJson } from "../json-store.mjs";
import {
  batchUpdateEvaluationCases,
  createBadCase,
  createEvaluationCase,
  deleteEvaluationCase,
  duplicateEvaluationCase,
  evaluationOverview,
  getEvaluationCase,
  listEvaluationCases,
  listEvaluationRuns,
  promoteFailures,
  runEvaluation,
  runEvaluationCase,
  updateEvaluationCase,
} from "../evaluation.mjs";
import { readRequestBody, send } from "../http.mjs";

export async function handleEvaluationRoutes(req, res, url, local) {
  if (!url.pathname.startsWith("/api/eval")) return false;
  if (req.method === "GET" && url.pathname === "/api/eval") {
    send(res, 200, await evaluationOverview({ skills: await local.listSkills(), tools: await local.listTools() }));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/eval/cases") {
    send(res, 200, await listEvaluationCases({ suite: url.searchParams.get("suite") || "all" }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/eval/cases") {
    send(res, 201, await createEvaluationCase(await readRequestBody(req)));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/eval/cases/from-run") {
    const payload = await readRequestBody(req);
    const source = await local.getRun(payload.runId || payload.run_id);
    send(res, 201, await createEvaluationCase({
      ...payload,
      question: payload.question || source.question,
      employeeId: payload.employeeId || source.employee_id || source.employee?.id,
      sourceRunId: source.id,
      inputRiskLevel: payload.inputRiskLevel || source.risk_review?.risk_level || "low",
      expectedRiskResult: payload.expectedRiskResult || { inputRiskLevel: source.risk_review?.risk_level || "low", replyShouldBeSafe: true, replyAllowed: true, handoffRequired: Boolean(source.handoff) },
      requiredCapabilities: payload.requiredCapabilities || source.steps?.map((step) => step.capability_id) || [],
      expectedEvidence: payload.expectedEvidence || { required: Boolean(source.evidence?.length), minCount: source.evidence?.length ? 1 : 0 },
    }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/eval/cases/from-failure") {
    const payload = await readRequestBody(req);
    const sourceRun = (await listEvaluationRuns()).find((item) => item.id === payload.evalRunId || item.runId === payload.runId);
    if (!sourceRun) throw Object.assign(new Error("评测运行不存在"), { code: "EVAL_RUN_NOT_FOUND" });
    const sourceCase = await getEvaluationCase(sourceRun.caseId);
    send(res, 201, await createEvaluationCase({ ...sourceCase, id: undefined, name: `${sourceCase.name}（失败回流）`, isBadCase: true, sourceRunId: sourceRun.runId, failure_mode: sourceRun.scoreResult?.reason || "评测失败回流" }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/eval/cases/batch-update") {
    send(res, 200, await batchUpdateEvaluationCases(await readRequestBody(req)));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/eval/runs") {
    send(res, 200, await listEvaluationRuns({ caseId: url.searchParams.get("caseId") || undefined }));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/eval/compare") {
    const rows = await readJson("evaluation_runs.json");
    const left = rows.find((item) => item.id === url.searchParams.get("left"));
    const right = rows.find((item) => item.id === url.searchParams.get("right"));
    if (!left || !right) throw Object.assign(new Error("请选择两个有效评测批次"), { code: "EVAL_COMPARE_BATCH_REQUIRED" });
    send(res, 200, {
      left,
      right,
      delta: {
        pass_rate: Number((right.pass_rate - left.pass_rate).toFixed(3)),
        route_accuracy: Number((right.route_accuracy - left.route_accuracy).toFixed(3)),
        risk_accuracy: Number((right.risk_accuracy - left.risk_accuracy).toFixed(3)),
        availability_rate: Number(((right.availability_rate || 0) - (left.availability_rate || 0)).toFixed(3)),
        duration_ms: (right.duration_ms || 0) - (left.duration_ms || 0),
      },
    });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/eval/batches") {
    send(res, 200, await readJson("evaluation_runs.json"));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/eval/batches") {
    send(res, 201, await runEvaluation(await readRequestBody(req), { agentRunner: local.executeAgent }));
    return true;
  }

  const batchRetry = url.pathname.match(/^\/api\/eval\/batches\/([^/]+)\/retry$/);
  const batchStop = url.pathname.match(/^\/api\/eval\/batches\/([^/]+)\/stop$/);
  const batchMatch = url.pathname.match(/^\/api\/eval\/batches\/([^/]+)$/);
  if (req.method === "GET" && batchMatch) {
    const batch = (await readJson("evaluation_runs.json")).find((item) => item.id === batchMatch[1]);
    if (!batch) throw Object.assign(new Error("评测批次不存在"), { code: "EVAL_BATCH_NOT_FOUND" });
    send(res, 200, batch);
    return true;
  }
  if (req.method === "POST" && batchRetry) {
    const batch = (await readJson("evaluation_runs.json")).find((item) => item.id === batchRetry[1]);
    if (!batch) throw Object.assign(new Error("评测批次不存在"), { code: "EVAL_BATCH_NOT_FOUND" });
    const payload = await readRequestBody(req);
    const statuses = Array.isArray(payload.statuses) && payload.statuses.length ? payload.statuses : ["FAIL", "ERROR"];
    const caseIds = (batch.eval_runs || []).filter((item) => statuses.includes(item.status)).map((item) => item.caseId);
    if (!caseIds.length) throw Object.assign(new Error("该批次没有符合重试条件的用例"), { code: "EVAL_RETRY_EMPTY" });
    send(res, 201, await runEvaluation({ suite: "all", caseIds, limit: caseIds.length, name: `${batch.name || batch.id} · 重试` }, { agentRunner: local.executeAgent }));
    return true;
  }
  if (req.method === "POST" && batchStop) {
    let stoppedBatch;
    await updateJson("evaluation_runs.json", (rows) => {
      const index = rows.findIndex((item) => item.id === batchStop[1]);
      if (index < 0) throw Object.assign(new Error("评测批次不存在"), { code: "EVAL_BATCH_NOT_FOUND" });
      stoppedBatch = { ...rows[index], status: rows[index].status === "running" ? "stopped" : rows[index].status, stop_requested_at: new Date().toISOString() };
      rows[index] = stoppedBatch;
    });
    send(res, 200, stoppedBatch);
    return true;
  }

  const caseRun = url.pathname.match(/^\/api\/eval\/cases\/([^/]+)\/run$/);
  const caseDuplicate = url.pathname.match(/^\/api\/eval\/cases\/([^/]+)\/duplicate$/);
  const caseMatch = url.pathname.match(/^\/api\/eval\/cases\/([^/]+)$/);
  if (req.method === "POST" && caseRun) {
    send(res, 200, await runEvaluationCase(caseRun[1], local.executeAgent, await readRequestBody(req)));
    return true;
  }
  if (req.method === "POST" && caseDuplicate) {
    send(res, 201, await duplicateEvaluationCase(caseDuplicate[1]));
    return true;
  }
  if (req.method === "GET" && caseMatch) {
    send(res, 200, await getEvaluationCase(caseMatch[1]));
    return true;
  }
  if (req.method === "PATCH" && caseMatch) {
    send(res, 200, await updateEvaluationCase(caseMatch[1], await readRequestBody(req)));
    return true;
  }
  if (req.method === "DELETE" && caseMatch) {
    send(res, 200, await deleteEvaluationCase(caseMatch[1]));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/evaluations/run") {
    send(res, 200, await runEvaluation(await readRequestBody(req), { agentRunner: local.executeAgent }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/evaluations/cases") {
    send(res, 201, await createBadCase(await readRequestBody(req)));
    return true;
  }
  const promote = url.pathname.match(/^\/api\/evaluations\/runs\/([^/]+)\/promote-failures$/);
  if (req.method === "POST" && promote) {
    send(res, 200, await promoteFailures(promote[1]));
    return true;
  }
  return false;
}
