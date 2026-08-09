import { getSkill } from "./skill-registry.mjs";
import { callToolDetailed, getTool } from "./tool-registry.mjs";
import { callModel } from "./llm.mjs";
import { deterministicReview } from "./risk-review.mjs";
import { asksManager, asksHrPartner, asksOnboardingMaterials, asksThirdPartyCompensation, contactRolesForQuestion, isPolicyQuestion, isSensitiveQuestion, topicForQuestion } from "./question-intent.mjs";
import { aggregateTokenUsage } from "./token-usage.mjs";

function knowledgeCards(toolResults = {}) {
  const labels = {
    material_lookup: "入职材料",
    task_lookup: "入职任务",
    task_status: "员工任务状态",
    policy_lookup: "制度与知识",
    training_lookup: "培训安排",
    contact_lookup: "授权联系人",
  };
  const cards = [];
  for (const [source, value] of Object.entries(toolResults)) {
    if (source === "employee_lookup" || value == null) continue;
    if (source === "knowledge_lookup" && Array.isArray(value.knowledge_cards)) {
      value.knowledge_cards.forEach((card) => cards.push({ source: card.source || source, source_id: card.source_id || card.id, chunk_id: card.chunk_id || null, source_file: card.source_file || null, title: card.title, section: card.section || null, page: card.page || null, slide: card.slide || null, content: card.content, version: card.version || null, effective_date: card.effective_date || null, category: card.category || "入职知识" }));
      continue;
    }
    const rows = Array.isArray(value) ? value : [value];
    rows.forEach((row, index) => cards.push({
      source,
      title: row?.name || row?.title || `${labels[source] || "入职知识"}${rows.length > 1 ? ` ${index + 1}` : ""}`,
      content: typeof row === "string" ? row : JSON.stringify(row),
    }));
  }
  return cards;
}

function relevantKnowledgeCards(cards, question = "") {
  const entities = [
    ["身份证", /身份证/],
    ["学历", /学历|学位/],
    ["离职证明", /离职证明/],
    ["银行卡", /银行卡/],
    ["社保", /社保|公积金/],
    ["证件照", /证件照|照片/],
  ];
  const matchedEntity = entities.find(([, pattern]) => pattern.test(question));
  if (!matchedEntity) return cards;
  const filtered = cards.filter((card) => `${card.title || ""} ${card.content || ""}`.includes(matchedEntity[0])).sort((a, b) => {
    const titleScore = (card) => String(card.title || "").includes(matchedEntity[0]) ? 2 : 0;
    const sourceScore = (card) => card.source === "material_lookup" ? 1 : 0;
    return titleScore(b) + sourceScore(b) - titleScore(a) - sourceScore(a);
  });
  return filtered.length ? filtered : cards;
}

function buildSkillInput(id, input) {
  const structuredQuery = input.skill_results?.question_structuring || {};
  const cards = knowledgeCards(input.tool_results);
  if (id === "question_structuring") return {
    user_message: input.question,
    conversation_context: input.conversation_context || [],
    employee_profile: {
      employee_id: input.employee?.id || input.employee_id,
      city: input.employee?.city || null,
      job_category: input.employee?.position || null,
      role_type: input.employee?.role_type || "正式员工",
      entry_date: input.employee?.onboarding_date || null,
    },
  };
  if (id === "task_decision") return {
    structured_query: structuredQuery,
    knowledge_cards: cards,
    employee_status: {
      known_completed_items: input.employee?.completed_tasks || [],
      known_pending_items: input.tool_results?.task_status?.next_priority_tasks || [],
    },
  };
  if (id === "process_explanation") return { structured_query: structuredQuery, decision_result: input.skill_results?.task_decision || { recommended_actions: [] }, knowledge_cards: cards };
  if (id === "policy_qa") return { structured_query: structuredQuery, knowledge_cards: cards };
  if (id === "reply_generation") return {
    user_message: input.question,
    employee_profile: {
      id: input.employee?.id || input.employee_id,
      name: input.employee?.name || null,
      department: input.employee?.department || null,
      position: input.employee?.position || null,
      manager: input.employee?.manager || null,
      hr_partner: input.employee?.hr_partner || null,
      onboarding_stage: input.employee?.stage || null,
      account_status: input.employee?.account_status || null,
      device_status: input.employee?.device_status || null,
      access_status: input.employee?.access_status || null,
    },
    process_explanation: input.skill_results?.process_explanation || null,
    policy_qa: input.skill_results?.policy_qa || null,
    task_decision: input.skill_results?.task_decision || null,
    knowledge_cards: cards,
  };
  if (id === "risk_review") return {
    draft_reply: input.draft_reply,
    structured_query: structuredQuery,
    evidence_summary: [
      input.employee?.id ? `员工档案：员工ID=${input.employee.id}，姓名=${input.employee.name || "未记录"}，部门=${input.employee.department || "未记录"}，岗位=${input.employee.position || "未记录"}，直属领导=${input.employee.manager || "未记录"}，HR对接人=${input.employee.hr_partner || "未记录"}，入职阶段=${input.employee.stage || "未记录"}` : null,
      ...cards.map((card) => `${card.title}：${card.content}`),
    ].filter(Boolean).slice(0, 20),
  };
  return input;
}

