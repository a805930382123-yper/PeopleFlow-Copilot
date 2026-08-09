"use client";

import { useMemo, useRef, useState } from "react";

export type KnowledgeDocument = {
  id: string;
  name: string;
  category: string;
  version: string;
  effective_date: string;
  expiry_date?: string;
  status: "draft" | "processing" | "review" | "active" | "inactive" | "failed";
  review_status?: string;
  source_file: string;
  source_type?: string;
  parser?: string;
  keywords: string[];
  content: string;
  warnings?: string[];
  requires_ocr?: boolean;
  sensitivity?: "public" | "internal" | "confidential";
  department_scope?: string[];
  file_size?: number;
  chunk_count?: number;
  index_status?: string;
  embedding_provider?: string;
  embedding_model?: string;
  updated_at: string;
};

export type KnowledgeImportJob = { id: string; document_id: string; filename: string; status: string; stage: string; progress: number; warnings?: string[]; error?: string | null; updated_at: string };
export type KnowledgeRuntime = { documents: number; active_documents: number; indexed_documents: number; chunks: number; embedding: { provider: string; model: string; configured: boolean; semantic?: boolean; label?: string } };
type KnowledgeStats = { total: number; active: number; review?: number; failed?: number; indexed?: number; chunks?: number; categories: number; characters: number };
type KnowledgeChunk = { id: string; document_id: string; title: string; section: string; content: string; page?: number | null; slide?: number | null; dimensions: number; embedding_provider: string; embedding_model: string };
type SearchCard = { chunk_id: string; title: string; section?: string; category: string; content: string; source_file?: string; page?: number | null; slide?: number | null; score: number; score_detail?: { keyword: number; vector: number } };
type Request = (path: string, options?: RequestInit) => Promise<unknown>;

