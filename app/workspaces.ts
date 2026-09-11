export const workspaces = [
  { id: "employee", label: "员工端", description: "查制度、看待办、跟进办理结果", items: [["employee-chat", "聊", "问问助手"], ["employee-tasks", "✓", "我的待办"], ["employee-progress", "↗", "处理进度"]] },
  { id: "enterprise", label: "企业管理端", description: "维护企业资料，处理员工需求", items: [["members", "人", "成员与分工"], ["knowledge", "▤", "知识库管理"], ["service-settings", "☷", "办事配置"], ["handoffs", "↗", "员工请求"], ["conversations", "◌", "会话与反馈"], ["analytics", "▥", "用量与效果"]] },
  { id: "advanced", label: "高级配置", description: "配置助手能力，验证回答质量", items: [["agent", "◎", "运行调试"], ["planner-admin", "⌘", "Plan 编排"], ["skills-admin", "◇", "Skill 管理"], ["tools-admin", "▣", "Tool 管理"], ["evaluations", "✓", "评测中心"], ["logs", "≡", "执行日志"], ["config-admin", "⚙", "模型与配置"]] },
];

export function workspaceFor(view: string) {
  return workspaces.find((space) => space.items.some(([id]) => id === view)) || workspaces[2];
}

export function normalizeView(value: string | null) {
  const aliases: Record<string, string> = { plans: "planner-admin", skills: "skills-admin", tools: "tools-admin", tests: "tools-admin", config: "config-admin" };
  const view = aliases[value || ""] || value || "employee-chat";
  return workspaces.some((space) => space.items.some(([id]) => id === view)) ? view : "employee-chat";
}
