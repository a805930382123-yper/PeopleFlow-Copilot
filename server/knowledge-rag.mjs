import { createHash } from "node:crypto";
import { readJson, readJsonOr, updateJson } from "./json-store.mjs";
import { cosineSimilarity, embedTexts, getEmbeddingRuntimeConfig, localEmbedding } from "./embedding.mjs";

const CHUNK_FILE = "knowledge_chunks.json";
const TARGET_SIZE = 700;
const OVERLAP = 100;

const hash = (value) => createHash("sha256").update(String(value || "")).digest("hex");

function sections(document) {
  if (Array.isArray(document.segments) && document.segments.length) return document.segments;
  const lines = String(document.content || "").replace(/\r/g, "").split("\n");
  const result = [];
  let title = document.name || "正文";
  let buffer = [];
  const flush = () => { const content = buffer.join("\n").trim(); if (content) result.push({ title, content, page: null, slide: null }); buffer = []; };
  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) { flush(); title = heading[1].trim(); }
    else buffer.push(line);
  }
  flush();
  return result.length ? result : [{ title: document.name || "正文", content: document.content || "", page: null, slide: null }];
}

export function chunkDocument(document) {
  const chunks = [];
  for (const section of sections(document)) {
    const text = String(section.content || "").trim();
    if (!text) continue;
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + TARGET_SIZE);
      if (end < text.length) {
        const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf("。", end), text.lastIndexOf("；", end));
        if (boundary > offset + 300) end = boundary + 1;
      }
      const content = text.slice(offset, end).trim();
      if (content) chunks.push({
        id: `CHK-${document.id}-${String(chunks.length + 1).padStart(3, "0")}`,
        document_id: document.id,
        title: document.name,
        section: section.title || document.name,
        content,
        page: section.page || null,
        slide: section.slide || null,
        category: document.category || "知识文档",
        version: document.version || "1.0",
        effective_date: document.effective_date || "",
        department_scope: document.department_scope || ["all"],
        sensitivity: document.sensitivity || "internal",
        source_file: document.source_file || "",
        document_hash: hash(document.content),
      });
      if (end >= text.length) break;
      offset = Math.max(offset + 1, end - OVERLAP);
    }
  }
  return chunks;
}

export async function indexKnowledgeDocument(document, options = {}) {
  const chunks = chunkDocument(document);
  if (!chunks.length) throw new Error("文档没有可用于建立索引的正文");
  const embedding = await embedTexts(chunks.map((item) => `${item.title}\n${item.section}\n${item.content}`), options);
  const now = new Date().toISOString();
  const indexed = chunks.map((item, index) => ({ ...item, embedding: embedding.vectors[index], embedding_provider: embedding.provider, embedding_model: embedding.model, indexed_at: now }));
  await updateJson(CHUNK_FILE, (current) => [...current.filter((item) => item.document_id !== document.id), ...indexed], []);
  await updateJson("knowledge_documents.json", (documents) => {
    const position = documents.findIndex((item) => item.id === document.id);
    if (position >= 0) documents[position] = { ...documents[position], chunk_count: indexed.length, index_status: "ready", embedding_provider: embedding.provider, embedding_model: embedding.model, indexed_at: now, updated_at: now };
  });
  return { document_id: document.id, chunk_count: indexed.length, embedding_provider: embedding.provider, embedding_model: embedding.model, indexed_at: now };
}

export async function removeKnowledgeDocumentIndex(documentId) {
  let removedChunks = 0;
  await updateJson(CHUNK_FILE, (current) => {
    const next = current.filter((item) => item.document_id !== documentId);
    removedChunks = current.length - next.length;
    return next;
  }, []);
  return { removed_chunks: removedChunks };
}

function lexicalFeatures(value = "") {
  const text = String(value).toLowerCase().replace(/请问|麻烦|帮我|我的|我们|公司|今天|现在|一下|有哪些|有什么|是什么|怎么样|怎么办|怎么|如何|是否|能不能|可不可以|可以吗|几点|多少/g, "");
  const features = new Set(text.match(/[a-z0-9][a-z0-9_.-]{1,}/g) || []);
  const chinese = text.match(/[\u3400-\u9fff]/g) || [];
  for (let size = 2; size <= 3; size += 1) for (let index = 0; index <= chinese.length - size; index += 1) features.add(chinese.slice(index, index + size).join(""));
  return [...features];
}

