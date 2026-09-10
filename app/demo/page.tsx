"use client";
/* eslint-disable react-hooks/purity -- IDs and elapsed time are created only inside user event handlers. */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiRequest, jsonRequest } from "../admin/api";

type Employee = { id: string; name: string; department: string; position: string; manager: string };
type Message = { id: string; role: "user" | "assistant"; content: string; feedbackable?: boolean };
type DemoSeed = { employee: Employee; quick_questions: string[]; sample_messages: Message[] };

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const showcaseEmployees: Employee[] = [
  { id: "DEMO-001", name: "示例员工A", department: "产品部", position: "AI 产品经理", manager: "示例主管A" },
  { id: "DEMO-002", name: "示例员工B", department: "研发部", position: "前端工程师", manager: "示例主管B" },
  { id: "DEMO-003", name: "示例员工C", department: "设计部", position: "体验设计师", manager: "示例主管C" },
];
const showcaseQuestions = ["需要准备什么入职材料？", "我的直属领导是谁？", "公司几点下班？"];

function MessageContent({ content }: { content: string }) {
  const lines = content.split("\n").filter((line, index, list) => line.trim() || (index > 0 && index < list.length - 1));
  const firstListIndex = lines.findIndex((line) => /^\d+[.、]\s*/.test(line));
  const lastListIndex = lines.reduce((last, line, index) => /^\d+[.、]\s*/.test(line) ? index : last, -1);
  const listItems = lines.slice(firstListIndex, lastListIndex + 1).filter((line) => /^\d+[.、]\s*/.test(line));
  if (!listItems.length) return <div className="demo-bubble-text">{content}</div>;
  const intro = lines.slice(0, firstListIndex);
  const outro = lines.slice(lastListIndex + 1);
  return <div className="demo-bubble-text structured">{intro.map((line, index) => <p key={`intro-${line}-${index}`}>{line}</p>)}<ol>{listItems.map((line) => <li key={line}>{line.replace(/^\d+[.、]\s*/, "")}</li>)}</ol>{outro.map((line, index) => <p className="demo-answer-note" key={`outro-${line}-${index}`}>{line}</p>)}</div>;
}

function isPublicShowcase() {
  return window.location.hostname.startsWith("peopleflow-onboarding-ai.");
}

function showcaseSeed(employeeId: string): DemoSeed {
  const employee = showcaseEmployees.find((item) => item.id === employeeId) || showcaseEmployees[0];
  return {
    employee,
    quick_questions: showcaseQuestions,
    sample_messages: [{ id: `welcome-${employee.id}`, role: "assistant", content: `${employee.name}，你好！我是企业入职小助手。你可以向我查询入职材料、报到流程、直属领导和基础制度。` }],
  };
}

function showcaseReply(question: string, employee: Employee) {
  if (/材料|证件|准备|携带/.test(question)) return `${employee.name}，入职通常需要准备：\n1. 本人有效身份证件；\n2. 学历与学位证明；\n3. 上一家单位离职证明；\n4. 本人银行卡信息；\n5. HR 通知的社保、公积金及岗位专项材料。\n\n请只通过 HR 指定的人事系统提交敏感资料，不要在普通聊天工具中发送完整证件照片。`;
  if (/直属领导|领导是谁|主管是谁|经理是谁/.test(question)) return `${employee.name}，根据演示员工档案，你的直属领导是${employee.manager}。如组织关系近期发生调整，请以企业通讯录和 HR 正式通知为准。`;
  if (/几点下班|上下班|工作时间|上班时间|下班时间|午休/.test(question)) return `演示考勤制度显示：标准工作日为周一至周五 9:00—18:00，午休时间为 12:00—13:00。弹性或特殊岗位安排以部门和 HR 的正式通知为准。`;
  if (/福利|体检|补贴/.test(question)) return `员工福利会根据工作地、合同类型和当年度方案确定，通常包含年度体检及符合条件的补贴项目。个人适用范围请联系 HR 对接人确认，公开演示版不会展示个人薪酬或福利明细。`;
  if (/第一天|报到|报道|流程|怎么办理/.test(question)) return `${employee.name}，入职首日建议依次完成：身份核验与报到、领取工牌和设备、激活企业账号、与直属领导首次沟通，并确认本周必修培训。具体时间和地点以入职通知为准。`;
  if (/工资|薪资|薪酬|奖金|合同争议|劳动争议|仲裁|离职|辞职|辞退|裁员/.test(question)) return `这涉及个人薪酬或劳动关系等高敏感事项，公开助手不会查询、比较或披露个人信息。建议通过 HR 指定渠道提交具体情况；如涉及合同争议，将由有权限的 HR 与法务人员进一步处理。`;
  if (/coze|工作流/i.test(question)) return `公开展示版已关闭真实 Coze 工作流调用，以避免消耗外部接口额度。本地全功能版本可以在 Tool 管理中配置并追踪 Coze 工作流。`;
  return `我暂时没有找到与“${question}”直接匹配的演示知识。你可以换一种说法，或询问入职材料、报到流程、直属领导、工作时间和福利制度。`;
}