function mockSkill(id, input) {
  const { question, employee, tool_results = {} } = input;
  if (id === "question_structuring") {
    const topic = topicForQuestion(question);
    const sensitive = isSensitiveQuestion(question);
    const riskTags = sensitive ? [/工资|薪资|薪酬|奖金|收入/.test(question) ? "salary_related" : /社保|公积金/.test(question) ? "social_security_related" : /合同/.test(question) ? "employment_contract_related" : /身份证|银行卡|隐私/.test(question) ? "personal_data_related" : "sensitive_hr_related"] : [];
    return { intent: asksOnboardingMaterials(question) ? "onboarding_materials" : isPolicyQuestion(question) ? "policy_query" : "onboarding_preparation", question_type: "knowledge_query", topics: [topic], retrieval_query: question, entities: { city: employee?.city || null, job_category: employee?.position || null, role_type: employee?.role_type || "正式员工", system_name: /OA/i.test(question) ? "OA" : /VPN/i.test(question) ? "VPN" : /邮箱/.test(question) ? "邮箱" : /门禁/.test(question) ? "门禁" : null, entry_date: employee?.onboarding_date || null, issue_type: null }, known_information: [], missing_information: [], need_follow_up: false, follow_up_question: null, answerability: sensitive ? "requires_hr_or_it_confirmation" : "answerable_after_retrieval", sensitive_topic: sensitive, risk_tags: riskTags, required_next_steps: ["统一入职知识库检索", "入职沟通话术生成 Skill", "合规与风险审核 Skill"], topic, employee_id: employee?.id || input.employee_id, need_employee_profile: true, need_material_query: asksOnboardingMaterials(question), need_onboarding_task_query: /第一天|入职.*(?:任务|待办|要做)|任务|待办|要做|需要做|准备什么|电脑|账号|门禁/.test(question), need_policy_query: isPolicyQuestion(question), need_contact_query: /联系|找谁|是谁|负责人|领导|上级|汇报给谁|汇报对象|hr|it|电脑|账号|门禁|工位/i.test(question) };
  }
  if (id === "task_decision") {
    const tasks = tool_results.task_lookup || [];
    const status = tool_results.task_status || {};
    const rank = { P0: 0, P1: 1, P2: 2 };
    const recommended = tasks
      .filter((x) => !x.completed && (!x.dependencies.length || x.dependencies.every((d) => employee.completed_tasks.includes(d))))
      .sort((a, b) => rank[a.priority] - rank[b.priority])
      .slice(0, 5)
      .map((x) => ({ task_id: x.id, task_name: x.name, priority: x.priority, required: x.required, recommended_time: x.recommended_time, dependency_tasks: x.dependencies, owner: x.owner, reason: x.description }));
    const actions = recommended.map((task) => ({ action: task.task_name, priority: task.priority, when: task.recommended_time, required: task.required, basis: task.reason, owner: task.owner, dependency: task.dependency_tasks, confidence: "high", requires_confirmation: false }));
    return { decision_summary: actions.length ? `根据已查询的员工任务状态，建议按优先级处理 ${actions.length} 项待办。` : "当前没有可由现有数据确认的待办建议。", recommended_actions: actions, not_recommended_to_assert: ["个人设备已就绪状态", "个人账号已开通状态", "个人权限已生效状态"], escalation: [], confidence: "high", recommended_tasks: recommended, progress: status.onboarding_progress };
  }
  if (id === "policy_qa") {
    const policies = tool_results.policy_lookup || [];
    if (!policies.length) return { answer_status: "not_found_in_kb", direct_answer: [], evidence: [], limitations: ["当前系统未查询到相关信息。"], recommended_action: "建议联系 HR、直属上级或对应系统负责人确认。", risk_level: isSensitiveQuestion(question) ? "high" : "low", confidence: "high", answer: "当前系统未查询到相关信息", sources: [] };
    const direct = policies.map((p) => `${p.name}（v${p.version}，${p.effective_date} 生效）：${p.summary}`);
    const sources = policies.map((p) => ({ name: p.name, version: p.version, effective_date: p.effective_date }));
    return { answer_status: isSensitiveQuestion(question) ? "partially_answered" : "answered", direct_answer: direct, evidence: policies.map((p) => ({ title: p.name, supported_claims: [p.summary] })), limitations: isSensitiveQuestion(question) ? ["个人金额、状态或审批结果需要由有权限的 HR 或相关负责人确认。"] : [], recommended_action: isSensitiveQuestion(question) ? "如需确认个人情况，请联系 HR。" : null, risk_level: isSensitiveQuestion(question) ? "high" : "low", confidence: "high", answer: direct.join("\n"), sources };
  }
  if (id === "process_explanation") {
    const tasks = tool_results.task_lookup || [];
    const contacts = tool_results.contact_lookup || [];
    const steps = tasks.filter((x) => !x.completed).slice(0, 6).map((x, i) => ({ step_no: i + 1, action: x.name, detail: x.description, owner: x.owner, evidence: "查询入职任务 Tool", required: x.required }));
    return { answer_type: "step_by_step_process", title: "入职事项办理步骤", summary: steps.length ? "请按优先级和前置条件依次完成以下事项。" : "当前系统未查询到可确认的办理步骤。", steps, materials_or_information_needed: [], important_notes: ["实际安排请以入职通知书、审批结果或负责人确认结果为准。"], escalation_path: contacts.slice(0, 3).map((contact) => `如需协助，请通过${contact.channel}联系${contact.name}（${contact.role}）。`), confidence: steps.length ? "high" : "low", contacts };
  }
  if (id === "reply_generation") {
    const decision = input.skill_results?.task_decision;
    const policy = input.skill_results?.policy_qa;
    const training = tool_results.training_lookup || [];
    const materials = tool_results.material_lookup || [];
    const contacts = tool_results.contact_lookup || [];
    const kbCards = tool_results.knowledge_lookup?.knowledge_cards || [];
    const cozeWorkflow = Object.entries(tool_results).find(([id]) => id.startsWith("run_coze_workflow_"))?.[1];
    const lines = [`${employee.name}，你好！`];
    if (asksThirdPartyCompensation(question)) {
      lines.push("薪资属于敏感个人信息，系统不能查询或披露他人的工资、奖金或收入信息。若你对薪酬制度有业务需要，请联系 HR 对接人通过授权流程处理。");
      return { final_reply: lines.join("\n") };
    }
    if (/工资|薪资|薪酬|奖金|提成|收入/.test(question)) {
      lines.push("个人薪资属于高敏感信息，当前系统未接入个人工资数据。请通过本人薪资单或企业授权的薪酬系统查询，如有疑问请联系 HR 对接人。");
      return { final_reply: lines.join("\n") };
    }
    if (asksManager(question)) {
      lines.push(`你的直属领导是${employee.manager}。`);
      const managerContact = contacts.find((contact) => contact.name === employee.manager);
      if (managerContact) lines.push(`你可以通过${managerContact.channel}联系${managerContact.name}。`);
      lines.push("以上为本地员工档案中的当前信息，如组织关系刚有调整，请以企业通讯录为准。");
      return { final_reply: lines.join("\n") };
    }
    if (asksHrPartner(question)) {
      lines.push(`你的 HR 对接人是${employee.hr_partner}。`);
      const hrContact = contacts.find((contact) => contact.name === employee.hr_partner);
      if (hrContact) lines.push(`你可以通过${hrContact.channel}联系${hrContact.name}。`);
      lines.push("以上为本地员工档案中的当前信息，如对接关系刚有调整，请以企业通讯录为准。");
      return { final_reply: lines.join("\n") };
    }
    if (materials.length) {
      const specificMaterial = [
        [/身份证/, (item) => /身份证/.test(item.name)],
        [/学历|学位/, (item) => /学历|学位/.test(item.name)],
        [/离职证明/, (item) => /离职证明/.test(item.name)],
        [/银行卡/, (item) => /银行卡/.test(item.name)],
        [/社保|公积金/, (item) => /社保|公积金/.test(item.name)],
        [/证件照|照片/, (item) => /证件照|照片/.test(item.name)],
      ].find(([pattern]) => pattern.test(question));
      const matchedMaterial = specificMaterial ? materials.find(specificMaterial[1]) : null;
      if (matchedMaterial) {
        lines.push(`关于${matchedMaterial.name}：`);
        if (/身份证/.test(question) && /原件/.test(question)) {
          lines.push("当前材料记录没有明确写明必须携带原件；记录支持通过 HR 指定的人事系统提交，或在现场完成身份核验。");
          lines.push("请先查看录用通知；如果通知未写明，建议在报到前向 HR 对接人确认是否需要携带原件，避免仅凭通用清单作确定判断。");
        } else {
          lines.push(`用途：${matchedMaterial.purpose}`);
          lines.push(`提交方式：${matchedMaterial.submission_channel}`);
          if (matchedMaterial.note) lines.push(`注意：${matchedMaterial.note}`);
        }
        lines.push("最终以录用通知和 HR 正式通知为准。");
        return { final_reply: lines.join("\n"), used_sections: ["materials"], contains_sensitive_guidance: isSensitiveQuestion(question), requires_risk_review: true };
      }
      lines.push("办理入职报到，请按录用通知和 HR 要求准备以下材料：");
      materials.forEach((material) => lines.push(`${material.required ? "通常必备" : "按通知提供"}｜${material.name}：${material.note}`));
      lines.push("身份证件、银行卡、社保等敏感资料只应通过 HR 指定的人事或薪酬系统提交，不要发送到群聊或普通聊天窗口。");
      lines.push("以上为本地演示清单，最终以你的录用通知和 HR 正式通知为准。");
      return { final_reply: lines.join("\n") };
    }
    const decisionActions = decision?.recommended_actions || decision?.recommended_tasks || [];
    if (decisionActions.length) { lines.push(`结合你当前的「${employee.stage}」阶段，建议优先完成：`); decisionActions.forEach((t) => lines.push(`${t.priority}｜${t.action || t.task_name}：${t.when || t.recommended_time}，由${t.owner}负责。`)); }
    if (policy) lines.push(policy.direct_answer?.join("\n") || policy.answer);
    if (training.length) { lines.push("你当前匹配的入职培训包括："); training.forEach((t) => lines.push(`${t.required ? "必修" : "选修"}｜${t.name}：${t.time}，${t.format}。`)); }
    if (!decisionActions.length && !policy && !training.length && !materials.length && kbCards.length) { lines.push("根据当前有效的入职指引："); kbCards.slice(0, 3).forEach((card) => lines.push(`${card.title}：${card.content}`)); }
    if (contacts.length) lines.push(`如需协助，可通过企业渠道联系：${contacts.slice(0, 3).map((c) => `${c.name}（${c.role}）`).join("、")}。`);
    if (cozeWorkflow?.answer) lines.push(cozeWorkflow.answer);
    if (lines.length === 1) lines.push("当前系统未查询到相关信息，请联系你的 HR 对接人进一步确认。");
    lines.push("以上为本地模拟数据，具体安排请以企业正式通知为准。");
    return { final_reply: lines.join("\n"), used_sections: [decisionActions.length ? "task_decision" : null, policy ? "policy_qa" : null, materials.length ? "materials" : null].filter(Boolean), contains_sensitive_guidance: isSensitiveQuestion(question), requires_risk_review: true };
  }
  if (id === "risk_review") {
    const review = deterministicReview(input.draft_reply, { sensitive: isSensitiveQuestion(question), notFound: input.draft_reply.includes("未查询到") });
    const safeReply = review.passed ? input.draft_reply : input.draft_reply.replace(/Planner|Skill|Tool|Prompt|JSON/gi, "内部能力");
    return { ...review, review_decision: review.passed ? "pass" : "rewrite_required", required_changes: review.suggestions, safe_reply: safeReply, final_reply: safeReply, audit_trace: { personal_data_checked: true, unsupported_claim_checked: true, policy_boundary_checked: true, security_boundary_checked: true, internal_leakage_checked: true } };
  }
  return { summary: "已基于查询数据完成处理", input_received: true };
}

