const sensitivePatterns = [
  [/pat_[A-Za-z0-9_-]{20,}/g, "[TOKEN 已脱敏]"],
  [/sk-[A-Za-z0-9_-]{16,}/g, "[API KEY 已脱敏]"],
  [/\b\d{17}[\dXx]\b/g, "[身份证号已脱敏]"],
  [/\b(?:\d[ -]?){12,19}\b/g, "[银行卡号已脱敏]"],
  [/(密码|验证码|口令)\s*[:：]?\s*[^\s，。；;]{4,}/gi, "$1：[已脱敏]"],
];

export function maskSensitiveText(value = "") {
  return sensitivePatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(value));
}

export function sanitizeForStorage(value) {
  if (typeof value === "string") return maskSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeForStorage);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/(^|_)(token|secret|api_key|password)$/i.test(key)).map(([key, child]) => [key, sanitizeForStorage(child)]));
  return value;
}

export function assertSelfAccess(actorEmployeeId, targetEmployeeId) {
  if (!actorEmployeeId || !targetEmployeeId || actorEmployeeId !== targetEmployeeId) throw new Error("当前本地身份只能访问本人的入职数据");
}

export function assessSensitiveRequest(question = "") {
  const text = String(question);
  if (/(?:绕过|破解|跳过).{0,12}(?:审批|权限|门禁|vpn)|(?:输出|告诉|发给|提供|泄露|是多少|完整).{0,12}(?:api\s*key|token|密码|验证码|口令|身份证号|银行卡号)|(?:api\s*key|token|密码|验证码|口令).{0,12}(?:输出|告诉|发给|提供|泄露|是多少|完整)/i.test(text)) {
    return { level: "critical", category: "credential_or_permission_bypass", action: "deny_and_handoff", reason: "请求涉及凭据、完整身份金融信息或绕过权限" };
  }
  if (/(?:api\s*key|token|密码|验证码|口令|身份证号|银行卡号)/i.test(text)) {
    return { level: "high", category: "credential_or_identity", action: "redact_and_audit", reason: "问题可能包含凭据或身份金融信息" };
  }
  if (/(?:直属领导|领导|上级|同事|别人|他人|其他人).{0,12}(?:工资|薪资|薪酬|奖金|提成|收入)|(?:工资|薪资|薪酬|奖金|提成|收入).{0,12}(?:直属领导|领导|上级|同事|别人|他人|其他人)/.test(text)) {
    return { level: "high", category: "third_party_compensation", action: "deny_and_handoff", reason: "禁止查询或披露第三方薪酬信息" };
  }
  if (/劳动合同|合同争议|劳动争议|离职|辞职|辞退|解雇|裁员|仲裁|诉讼|竞业|补偿|赔偿|绩效申诉/.test(text)) {
    return { level: "high", category: "employment_dispute", action: "general_guidance_and_handoff", reason: "劳动关系个案需要 HR 或法务确认" };
  }
  if (/工资|薪资|薪酬|奖金|提成|收入|福利|补贴|社保|公积金|绩效|银行卡/.test(text)) {
    return { level: "high", category: "personal_hr_data", action: "limit_scope_and_handoff", reason: "涉及个人薪酬福利或人事敏感信息" };
  }
  return { level: "low", category: "general", action: "allow", reason: "未命中敏感信息规则" };
}
