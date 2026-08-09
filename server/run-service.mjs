import { readJson, writeJson } from "./json-store.mjs";
import { sanitizeForStorage } from "./privacy.mjs";

export async function getRun(id) {
  const run = (await readJson("execution_logs.json")).find((item) => item.id === id);
  if (!run) {
    const error = new Error(`运行记录不存在：${id}`);
    error.status = 404;
    error.code = "RUN_NOT_FOUND";
    throw error;
  }
  return run;
}

export async function listRuns(searchParams = new URLSearchParams()) {
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || 20)));
  const filters = {
    status: searchParams.get("status") || "",
    risk_level: searchParams.get("risk_level") || "",
    provider: searchParams.get("provider") || "",
    model: searchParams.get("model") || "",
    source: searchParams.get("source") || "",
    keyword: (searchParams.get("keyword") || "").trim().toLowerCase(),
  };
  const all = await readJson("execution_logs.json");
  const rows = all.filter((run) => {
    if (filters.status && run.status !== filters.status) return false;
    if (filters.risk_level && run.risk_review?.risk_level !== filters.risk_level) return false;
    if (filters.provider && run.provider !== filters.provider) return false;
    if (filters.model && run.model !== filters.model) return false;
    if (filters.source && run.source !== filters.source) return false;
    if (filters.keyword && !`${run.id} ${run.question} ${run.final_reply || ""}`.toLowerCase().includes(filters.keyword)) return false;
    return true;
  });
  const start = (page - 1) * limit;
  return { page, limit, total: rows.length, items: rows.slice(start, start + limit) };
}

export async function annotateRun(id, input = {}) {
  const rows = await readJson("execution_logs.json");
  const run = rows.find((item) => item.id === id);
  if (!run) throw Object.assign(new Error(`运行记录不存在：${id}`), { status: 404, code: "RUN_NOT_FOUND" });
  const annotation = sanitizeForStorage({
    id: `ANN-${Date.now().toString(36).toUpperCase()}`,
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 10) : [],
    issue: String(input.issue || "").slice(0, 1000),
    expected_answer: String(input.expected_answer || "").slice(0, 3000),
    add_to_bad_case: Boolean(input.add_to_bad_case),
    author: String(input.author || "本地管理员").slice(0, 80),
    created_at: new Date().toISOString(),
  });
  run.annotations = [...(run.annotations || []), annotation].slice(-50);
  run.updated_at = new Date().toISOString();
  await writeJson("execution_logs.json", rows);
  if (annotation.add_to_bad_case) {
    const badCases = await readJson("bad_case_evaluation_cases.json");
    const badCase = {
      id: `BAD-${Date.now().toString(36).toUpperCase()}`,
      category: annotation.tags[0] || "人工标注",
      question: run.question,
      expected: annotation.expected_answer || "应修复本次运行标注的问题",
      expected_any: run.plan?.selected_tools || [],
      source_run_id: run.id,
      note: annotation.issue,
      created_at: annotation.created_at,
    };
    badCases.unshift(badCase);
    await writeJson("bad_case_evaluation_cases.json", badCases.slice(0, 500));
  }
  return { run, annotation };
}

export function explainRun(run) {
  return {
    run_id: run.id,
    route: run.plan?.route_decision || run.plan?.route || null,
    capability_selection: {
      skills: run.plan?.selected_skills || run.steps?.filter((item) => item.kind === "skill").map((item) => item.capability_id) || [],
      tools: run.plan?.selected_tools || run.steps?.filter((item) => item.kind === "tool").map((item) => item.capability_id) || [],
      summary: run.plan?.reasoning?.summary || run.plan?.rationale || "运行记录未保存路由摘要。",
    },
    evidence: run.evidence || [],
    risk: {
      level: run.risk_review?.risk_level || "unknown",
      issues: run.risk_review?.issues || [],
      suggestions: run.risk_review?.suggestions || [],
    },
    validation: run.plan_validation || null,
    note: "该解释仅包含可审计的能力选择、证据和风险摘要，不包含模型内部思维链。",
  };
}