export default function OnboardingAssistantDemo() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState("E001");
  const [seed, setSeed] = useState<DemoSeed | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const [online, setOnline] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, "up" | "down">>({});
  const [showcaseMode, setShowcaseMode] = useState(false);
  const [started, setStarted] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const loadSeed = async (nextEmployeeId: string) => {
    const result = await apiRequest<DemoSeed>(`/demo/bootstrap?employee_id=${encodeURIComponent(nextEmployeeId)}`);
    setSeed(result);
    setMessages(result.sample_messages || []);
    setConversationId("");
    setStarted(false);
  };

  useEffect(() => {
    (async () => {
      const publicMode = isPublicShowcase();
      setShowcaseMode(publicMode);
      if (publicMode) {
        const publicSeed = showcaseSeed("DEMO-001");
        setOnline(true);
        setEmployees(showcaseEmployees);
        setEmployeeId("DEMO-001");
        setSeed(publicSeed);
        setMessages(publicSeed.sample_messages);
        setStarted(false);
        return;
      }
      try {
        const [health, bootstrap] = await Promise.all([
          apiRequest<{ ok?: boolean }>("/health"),
          apiRequest<{ employees?: Employee[] }>("/bootstrap"),
        ]);
        setOnline(Boolean(health.ok));
        setEmployees(bootstrap.employees || []);
        await loadSeed("E001");
      } catch {
        setOnline(false);
        setMessages([{ id: "offline", role: "assistant", content: "暂时无法连接入职助手，请确认本地服务已经启动。" }]);
      }
    })();
  }, []);

  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, typing]);

  const changeEmployee = async (nextEmployeeId: string) => {
    if (typing) return;
    setEmployeeId(nextEmployeeId);
    setSeed(null);
    setMessages([]);
    if (showcaseMode) {
      const publicSeed = showcaseSeed(nextEmployeeId);
      setSeed(publicSeed);
      setMessages(publicSeed.sample_messages);
      setConversationId("");
      setStarted(false);
      return;
    }
    try { await loadSeed(nextEmployeeId); }
    catch { setMessages([{ id: `load-error-${Date.now()}`, role: "assistant", content: "员工信息加载失败，请稍后再试。" }]); }
  };

  const send = async (preset?: string) => {
    const question = (preset ?? input).trim();
    if (!question || typing) return;
    const userMessage: Message = { id: `user-${Date.now()}`, role: "user", content: question };
    setStarted(true);
    setMessages((current) => [...current, userMessage]);
    setInput("");
    setTyping(true);
    const startedAt = Date.now();
    try {
      if (showcaseMode) {
        await wait(1000);
        const currentEmployee = seed?.employee || showcaseEmployees.find((item) => item.id === employeeId) || showcaseEmployees[0];
        setConversationId((current) => current || `showcase-${currentEmployee.id}`);
        setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", content: showcaseReply(question, currentEmployee), feedbackable: true }]);
        return;
      }
      const endpoint = conversationId ? `/conversations/${conversationId}/messages` : "/execute";
      const payload = conversationId
        ? { actor_employee_id: employeeId, question }
        : { employee_id: employeeId, actor_employee_id: employeeId, question };
      const result = await apiRequest<{ conversation_id?: string; response_message_id?: string; final_reply?: string }>(endpoint, jsonRequest("POST", payload));
      await wait(Math.max(0, 1000 - (Date.now() - startedAt)));
      setConversationId(result.conversation_id || conversationId);
      setMessages((current) => [...current, { id: result.response_message_id || `assistant-${Date.now()}`, role: "assistant", content: result.final_reply || "当前没有查询到可展示的回答。", feedbackable: true }]);
    } catch {
      await wait(Math.max(0, 1000 - (Date.now() - startedAt)));
      setMessages((current) => [...current, { id: `assistant-error-${Date.now()}`, role: "assistant", content: "抱歉，刚才没有成功获取回答，请稍后再试或联系 HR 对接人。" }]);
    } finally {
      setTyping(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  };
  const rateMessage = async (message: Message, rating: "up" | "down") => {
    if (showcaseMode) {
      setFeedback((current) => ({ ...current, [message.id]: rating }));
      return;
    }
    if (!conversationId) return;
    try {
      await apiRequest(`/conversations/${conversationId}/feedback`, jsonRequest("POST", { message_id: message.id, rating, tags: rating === "up" ? ["回答有帮助"] : ["需要优化", "Bad Case 候选"] }));
      setFeedback((current) => ({ ...current, [message.id]: rating }));
    } catch {
      // Feedback is non-blocking in the demo surface.
    }
  };
  const copyMessage = async (message: Message) => {
    try { await navigator.clipboard.writeText(message.content); }
    catch { /* Clipboard may be unavailable in a restricted preview. */ }
  };

  return <main className="demo-shell">
    <section className="demo-window" aria-label="企业入职小助手聊天窗口">
      <header className="demo-header">
        <div className="demo-brand"><span className="demo-logo">企</span><div><h1>企业入职小助手</h1><p><i className={online ? "online" : "offline"}/>{online ? "在线为你服务" : "服务未连接"}</p></div></div>
        <div className="demo-header-actions">
          <label>当前员工<select aria-label="当前员工" value={employeeId} onChange={(event) => changeEmployee(event.target.value)} disabled={typing}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.id}</option>)}</select></label>
          {showcaseMode ? <span className="demo-showcase-badge">公开演示</span> : <Link href="/">管理后台</Link>}
        </div>
      </header>

      {seed && <section className="onboarding-pass" aria-label="员工入职通行证">
        <div className="pass-identity"><span>{seed.employee.name.slice(0, 1)}</span><div><small>EMPLOYEE PASS</small><strong>{seed.employee.name}</strong><p>{seed.employee.department} · {seed.employee.position}</p></div></div>
        <div className="pass-stage"><small>当前阶段</small><strong>Day 1</strong><span>入职准备中</span></div>
        <div className="pass-meta"><div><small>直属领导</small><b>{seed.employee.manager || "待 HR 确认"}</b></div><div><small>材料进度</small><b>待确认</b></div><div><small>下一步</small><b>核对报到材料</b></div></div>
      </section>}

      <div className="demo-quick-area">
        <span>常见问题</span>
        <div>{(seed?.quick_questions || ["需要准备什么入职材料？", "我的直属领导是谁？", "公司的福利制度有哪些？"]).map((question) => <button key={question} disabled={typing || !online} onClick={() => send(question)}>{question}</button>)}</div>
      </div>

      <section className="demo-messages" aria-live="polite">
        {!messages.length && <div className="demo-loading">正在加载员工入职信息…</div>}
        {messages.map((message) => <article className={`demo-message ${message.role}`} key={message.id}>
          {message.role === "assistant" && <span className="demo-avatar">AI</span>}
          <div><small>{message.role === "assistant" ? `入职小助手${!started ? " · 示例对话" : ""}` : seed?.employee.name || "我"}</small><MessageContent content={message.content}/>{message.role === "assistant" && message.feedbackable && <><div className="demo-answer-source"><span>{showcaseMode ? "公开演示知识" : "企业知识库与员工档案"}</span><button onClick={() => copyMessage(message)}>复制回答</button></div><div className="demo-feedback"><span>这条回答有帮助吗？</span><button className={feedback[message.id] === "up" ? "selected" : ""} aria-label="回答有帮助" onClick={() => rateMessage(message, "up")}>有帮助</button><button className={feedback[message.id] === "down" ? "selected" : ""} aria-label="回答需改进" onClick={() => rateMessage(message, "down")}>需改进</button></div></>}</div>
          {message.role === "user" && <span className="demo-avatar user">{(seed?.employee.name || "我").slice(0, 1)}</span>}
        </article>)}
        {typing && <article className="demo-message assistant typing-message"><span className="demo-avatar">AI</span><div><small>入职小助手</small><div className="demo-bubble-text">正在输入<span>···</span></div></div></article>}
        <div ref={messageEndRef}/>
      </section>

      <footer className="demo-composer">
        <textarea ref={inputRef} aria-label="输入你的入职问题" value={input} disabled={typing || !online} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="问问入职材料、报到流程、福利制度…" rows={1}/>
        <button aria-label="发送消息" className="demo-send" disabled={!input.trim() || typing || !online} onClick={() => send()}>↑</button>
        <small>按 Enter 发送，Shift + Enter 换行</small>
        {showcaseMode && <small className="demo-privacy-note">演示数据 · 不调用真实模型 · 不保存访客信息</small>}
      </footer>
    </section>
  </main>;
}
