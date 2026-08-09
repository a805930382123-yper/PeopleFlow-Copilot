import { readJson, writeJson, updateRecord } from "./json-store.mjs";
import { sanitizeForStorage } from "./privacy.mjs";
import { completeKnowledgeImportJob, deleteKnowledgeRawFile } from "./knowledge-ingestion.mjs";
import { indexKnowledgeDocument, listKnowledgeDocumentChunks, removeKnowledgeDocumentIndex } from "./knowledge-rag.mjs";

const makeId = () => `DOC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

function normalizeKeywords(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[,，、\n]/);
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))].slice(0, 30);
}

function normalizeDocument(input, current = null) {
  const content = String(input.content ?? current?.content ?? "").trim();
  const name = String(input.name ?? current?.name ?? "").trim();
  if (!name) throw new Error("知识文档名称不能为空");
  if (content.length < 10) throw new Error("知识文档正文至少需要 10 个字符");
  if (content.length > 100000) throw new Error("单个知识文档不能超过 10 万字符");
  const now = new Date().toISOString();
  const category = String(input.category ?? current?.category ?? "其他").trim().slice(0, 30) || "其他";
  const allowedStatuses = new Set(["draft", "processing", "review", "active", "inactive", "failed"]);
  const status = allowedStatuses.has(input.status) ? input.status : current?.status || "active";
  return sanitizeForStorage({
    ...current,
    id: current?.id || makeId(),
    name,
    category,
    version: String(input.version ?? current?.version ?? "1.0").trim() || "1.0",
    effective_date: String(input.effective_date ?? current?.effective_date ?? now.slice(0, 10)),
    status,
    review_status: input.review_status ?? current?.review_status ?? (status === "active" ? "approved" : "pending"),
    source_file: String(input.source_file ?? current?.source_file ?? `${name}.md`).trim(),
    keywords: normalizeKeywords(input.keywords ?? current?.keywords ?? []),
    content,
    expiry_date: String(input.expiry_date ?? current?.expiry_date ?? ""),
    department_scope: Array.isArray(input.department_scope ?? current?.department_scope) ? (input.department_scope ?? current.department_scope) : ["all"],
    sensitivity: ["public", "internal", "confidential"].includes(input.sensitivity ?? current?.sensitivity) ? (input.sensitivity ?? current.sensitivity) : "internal",
    created_at: current?.created_at || now,
    updated_at: now,
  });
}

export const listKnowledgeDocuments = () => readJson("knowledge_documents.json");

export async function createKnowledgeDocument(input) {
  const rows = await listKnowledgeDocuments();
  const document = normalizeDocument(input);
  rows.unshift(document);
  await writeJson("knowledge_documents.json", rows.slice(0, 500));
  if (document.status === "active") await indexKnowledgeDocument(document);
  return (await listKnowledgeDocuments()).find((item) => item.id === document.id) || document;
}

export async function saveKnowledgeDocument(id, patch) {
  const rows = await listKnowledgeDocuments();
  const current = rows.find((item) => item.id === id);
  if (!current) throw new Error(`未找到知识文档 ${id}`);
  const document = normalizeDocument(patch, current);
  await updateRecord("knowledge_documents.json", id, document);
  if (document.status === "active") await indexKnowledgeDocument(document);
  else await removeKnowledgeDocumentIndex(id);
  return (await listKnowledgeDocuments()).find((item) => item.id === id) || document;
}

export async function deleteKnowledgeDocument(id) {
  const rows = await listKnowledgeDocuments();
  const next = rows.filter((item) => item.id !== id);
  if (next.length === rows.length) throw new Error(`未找到知识文档 ${id}`);
  const current = rows.find((item) => item.id === id);
  await writeJson("knowledge_documents.json", next);
  await removeKnowledgeDocumentIndex(id);
  await deleteKnowledgeRawFile(current);
  return { id, deleted: true };
}

export async function publishKnowledgeDocument(id, patch = {}) {
  const rows = await listKnowledgeDocuments();
  const current = rows.find((item) => item.id === id);
  if (!current) throw new Error(`未找到知识文档 ${id}`);
  const document = normalizeDocument({ ...patch, status: "active", review_status: "approved" }, current);
  await updateRecord("knowledge_documents.json", id, { ...document, index_status: "indexing" });
  const result = await indexKnowledgeDocument(document);
  await completeKnowledgeImportJob(id, result);
  return (await listKnowledgeDocuments()).find((item) => item.id === id);
}

export async function reindexKnowledgeDocument(id) {
  const document = (await listKnowledgeDocuments()).find((item) => item.id === id);
  if (!document) throw new Error(`未找到知识文档 ${id}`);
  if (document.status !== "active") throw new Error("只有已发布文档可以重新建立索引");
  return indexKnowledgeDocument(document);
}

export const knowledgeDocumentChunks = (id) => listKnowledgeDocumentChunks(id);

export function documentStats(documents) {
  return {
    total: documents.length,
    active: documents.filter((item) => item.status === "active").length,
    review: documents.filter((item) => item.status === "review").length,
    failed: documents.filter((item) => item.status === "failed").length,
    indexed: documents.filter((item) => item.index_status === "ready").length,
    chunks: documents.reduce((sum, item) => sum + Number(item.chunk_count || 0), 0),
    categories: new Set(documents.map((item) => item.category)).size,
    characters: documents.reduce((sum, item) => sum + String(item.content || "").length, 0),
  };
}
