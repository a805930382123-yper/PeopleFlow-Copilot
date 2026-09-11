import { readJson, updateJson } from "./json-store.mjs";
import { callTool } from "./tool-registry.mjs";
import { sanitizeForStorage } from "./privacy.mjs";

const fields = {
  members: ["name", "department", "position", "manager", "hr_partner"],
  tasks: ["name", "owner", "description", "recommended_time", "deadline_days"],
  contacts: ["name", "role", "department", "email", "channel"],
};
const files = { members: "employees.json", tasks: "onboarding_tasks.json", contacts: "contacts.json", handoffs: "handoffs.json" };
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: "WORKSPACE_VALIDATION_FAILED" });
export function validateWorkspacePatch(kind, patch, current) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw fail("请提交有效的修改内容");
  const allowed = kind === "handoffs" ? ["status", "note", "assigned_to"] : fields[kind];
  if (!allowed) throw fail("不支持的配置类型");
  const next = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.includes(key)) throw fail("不可修改字段：" + key);
    if (key === "deadline_days") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 365) throw fail("办理期限须为 0 到 365 的整数");
      next[key] = value;
    } else {
      if (typeof value !== "string" || value.length > (key === "note" || key === "description" ? 2000 : 160)) throw fail("字段内容无效或过长：" + key);
      next[key] = value.trim();
      if (!["note", "email"].includes(key) && !next[key]) throw fail("请填写完整：" + key);
      if (key === "email" && next[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next[key])) throw fail("邮箱格式不正确");
    }
  }
  if (kind === "handoffs") {
    if (next.status && !["open", "processing", "resolved"].includes(next.status)) throw fail("无效的处理状态");
    if ((next.status || current.status) === "resolved" && !(next.note ?? current.note)?.trim()) throw fail("请填写处理结果后再标记已解决");
  }
  return sanitizeForStorage(next);
}
export async function updateWorkspaceRecord(kind, id, patch) {
  let result;
  await updateJson(files[kind], (rows) => {
    const item = rows.find((row) => row.id === id);
    if (!item) throw fail("记录不存在", 404);
    Object.assign(item, validateWorkspacePatch(kind, patch, item), { updated_at: new Date().toISOString() });
    result = item;
  }, []);
  return result;
}
export async function enterpriseWorkspace() {
  const [members, tasks, contacts, handoffs] = await Promise.all(Object.values(files).map(readJson));
  return { members, tasks, contacts, handoffs };
}
export async function employeeWorkspace(employeeId) {
  const employee = await callTool("employee_lookup", { employee_id: employeeId });
  const [tasks, status, conversations, handoffs] = await Promise.all([
    callTool("task_lookup", { employee_id: employeeId }), callTool("task_status", { employee_id: employeeId }),
    readJson("conversations.json"), readJson("handoffs.json"),
  ]);
  return sanitizeForStorage({
    employee: { id: employee.id, name: employee.name, department: employee.department, position: employee.position, manager: employee.manager, hr_partner: employee.hr_partner },
    tasks: tasks.map((task) => ({ ...task, blocked_by: task.dependencies.filter((id) => !employee.completed_tasks.includes(id)) })),
    progress: status.onboarding_progress,
    conversations: conversations.filter((item) => item.employee_id === employeeId && item.status !== "archived").map((item) => ({ id: item.id, name: item.name, messages: item.messages.map(({ id, role, content, evidence }) => ({ id, role, content, evidence })) })),
    handoffs: handoffs.filter((item) => item.employee_id === employeeId).map(({ id, question, assigned_to, status, note, created_at, updated_at }) => ({ id, question, assigned_to, status, note, created_at, updated_at })),
  });
}