const blank = () => ({ name: "", category: "制度手册", version: "1.0", effective_date: new Date().toISOString().slice(0, 10), expiry_date: "", status: "active" as KnowledgeDocument["status"], source_file: "", source_type: "Markdown", sensitivity: "internal" as "public" | "internal" | "confidential", department_scope: "all", keywords: "", content: "" });
const statusMap: Record<string, { label: string; tone: string }> = {
  active: { label: "已发布", tone: "green" }, review: { label: "待复核", tone: "orange" }, processing: { label: "解析中", tone: "blue" }, failed: { label: "处理失败", tone: "red" }, inactive: { label: "已停用", tone: "neutral" }, draft: { label: "草稿", tone: "neutral" },
};
const locationLabel = (item: { page?: number | null; slide?: number | null }) => item.page ? `第 ${item.page} 页` : item.slide ? `第 ${item.slide} 张幻灯片` : "正文";
const fileSize = (value = 0) => value ? value > 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB` : "文本录入";

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

export default function KnowledgeCenter({ documents, stats, importJobs, runtime, request, onReload, notify }: { documents: KnowledgeDocument[]; stats: KnowledgeStats; importJobs: KnowledgeImportJob[]; runtime: KnowledgeRuntime; request: Request; onReload: () => Promise<void>; notify: (message: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(blank());
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [previewQuery, setPreviewQuery] = useState("几点下班？");
  const [previewing, setPreviewing] = useState(false);
  const [searchCards, setSearchCards] = useState<SearchCard[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const categories = useMemo(() => [...new Set(documents.map((item) => item.category))], [documents]);
  const formCategories = useMemo(() => [...new Set(["待分类", "制度手册", "入职指南", "福利制度", "考勤管理", "行政事务", "财务报销", "IT 服务", "信息安全", "HR 服务", "其他", ...categories])], [categories]);
  const visible = useMemo(() => documents.filter((item) => (category === "all" || item.category === category) && (status === "all" || item.status === status) && (!search.trim() || `${item.name} ${item.category} ${(item.keywords || []).join(" ")} ${item.content}`.toLowerCase().includes(search.trim().toLowerCase()))), [documents, category, status, search]);
  const current = documents.find((item) => item.id === editingId) || null;
  const recentJobs = importJobs.slice(0, 4);

  const reset = () => { setEditingId(null); setDraft(blank()); setChunks([]); };
  const edit = async (item: KnowledgeDocument) => {
    setEditingId(item.id);
    setDraft({ name: item.name, category: item.category, version: item.version, effective_date: item.effective_date || "", expiry_date: item.expiry_date || "", status: item.status, source_file: item.source_file, source_type: item.source_type || "Text", sensitivity: item.sensitivity || "internal", department_scope: (item.department_scope || ["all"]).join("，"), keywords: (item.keywords || []).join("，"), content: item.content });
    try { setChunks(await request(`/knowledge-documents/${item.id}/chunks`) as KnowledgeChunk[]); } catch { setChunks([]); }
  };
  const payload = () => ({ ...draft, keywords: draft.keywords.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean), department_scope: draft.department_scope.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean) });
  const save = async () => {
    setSaving(true);
    try {
      const saved = await request(editingId ? `/knowledge-documents/${editingId}` : "/knowledge-documents", { method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) }) as KnowledgeDocument;
      await onReload(); setEditingId(saved.id); notify(editingId ? "知识文档已更新" : "知识文档已加入知识库");
    } catch (error) { notify(error instanceof Error ? error.message : "知识文档保存失败"); }
    finally { setSaving(false); }
  };
  const uploadFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { notify("单个文件不能超过 20MB"); return; }
    setUploading(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await request("/knowledge-files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, mime_type: file.type, size: file.size, base64 }) }) as { document: KnowledgeDocument };
      await onReload(); await edit(result.document); notify(result.document.status === "review" ? "文件解析完成，请复核后发布" : "文件需要 OCR 或人工处理");
    } catch (error) { notify(error instanceof Error ? error.message : "文件上传失败"); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const publish = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await request(`/knowledge-documents/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload(), status: "review" }) });
      await request(`/knowledge-documents/${editingId}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) });
      await onReload(); await edit({ ...current, ...payload(), id: editingId, status: "active" } as KnowledgeDocument); notify("文档已发布并完成 RAG 索引");
    } catch (error) { notify(error instanceof Error ? error.message : "文档发布失败"); }
    finally { setSaving(false); }
  };
  const reindex = async () => {
    if (!editingId) return;
    setSaving(true);
    try { await request(`/knowledge-documents/${editingId}/reindex`, { method: "POST" }); await onReload(); await edit(current as KnowledgeDocument); notify("文档索引已重建"); }
    catch (error) { notify(error instanceof Error ? error.message : "重新索引失败"); }
    finally { setSaving(false); }
  };
  const previewSearch = async () => {
    if (!previewQuery.trim()) return;
    setPreviewing(true);
    try {
      const result = await request("/knowledge-search/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: previewQuery, limit: 8 }) }) as { knowledge_cards: SearchCard[] };
      setSearchCards(result.knowledge_cards || []);
    } catch (error) { notify(error instanceof Error ? error.message : "检索测试失败"); }
    finally { setPreviewing(false); }
  };

  return <div className="page knowledge-center rag-center">
    <div className="page-heading"><div><h1>知识库管理</h1><p>上传 PDF、PPTX、DOCX 或文本文件，系统自动解析；复核发布后完成切片和混合检索索引。</p></div><div className="heading-actions"><button className="secondary compact" onClick={reset}>＋ 手工录入</button><button className="primary compact" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? "正在解析…" : "＋ 上传原始文件"}</button></div></div>
    <input ref={fileRef} className="hidden-input" type="file" accept=".pdf,.pptx,.docx,.md,.txt,.json,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => uploadFile(event.target.files?.[0])}/>
    <div className="rag-runtime panel"><div><span className="rag-dot"/><strong>RAG 索引运行中</strong><small>{runtime.embedding?.label || runtime.embedding?.model} · {runtime.embedding?.semantic ? "语义向量" : "本地字符向量（可切换外部 Embedding）"}</small></div><div><b>{runtime.indexed_documents || 0}</b><span>已索引文档</span></div><div><b>{runtime.chunks || 0}</b><span>知识切片</span></div></div>
    <div className="dashboard-metrics knowledge-metrics rag-metrics"><div className="panel"><b>{stats.total}</b><span>全部文档</span></div><div className="panel"><b>{stats.active}</b><span>已发布</span></div><div className="panel"><b>{stats.review || 0}</b><span>待复核</span></div><div className="panel"><b>{stats.failed || 0}</b><span>处理失败</span></div><div className="panel"><b>{stats.categories}</b><span>知识分类</span></div><div className="panel"><b>{stats.chunks || 0}</b><span>检索切片</span></div></div>
    {recentJobs.length > 0 && <section className="panel import-jobs"><header><div><strong>最近导入任务</strong><small>原文件解析、复核与索引进度</small></div></header><div>{recentJobs.map((job) => <article key={job.id}><span className={`badge ${job.status === "completed" ? "green" : job.status === "failed" ? "red" : "orange"}`}>{job.status === "completed" ? "已完成" : job.status === "review" ? "待复核" : job.status === "failed" ? "失败" : "处理中"}</span><div><strong>{job.filename}</strong><small>{job.stage}{job.error ? ` · ${job.error}` : ""}</small></div><progress max="100" value={job.progress || 0}/></article>)}</div></section>}
    <div className="knowledge-layout rag-layout">
      <section className="panel knowledge-list">
        <div className="knowledge-toolbar rag-toolbar"><input aria-label="搜索知识文档" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文档名称、关键词或正文"/><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.map((item) => <option key={item}>{item}</option>)}</select><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="active">已发布</option><option value="review">待复核</option><option value="failed">处理失败</option><option value="inactive">已停用</option></select></div>
        <div className="knowledge-rows">{visible.map((item) => { const state = statusMap[item.status] || statusMap.draft; return <article className={`knowledge-row ${editingId === item.id ? "selected" : ""}`} key={item.id}><button className="knowledge-main" onClick={() => edit(item)}><span className="knowledge-file">{item.source_type === "PDF" ? "P" : item.source_type === "PPTX" ? "幻" : item.source_type === "DOCX" ? "W" : "文"}</span><div><div><strong>{item.name}</strong><span className={`badge ${state.tone}`}>{state.label}</span></div><p>{item.content || item.warnings?.join("；") || "尚未提取正文"}</p><small>{item.category} · v{item.version} · {item.chunk_count || 0} 个切片 · {item.source_file}</small></div></button><div className="knowledge-actions"><button onClick={() => edit(item)}>查看</button><button className="danger-link" onClick={async () => { if (!confirm(`确认删除“${item.name}”？原文件和索引也会被删除。`)) return; await request(`/knowledge-documents/${item.id}`, { method: "DELETE" }); await onReload(); if (editingId === item.id) reset(); notify("知识文档已删除"); }}>删除</button></div></article>; })}</div>
      </section>
      <aside className="panel knowledge-editor rag-editor">
        <div className="editor-title"><div><span className="knowledge-file">{editingId ? "编" : "新"}</span><div><strong>{editingId ? "复核知识文档" : "手工录入文档"}</strong><small>{current ? `${current.source_type || "Text"} · ${fileSize(current.file_size)}` : "保存后立即建立索引"}</small></div></div>{current && <span className={`badge ${(statusMap[current.status] || statusMap.draft).tone}`}>{(statusMap[current.status] || statusMap.draft).label}</span>}</div>
        {Boolean(current?.warnings?.length) && <div className="knowledge-warning">{current?.warnings?.map((item) => <p key={item}>{item}</p>)}</div>}
        <label>文档名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label>
        <div className="knowledge-form-grid"><label>分类<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>{formCategories.map((item) => <option key={item}>{item}</option>)}</select></label><label>版本<input value={draft.version} onChange={(event) => setDraft({ ...draft, version: event.target.value })}/></label></div>
        <div className="knowledge-form-grid"><label>生效日期<input type="date" value={draft.effective_date} onChange={(event) => setDraft({ ...draft, effective_date: event.target.value })}/></label><label>失效日期<input type="date" value={draft.expiry_date} onChange={(event) => setDraft({ ...draft, expiry_date: event.target.value })}/></label></div>
        <div className="knowledge-form-grid"><label>保密级别<select value={draft.sensitivity} onChange={(event) => setDraft({ ...draft, sensitivity: event.target.value as typeof draft.sensitivity })}><option value="public">公开</option><option value="internal">内部</option><option value="confidential">机密</option></select></label><label>适用部门<input value={draft.department_scope} onChange={(event) => setDraft({ ...draft, department_scope: event.target.value })} placeholder="all 或多个部门"/></label></div>
        <label>来源文件<input value={draft.source_file} onChange={(event) => setDraft({ ...draft, source_file: event.target.value })}/></label>
        <label>检索关键词<input value={draft.keywords} onChange={(event) => setDraft({ ...draft, keywords: event.target.value })} placeholder="考勤，下班时间，打卡"/></label>
        <label>解析正文<textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="上传后自动提取；请在发布前复核关键金额、人员和制度日期"/></label>
        <div className="rag-editor-actions"><button className="secondary" disabled={saving} onClick={save}>{saving ? "处理中…" : editingId ? "保存修改" : "保存并启用"}</button>{current?.status === "review" && <button className="primary" disabled={saving || draft.content.length < 10} onClick={publish}>审核通过并发布</button>}{current?.status === "active" && <button className="primary" disabled={saving} onClick={reindex}>重新建立索引</button>}</div>
        {editingId && <details className="chunk-preview" open={chunks.length > 0}><summary>查看文档切片（{chunks.length}）</summary><div>{chunks.slice(0, 20).map((chunk) => <article key={chunk.id}><strong>{chunk.section}</strong><small>{locationLabel(chunk)} · {chunk.dimensions} 维 · {chunk.embedding_model}</small><p>{chunk.content}</p></article>)}{!chunks.length && <p className="empty-state">文档发布后会在这里显示检索切片。</p>}</div></details>}
      </aside>
    </div>
    <section className="panel retrieval-lab"><header><div><strong>RAG 检索测试</strong><small>发布前后都可以用真实员工问题验证召回结果，不调用回答大模型。</small></div><div><input value={previewQuery} onChange={(event) => setPreviewQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") previewSearch(); }} placeholder="例如：几点下班？"/><button className="primary compact" disabled={previewing} onClick={previewSearch}>{previewing ? "检索中…" : "测试召回"}</button></div></header><div className="retrieval-results">{searchCards.map((card, index) => <article key={card.chunk_id}><span>{index + 1}</span><div><div><strong>{card.title}</strong><em>{card.category} · {locationLabel(card)} · 相关度 {(card.score * 100).toFixed(1)}%</em></div><p>{card.content}</p><small>{card.source_file}{card.section ? ` · ${card.section}` : ""} · 关键词 {((card.score_detail?.keyword || 0) * 100).toFixed(0)}% / 向量 {((card.score_detail?.vector || 0) * 100).toFixed(0)}%</small></div></article>)}{!searchCards.length && <div className="empty-state">输入问题后，可以查看实际命中的文档片段、来源位置和混合检索分数。</div>}</div></section>
  </div>;
}
