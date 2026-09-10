import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./enhancements.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const privateFull = requestHeaders.get("x-peopleflow-mode") === "private-full";
  const title = privateFull ? "企业入职小助手 · 私有管理平台" : "企业入职小助手 · AI Agent 公开演示";
  const description = privateFull
    ? "企业入职 AI Agent 的私有全功能管理平台，以 Plan + Skill + Tool 驱动知识库、评测与运行监测。"
    : "帮助新员工查询入职材料、报到流程、直属领导和企业制度的 AI Agent 产品演示。";
  return {
    title,
    description,
    openGraph: { title, description, type: "website", images: [{ url: `${origin}/og.jpg`, width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.jpg`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
