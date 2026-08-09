import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCozeWorkflowOutput, parseCozeSse, runCozeWorkflow7659350798523416603, selectApprovedMessageOutput, selectFinalMessageOutput } from "../server/coze-workflow.mjs";

test("uses configured QA-passed node when End is empty", () => {
  assert.deepEqual(selectApprovedMessageOutput([
    { node_title: "信息查询过度", content: "正在为您查询信息，请稍等" },
    { node_title: "质检通过", content: "您好，您到北京入职需携带身份证等材料。" },
    { node_title: "End", content: "" },
  ], ["质检通过"]), {
    answer: "您好，您到北京入职需携带身份证等材料。",
    status: "success",
    risk_level: "low",
  });
});

test("never falls back to an unapproved intermediate node", () => {
  assert.equal(selectApprovedMessageOutput([{ node_title: "信息查询过度", content: "正在查询" }], ["质检通过"]), null);
});

test("uses the last completed message immediately before an empty End node", () => {
  assert.deepEqual(selectFinalMessageOutput([
    { node_title: "信息查询过度", node_type: "Message", node_is_finish: true, content: "正在查询" },
    { node_title: "追问后重写输出", node_type: "Message", node_is_finish: true, content: "北京研发岗入职请携带身份证。" },
    { node_title: "End", node_type: "End", node_is_finish: true, content: "" },
  ], []), {
    answer: "北京研发岗入职请携带身份证。",
    status: "success",
    risk_level: "low",
  });
});

test("prefers a configured final node over another completed message", () => {
  assert.deepEqual(selectFinalMessageOutput([
    { node_title: "质检通过", node_type: "Message", node_is_finish: true, content: "质检后的最终答案" },
    { node_title: "日志", node_type: "Message", node_is_finish: true, content: "调试信息" },
    { node_title: "End", node_type: "End", node_is_finish: true, content: "" },
  ], ["质检通过"]), {
    answer: "质检后的最终答案",
    status: "success",
    risk_level: "low",
  });
});

test("parses Coze Interrupt control fields", () => {
  const frames = parseCozeSse('id: 0\nevent: Message\ndata: {"content":"请补充城市","node_title":"信息追问","node_is_finish":true}\n\nid: 1\nevent: Interrupt\ndata: {"interrupt_data":{"event_id":"run/event","type":2},"node_title":"信息追问"}\n\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[1].event, "Interrupt");
  assert.equal(frames[1].data.interrupt_data.event_id, "run/event");
  assert.equal(frames[1].data.interrupt_data.type, 2);
});

test("normalizes the Coze End node Output only", () => {
  assert.deepEqual(normalizeCozeWorkflowOutput({
    node_status: "success",
    "中间节点": "正在为您查询信息，请稍等",
    Output: JSON.stringify({ answer: "请携带身份证和入职通知。", status: "success", risk_level: "low" }),
  }), {
    answer: "请携带身份证和入职通知。",
    status: "success",
    risk_level: "low",
  });
});

test("does not use intermediate node text as answer", () => {
  assert.deepEqual(normalizeCozeWorkflowOutput({ "信息追问": "请补充所在城市", Output: "{}" }), {
    answer: "",
    status: "empty_output",
    risk_level: "unknown",
  });
});

test("supports mock mode when no token is configured", async () => {
  const previousToken = process.env.COZE_API_TOKEN;
  const previousMock = process.env.COZE_MOCK_MODE;
  delete process.env.COZE_API_TOKEN;
  process.env.COZE_MOCK_MODE = "true";
  try {
    const output = await runCozeWorkflow7659350798523416603({ user_id: "E001", CONVERSATION_NAME: "E001", USER_INPUT: "入职材料" });
    assert.equal(output.status, "success");
    assert.equal(typeof output.answer, "string");
  } finally {
    if (previousToken === undefined) delete process.env.COZE_API_TOKEN; else process.env.COZE_API_TOKEN = previousToken;
    if (previousMock === undefined) delete process.env.COZE_MOCK_MODE; else process.env.COZE_MOCK_MODE = previousMock;
  }
});