function lexicalScore(query, chunk, document) {
  const queryFeatures = lexicalFeatures(query);
  const section = String(chunk.section || "").toLowerCase();
  const title = String(chunk.title || "").toLowerCase();
  const keywords = (document.keywords || []).join(" ").toLowerCase();
  const body = chunk.content.toLowerCase();
  if (!queryFeatures.length) return 0;
  let weighted = 0;
  for (const feature of queryFeatures) {
    if (section.includes(feature)) weighted += 4;
    else if (body.includes(feature)) weighted += 2;
    else if (title.includes(feature)) weighted += 1.5;
    else if (keywords.includes(feature)) weighted += 0.5;
  }
  return Math.min(1, weighted / (queryFeatures.length * 3));
}

export async function searchKnowledgeDocuments({ query, limit = 8, category = "all" } = {}) {
  const [documents, chunks] = await Promise.all([readJson("knowledge_documents.json"), readJsonOr(CHUNK_FILE, [])]);
  const active = new Map(documents.filter((item) => item.status === "active" && (category === "all" || item.category === category)).map((item) => [item.id, item]));
  const localQuery = localEmbedding(query);
  const runtime = getEmbeddingRuntimeConfig();
  let liveQuery = null;
  if (runtime.provider === "openai-compatible" && runtime.configured && chunks.some((item) => item.embedding_provider === runtime.provider && item.embedding_model === runtime.model)) {
    liveQuery = (await embedTexts([query])).vectors[0];
  }
  const ranked = chunks
    .filter((item) => active.has(item.document_id))
    .map((item) => {
      const document = active.get(item.document_id);
      const lexical = lexicalScore(query, item, document);
      const vector = item.embedding_provider === "local-hash"
        ? Math.max(0, cosineSimilarity(localQuery, item.embedding))
        : liveQuery && item.embedding_model === runtime.model ? Math.max(0, cosineSimilarity(liveQuery, item.embedding)) : 0;
      const retrievalPenalty = /用户可能|检索词|关键词/.test(item.section || "") ? 0.55 : 1;
      const score = Number(((lexical * 0.45 + vector * 0.55) * retrievalPenalty).toFixed(6));
      return { item, document, lexical, vector, score };
    })
    .filter(({ item, lexical, vector }) => lexical >= 0.12 || (item.embedding_provider !== "local-hash" && vector >= 0.42))
    .sort((a, b) => b.score - a.score || b.lexical - a.lexical);
  const perDocument = new Map();
  const selected = [];
  for (const result of ranked) {
    const count = perDocument.get(result.item.document_id) || 0;
    if (count >= 2) continue;
    perDocument.set(result.item.document_id, count + 1);
    selected.push(result);
    if (selected.length >= Math.max(1, Math.min(20, Number(limit) || 8))) break;
  }
  return {
    knowledge_cards: selected.map(({ item, score, lexical, vector }) => ({
      id: item.id,
      chunk_id: item.id,
      category: item.category,
      title: item.title,
      section: item.section,
      content: item.content,
      source: "knowledge_documents.json",
      source_id: item.document_id,
      source_file: item.source_file,
      version: item.version,
      effective_date: item.effective_date,
      page: item.page,
      slide: item.slide,
      score,
      score_detail: { keyword: Number(lexical.toFixed(4)), vector: Number(vector.toFixed(4)) },
    })),
    retrieval_summary: { query, mode: "hybrid", total_chunks: chunks.length, active_documents: active.size, matched_count: selected.length, embedding: runtime },
  };
}

export async function listKnowledgeDocumentChunks(documentId) {
  return (await readJsonOr(CHUNK_FILE, [])).filter((item) => item.document_id === documentId).map(({ embedding, ...item }) => ({ ...item, dimensions: embedding?.length || 0 }));
}

export async function ensureKnowledgeIndex() {
  const [documents, chunks] = await Promise.all([readJson("knowledge_documents.json"), readJsonOr(CHUNK_FILE, [])]);
  const indexed = new Map(chunks.map((item) => [item.document_id, item.document_hash]));
  const pending = documents.filter((item) => item.status === "active" && indexed.get(item.id) !== hash(item.content));
  const results = [];
  for (const document of pending) {
    try { results.push(await indexKnowledgeDocument(document, { forceLocal: true })); }
    catch (error) { results.push({ document_id: document.id, error: error.message }); }
  }
  return { checked: documents.length, indexed: results.filter((item) => !item.error).length, errors: results.filter((item) => item.error) };
}

export async function knowledgeRagStats() {
  const [documents, chunks] = await Promise.all([readJson("knowledge_documents.json"), readJsonOr(CHUNK_FILE, [])]);
  return { documents: documents.length, active_documents: documents.filter((item) => item.status === "active").length, indexed_documents: new Set(chunks.map((item) => item.document_id)).size, chunks: chunks.length, embedding: getEmbeddingRuntimeConfig() };
}
