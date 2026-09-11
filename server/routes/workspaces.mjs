import { employeeWorkspace, enterpriseWorkspace, updateWorkspaceRecord } from "../workspace-service.mjs";
import { readRequestBody, send } from "../http.mjs";

export async function handleWorkspaceRoutes(req, res, url, local) {
  if (req.method === "GET" && url.pathname === "/api/enterprise-workspace") {
    send(res, 200, await enterpriseWorkspace()); return true;
  }
  const record = url.pathname.match(/^\/api\/enterprise-workspace\/(members|tasks|contacts|handoffs)\/([^/]+)$/);
  if (req.method === "PATCH" && record) {
    send(res, 200, await updateWorkspaceRecord(record[1], decodeURIComponent(record[2]), await readRequestBody(req))); return true;
  }
  const employee = url.pathname.match(/^\/api\/employee-workspace\/([^/]+)(?:\/(ask|handoff))?$/);
  if (!employee) return false;
  const employeeId = decodeURIComponent(employee[1]);
  if (req.method === "GET" && !employee[2]) {
    send(res, 200, await employeeWorkspace(employeeId)); return true;
  }
  if (req.method !== "POST" || !employee[2]) return false;
  const input = await readRequestBody(req);
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question || question.length > 3000) throw new Error("请输入 1 到 3000 字的问题");
  const context = await employeeWorkspace(employeeId);
  if (input.conversation_id && !context.conversations.some((item) => item.id === input.conversation_id)) throw new Error("当前员工无法使用此会话");
  if (employee[2] === "handoff") {
    const item = await local.createHandoffRecord({ employee_id: employeeId, question, conversation_id: input.conversation_id || null, assigned_to: context.employee.hr_partner || "HR 对接人", summary: question, source: "employee_workspace" });
    send(res, 201, { id: item.id, status: item.status }); return true;
  }
  const result = await local.executeAgent({ employee_id: employeeId, actor_employee_id: employeeId, question, conversation_id: input.conversation_id || undefined }, { source: "employee" });
  send(res, 200, { conversation_id: result.conversation_id, reply: result.final_reply || "暂时无法回答，请稍后重试或联系人工。", evidence: result.evidence || [], handoff: result.handoff ? { id: result.handoff.id } : null });
  return true;
}
