import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { withRuntimeStorage } from '../server/runtime-storage.mjs';
import { employeeWorkspace, enterpriseWorkspace, updateWorkspaceRecord } from '../server/workspace-service.mjs';
import { handleWorkspaceRoutes } from '../server/routes/workspaces.mjs';

async function fixture(run) {
  const names = ['employees.json', 'onboarding_tasks.json', 'tools.json'];
  const rows = new Map(await Promise.all(names.map(async (name) => [name, { value: await readFile(new URL('../data/' + name, import.meta.url), 'utf8'), version: 0 }])));
  rows.set('contacts.json', { value: '[]', version: 0 });
  rows.set('conversations.json', { value: JSON.stringify([
    { id: 'mine', employee_id: 'E001', name: '我的问题', messages: [{ id: 'm1', role: 'assistant', content: '答复', risk_level: 'high' }] },
    { id: 'other', employee_id: 'E002', name: '其他员工的问题', messages: [] },
  ]), version: 0 });
  rows.set('handoffs.json', { value: JSON.stringify([
    { id: 'mine-case', employee_id: 'E001', question: '电脑未领取', assigned_to: 'IT 服务台', status: 'open', note: '已联系负责人', reason: '内部说明' },
    { id: 'other-case', employee_id: 'E002', question: '他人的请求', status: 'open' },
  ]), version: 0 });
  const db = { prepare(sql) { return { bind(...args) { return {
    async first() { return rows.get(args[0]) || null; },
    async run() {
      if (sql.startsWith('UPDATE')) { const [value, , name, version] = args; const row = rows.get(name); if (row?.version !== version) return { meta: { changes: 0 } }; rows.set(name, { value, version: version + 1 }); }
      else { const [name, value] = args; rows.set(name, { value, version: 0 }); }
      return { meta: { changes: 1 } };
    },
  }; } }; } };
  return withRuntimeStorage({ db }, run);
}

test('员工待办和会话按当前员工筛选，响应不携带内部处理说明', () => fixture(async () => {
  const data = await employeeWorkspace('E001');
  assert.equal(data.employee.id, 'E001');
  assert.deepEqual(data.conversations.map((row) => row.id), ['mine']);
  assert.deepEqual(data.handoffs.map((row) => row.id), ['mine-case']);
  assert.equal(data.handoffs[0].reason, undefined);
  assert.equal(data.conversations[0].messages[0].risk_level, undefined);
  assert.equal(data.tasks.find((row) => row.id === 'T003').completed, false);
  assert.equal(data.tasks.find((row) => row.id === 'T001').completed, true);
}));

test('企业处理回复持久化后可被对应员工查看，状态更新不清空已有回复', () => fixture(async () => {
  await updateWorkspaceRecord('handoffs', 'mine-case', { status: 'processing' });
  assert.equal((await employeeWorkspace('E001')).handoffs[0].note, '已联系负责人');
  await updateWorkspaceRecord('handoffs', 'mine-case', { status: 'resolved', assigned_to: '设备负责人', note: '请到一楼领取电脑' });
  const result = (await employeeWorkspace('E001')).handoffs[0];
  assert.equal(result.status, 'resolved'); assert.equal(result.assigned_to, '设备负责人'); assert.equal(result.note, '请到一楼领取电脑');
  assert.equal((await employeeWorkspace('E002')).handoffs[0].id, 'other-case');
}));

test('配置修改限制字段并验证期限，处理关闭必须有结果', () => fixture(async () => {
  await assert.rejects(updateWorkspaceRecord('members', 'E001', { completed_tasks: [] }), /不可修改字段/);
  await assert.rejects(updateWorkspaceRecord('tasks', 'T003', { deadline_days: -1 }), /办理期限/);
  await assert.rejects(updateWorkspaceRecord('handoffs', 'other-case', { status: 'resolved', note: '' }), /处理结果/);
  await assert.rejects(updateWorkspaceRecord('handoffs', 'missing', { status: 'processing' }), /记录不存在/);
  await updateWorkspaceRecord('members', 'E001', { manager: '新负责人' });
  assert.equal((await employeeWorkspace('E001')).employee.manager, '新负责人');
  await updateWorkspaceRecord('tasks', 'T003', { owner: '新 IT 服务台', deadline_days: 3 });
  assert.equal((await employeeWorkspace('E001')).tasks.find((task) => task.id === 'T003').owner, '新 IT 服务台');
  assert.equal((await enterpriseWorkspace()).members.find((person) => person.id === 'E001').manager, '新负责人');
}));

async function request(path, payload, local) {
  let output; let status;
  const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); } };
  const res = { writeHead(code) { status = code; }, end(body) { output = JSON.parse(body); } };
  await handleWorkspaceRoutes(req, res, new URL('http://localhost/api' + path), local);
  return { status, output };
}

test('问答入口拒绝跨员工会话，并覆盖客户端传入的身份和高级配置', () => fixture(async () => {
  let calls = 0;
  const local = { async executeAgent(input) {
    calls++; assert.equal(input.employee_id, 'E001'); assert.equal(input.actor_employee_id, 'E001'); assert.equal(input.plan_id, undefined);
    return { conversation_id: 'mine', final_reply: '请联系 IT', evidence: [], steps: ['internal'], risk_review: { risk_level: 'low' } };
  } };
  await assert.rejects(request('/employee-workspace/E001/ask', { question: '你好', conversation_id: 'other' }, local), /无法使用此会话/);
  assert.equal(calls, 0);
  const { output } = await request('/employee-workspace/E001/ask', { question: '你好', employee_id: 'E002', actor_employee_id: 'E002', plan_id: 'unsafe' }, local);
  assert.equal(output.reply, '请联系 IT'); assert.equal(output.steps, undefined); assert.equal(calls, 1);
}));

test('人工申请将负责人绑定到当前员工 HR，拒绝空请求', () => fixture(async () => {
  let captured;
  const local = { async createHandoffRecord(input) { captured = input; return { id: 'created', status: 'open' }; } };
  await assert.rejects(request('/employee-workspace/E001/handoff', { question: '  ' }, local), /请输入/);
  const { status } = await request('/employee-workspace/E001/handoff', { question: '电脑未领取', assigned_to: '伪造负责人' }, local);
  assert.equal(status, 201); assert.equal(captured.employee_id, 'E001'); assert.notEqual(captured.assigned_to, '伪造负责人');
}));
