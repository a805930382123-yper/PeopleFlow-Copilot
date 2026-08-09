export function deterministicReview(reply, context) {
  const issues = [];
  if (/planner|skill|tool|prompt|json/i.test(reply)) issues.push("回复暴露了内部执行信息");
  if (/一定|保证|承诺/.test(reply) && /社保|公积金|薪酬|合同/.test(reply)) issues.push("敏感事项存在确定性承诺");
  if (context.notFound && !reply.includes("当前系统未查询到相关信息")) issues.push("缺少未查询到信息的明确提示");
  return { risk_level: context.sensitive ? "high" : (issues.length ? "medium" : "low"), passed: issues.length === 0, issues, suggestions: issues.length ? ["移除内部执行细节与未经查询的确定性表述", "只保留本地数据能够支持的事实"] : context.sensitive ? ["该问题涉及高敏感人事信息，应限制数据范围并转交有权限的 HR 或法务处理", "不得查询或披露他人的薪资、合同、福利或争议信息"] : ["回复仅使用当前员工有权访问的模拟数据", "未发现制度编造、隐私泄露或不当承诺"] };
}