export async function executePlan(plan, { employee_id, question, conversation_context = [], onEvent = null }) {
  const outputs = {};
  const toolResults = {};
  const skillResults = {};
  const steps = [];
  const skillVersions = {};
  const toolVersions = {};
  let employee = { id: employee_id };
  let mode = null;
  let provider = null;
  let model = null;
  let executionStatus = "success";
  const emit = (event, data) => { if (typeof onEvent === "function") onEvent(event, data); };
  for (const item of plan.steps) {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    let input;
    let output;
    let attempts = 0;
    let stepMode = null;
    let stepProvider = null;
    let stepModel = null;
    const stepTokenUsages = [];
    let stepRequestId = null;
    const maxAttempts = 1 + Math.max(0, Number(item.retry || 0));
    emit("step.started", { step_id: item.id, kind: item.kind, capability_id: item.capability_id, started_at: startedAt });
    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        if (item.kind === "tool") {
          input = { employee_id, query: question, roles: contactRolesForQuestion(question) };
          if (item.capability_id.startsWith("run_coze_workflow_")) input = { user_id: employee_id, CONVERSATION_NAME: `onboarding-${employee_id}`, USER_INPUT: question };
          const tool = await getTool(item.capability_id, true);
          const detailed = await callToolDetailed(item.capability_id, input);
          output = detailed.output;
          toolVersions[item.capability_id] = tool.version || "local-1";
          toolResults[item.capability_id] = output;
          if (item.capability_id === "employee_lookup") employee = output;
          if (detailed.interrupt) {
            const step = { ...item, input, output, status: "needs_input", error: null, attempts, started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Math.max(1, Date.now() - started), interrupt: detailed.interrupt };
            steps.push(step);
            outputs[item.id] = output;
            executionStatus = "needs_input";
            emit("run.needs_input", { step, interrupt: detailed.interrupt });
            break;
          }
        } else {
          const skill = await getSkill(item.capability_id, true);
          const baseInput = item.capability_id === "risk_review" ? { question, employee, conversation_context, draft_reply: skillResults.reply_generation?.final_reply || "当前系统未查询到相关信息", tool_results: toolResults, skill_results: skillResults } : { question, employee_id, employee, conversation_context, tool_results: toolResults, skill_results: skillResults };
          input = buildSkillInput(item.capability_id, baseInput);
          const result = await callModel(skill, input, () => mockSkill(item.capability_id, baseInput));
          output = result.data;
          stepMode = result.mode;
          stepProvider = result.provider;
          stepModel = result.model;
          if (result.token_usage) stepTokenUsages.push(result.token_usage);
          stepRequestId = result.request_id || null;
          mode = result.mode;
          provider = result.provider;
          model = result.model;
          skillVersions[item.capability_id] = skill.version || "1.0.0";
          skillResults[item.capability_id] = output;
        }
        break;
      } catch (error) {
        if (error.token_usage) stepTokenUsages.push(error.token_usage);
        if (attempts >= maxAttempts) {
          const step = { ...item, input, output: null, status: "error", error: { code: error.code || "STEP_EXECUTION_FAILED", message: error.message }, attempts, started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Date.now() - started, provider: stepProvider, model: stepModel, mode: stepMode, request_id: stepRequestId, token_usage: stepTokenUsages.length ? aggregateTokenUsage(stepTokenUsages) : null };
          steps.push(step);
          emit("step.failed", step);
          error.partial_steps = steps;
          error.skill_versions = skillVersions;
          error.tool_versions = toolVersions;
          error.provider = provider;
          error.model = model;
          error.mode = mode;
          throw error;
        }
      }
    }
    if (executionStatus === "needs_input") break;
    outputs[item.id] = output;
    const step = { ...item, input, output, status: "success", error: null, attempts, started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Math.max(1, Date.now() - started), provider: stepProvider, model: stepModel, mode: stepMode, request_id: stepRequestId, token_usage: stepTokenUsages.length ? aggregateTokenUsage(stepTokenUsages) : null };
    steps.push(step);
    emit("step.completed", step);
  }
  if (executionStatus === "needs_input") return { employee, steps, final_reply: "工作流需要补充信息后才能继续。", evidence: [], risk_review: { risk_level: "medium", passed: false, issues: ["Coze 工作流等待补充输入"], suggestions: ["补充工作流请求的信息后继续执行"] }, mode: mode || "live", provider, model, status: executionStatus, skill_versions: skillVersions, tool_versions: toolVersions, token_usage: aggregateTokenUsage(steps.map((step) => step.token_usage).filter(Boolean)) };
  const review = skillResults.risk_review;
  const draftReply = skillResults.reply_generation?.final_reply || "当前系统未查询到相关信息";
  const deterministic = mockSkill("risk_review", { question, employee, conversation_context, draft_reply: draftReply, tool_results: toolResults, skill_results: skillResults });
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  const effectiveReview = rank[deterministic.risk_level] > rank[review?.risk_level] ? { ...review, ...deterministic, issues: [...(review?.issues || []), ...(deterministic.issues || [])] } : review || deterministic;
  const evidence = relevantKnowledgeCards(knowledgeCards(toolResults), question).map(({ title, source, source_id, version, effective_date, category }) => ({ title, category: category || "业务数据", source, source_id: source_id || null, version: version || null, effective_date: effective_date || null })).filter((item, index, rows) => rows.findIndex((candidate) => candidate.title === item.title && candidate.source === item.source) === index).slice(0, 12);
  return { employee, steps, final_reply: effectiveReview.safe_reply || effectiveReview.final_reply || draftReply, evidence, risk_review: { risk_level: effectiveReview.risk_level, passed: effectiveReview.passed, review_decision: effectiveReview.review_decision || (effectiveReview.passed ? "pass" : "rewrite_required"), issues: effectiveReview.issues || [], suggestions: effectiveReview.required_changes || effectiveReview.suggestions || [] }, mode, provider, model, status: executionStatus, skill_versions: skillVersions, tool_versions: toolVersions, token_usage: aggregateTokenUsage(steps.map((step) => step.token_usage).filter(Boolean)) };
}

export async function testSkill(skill, input) {
  if (!skill.enabled) throw new Error(`Skill 已禁用，Executor 拒绝执行：${skill.name}`);
  const baseInput = { question: input, employee_id: "E001", employee: { id: "E001", name: "测试员工", department: "产品部", position: "AI 产品经理", stage: "day_1", completed_tasks: [] }, tool_results: {}, skill_results: {} };
  const result = await callModel(skill, buildSkillInput(skill.id, baseInput), () => mockSkill(skill.id, baseInput));
  return { mode: result.mode, provider: result.provider, model: result.model, output: result.data, token_usage: result.token_usage || null };
}
