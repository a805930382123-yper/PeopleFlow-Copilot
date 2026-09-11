"use client";

import { useEffect } from "react";
import "./admin.css";

const embeddedViews: Record<string, string> = {
  "/skills": "skills-admin",
  "/tools": "tools-admin",
  "/planner": "planner-admin",
  "/models": "config-admin",
};

export default function AdminShell({ active, title, description, children, badge, embedded = false }: { active: string; title: string; description: string; children: React.ReactNode; badge?: React.ReactNode; embedded?: boolean }) {
  useEffect(() => {
    if (!embedded && embeddedViews[active]) window.location.replace(`/?view=${embeddedViews[active]}`);
  }, [active, embedded]);

  if (!embedded) return <main className="admin-redirect"><StatePanel state="loading" message="正在返回 PeopleFlow 统一管理平台…"/></main>;

  return <section className="admin-embedded">
    <header className="admin-header"><div><small>PeopleFlow / 高级配置</small><h1>{title}</h1><p>{description}</p></div>{badge}</header>
    {children}
  </section>;
}

export function StatePanel({ state, message, onRetry }: { state: "loading" | "empty" | "error"; message?: string; onRetry?: () => void }) {
  return <section className={`admin-state ${state}`}><span>{state === "loading" ? "···" : state === "error" ? "!" : "○"}</span><strong>{state === "loading" ? "正在加载服务端配置" : state === "error" ? "加载失败" : "暂无数据"}</strong>{message && <p>{message}</p>}{onRetry && <button onClick={onRetry}>重新加载</button>}</section>;
}

export function Status({ enabled, children }: { enabled?: boolean; children?: React.ReactNode }) {
  return <span className={`admin-status ${enabled ? "success" : "muted"}`}><i/>{children || (enabled ? "已启用" : "已禁用")}</span>;
}
