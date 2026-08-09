import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, readJsonOr, writeJson } from "./json-store.mjs";
import { parseKnowledgeFile, supportedKnowledgeFile } from "./knowledge-parser.mjs";
import { sanitizeForStorage } from "./privacy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadRoot = path.join(projectRoot, "uploads", "knowledge");
const JOB_FILE = "knowledge_import_jobs.json";
const MAX_BYTES = 20 * 1024 * 1024;

const makeId = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
const safeExtension = (filename) => path.extname(filename).toLowerCase();

function safeFilename(filename = "") {
  return path.basename(filename).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 160) || "knowledge-file";
}

async function saveJobs(jobs) {
  await writeJson(JOB_FILE, jobs.slice(0, 200));
}

export const listKnowledgeImportJobs = () => readJsonOr(JOB_FILE, []);

export async function ingestKnowledgeFile(input = {}) {
  const filename = safeFilename(input.filename);
  if (!supportedKnowledgeFile(filename)) throw new Error("仅支持 PDF、PPTX、DOCX、Markdown、TXT 和 JSON 文件");
  const buffer = Buffer.from(String(input.base64 || ""), "base64");
  if (!buffer.length) throw new Error("上传文件为空");
  if (buffer.length > MAX_BYTES) throw new Error("单个知识文件不能超过 20MB");
  const declaredSize = Number(input.size || 0);
  if (declaredSize && Math.abs(declaredSize - buffer.length) > 4) throw new Error("文件大小校验失败，请重新上传");
  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const documents = await readJson("knowledge_documents.json");
  const duplicate = documents.find((item) => item.file_hash === fileHash && item.status !== "failed");
  if (duplicate) {
    const error = new Error(`该文件已上传：${duplicate.name}`);
    error.code = "KNOWLEDGE_FILE_DUPLICATE";
    error.document_id = duplicate.id;
    throw error;
  }
  const documentId = makeId("DOC");
  const jobId = makeId("IMPORT");
  const now = new Date().toISOString();
  const jobs = await listKnowledgeImportJobs();
  const job = sanitizeForStorage({ id: jobId, document_id: documentId, filename, status: "processing", stage: "extracting", progress: 20, warnings: [], error: null, created_at: now, updated_at: now });
  jobs.unshift(job);
  await saveJobs(jobs);
  const directory = path.join(uploadRoot, documentId);
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(path.resolve(uploadRoot) + path.sep)) throw new Error("非法知识文件路径");
  await mkdir(directory, { recursive: true });
  const rawPath = path.join(directory, `original${safeExtension(filename)}`);
  await writeFile(rawPath, buffer);
  try {
    const parsed = await parseKnowledgeFile({ filename, buffer });
    const title = String(input.name || parsed.segments[0]?.title || path.basename(filename, path.extname(filename))).trim();
    const status = parsed.text.length >= 10 ? "review" : "failed";
    const document = sanitizeForStorage({
      id: documentId,
      name: title,
      category: String(input.category || "待分类"),
      version: String(input.version || "1.0"),
      effective_date: String(input.effective_date || ""),
      expiry_date: String(input.expiry_date || ""),
      status,
      review_status: status === "review" ? "pending" : "blocked",
      source_file: filename,
      source_type: parsed.source_type,
      parser: parsed.parser,
      keywords: Array.isArray(input.keywords) ? input.keywords : [],
      content: parsed.text,
      segments: parsed.segments,
      warnings: parsed.warnings,
      requires_ocr: parsed.requires_ocr,
      department_scope: Array.isArray(input.department_scope) && input.department_scope.length ? input.department_scope : ["all"],
      sensitivity: ["public", "internal", "confidential"].includes(input.sensitivity) ? input.sensitivity : "internal",
      file_hash: fileHash,
      file_size: buffer.length,
      raw_file: path.relative(projectRoot, rawPath).replace(/\\/g, "/"),
      chunk_count: 0,
      index_status: status === "review" ? "waiting_review" : "failed",
      import_job_id: jobId,
      created_at: now,
      updated_at: new Date().toISOString(),
    });
    documents.unshift(document);
    await writeJson("knowledge_documents.json", documents.slice(0, 500));
    Object.assign(job, { status: status === "review" ? "review" : "failed", stage: status === "review" ? "waiting_review" : "ocr_required", progress: status === "review" ? 70 : 40, warnings: parsed.warnings, error: status === "failed" ? "没有提取到足够正文，请对扫描件进行 OCR 后重新上传" : null, updated_at: new Date().toISOString() });
    await saveJobs(jobs);
    return { document, job };
  } catch (error) {
    Object.assign(job, { status: "failed", stage: "extract_failed", error: error.message, progress: 0, updated_at: new Date().toISOString() });
    await saveJobs(jobs);
    throw error;
  }
}

export async function completeKnowledgeImportJob(documentId, result) {
  const jobs = await listKnowledgeImportJobs();
  const job = jobs.find((item) => item.document_id === documentId);
  if (job) {
    Object.assign(job, { status: "completed", stage: "published", progress: 100, result, updated_at: new Date().toISOString() });
    await saveJobs(jobs);
  }
}

export async function deleteKnowledgeRawFile(document) {
  if (!document?.raw_file) return;
  const directory = path.resolve(projectRoot, path.dirname(document.raw_file));
  if (!directory.startsWith(path.resolve(uploadRoot) + path.sep)) throw new Error("拒绝删除知识上传目录之外的文件");
  await rm(directory, { recursive: true, force: true });
}
