import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeForStorage } from "../server/privacy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputRoot = path.resolve(process.argv[2] || "");
const dataFile = path.resolve(process.argv[3] || path.join(projectRoot, "data", "knowledge_documents.json"));
const reportFile = path.resolve(process.argv[4] || path.join(projectRoot, "artifacts", "knowledge-import", "import-report.json"));
const dryRun = process.argv.includes("--dry-run");

if (!process.argv[2]) throw new Error("请提供已解压的 Markdown 根目录");
if (!inputRoot.startsWith(projectRoot + path.sep)) throw new Error("导入目录必须位于当前项目工作区内");
if (dataFile !== path.join(projectRoot, "data", "knowledge_documents.json")) throw new Error("数据目标必须是项目 knowledge_documents.json");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(target);
  }
  return files;
}

function scalar(value = "") {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

function parseFrontMatter(markdown) {
  if (!markdown.startsWith("---")) return { metadata: {}, body: markdown.trim() };
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return { metadata: {}, body: markdown.trim() };
  const block = markdown.slice(4, end).replace(/\r/g, "");
  const metadata = {};
  let listKey = null;
  for (const line of block.split("\n")) {
    const list = line.match(/^\s*-\s+(.+)$/);
    if (list && listKey) { metadata[listKey].push(scalar(list[1])); continue; }
    const pair = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, value] = pair;
    if (!value.trim()) { metadata[key] = []; listKey = key; }
    else { metadata[key] = scalar(value); listKey = null; }
  }
  return { metadata, body: markdown.slice(end + 4).trim() };
}

function titleFrom(body, file) {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, path.extname(file)).replace(/^\d+_/, "");
}

function categoryFrom(relativePath, metadata) {
  if (metadata.category) return String(metadata.category).trim();
  const name = path.basename(relativePath);
  if (name === "README.md") return "知识库说明";
  if (/复核清单/.test(name)) return "知识库治理";
  const firstDirectory = relativePath.split(/[\\/]/)[0] || "其他";
  return firstDirectory.replace(/^\d+_/, "").trim() || "其他";
}

function makeKeywords(metadata, title, category, body) {
  const source = Array.isArray(metadata.keywords) ? metadata.keywords : String(metadata.keywords || "").split(/[,，、]/);
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((match) => match[1].trim());
  return [...new Set([...source, title, category, ...headings].map((item) => String(item).trim()).filter(Boolean))].slice(0, 40);
}

function stableId(relativePath) {
  return `DOC-GCS-${createHash("sha1").update(relativePath.replace(/\\/g, "/")).digest("hex").slice(0, 12).toUpperCase()}`;
}

const files = (await walk(inputRoot)).sort((a, b) => a.localeCompare(b, "zh-CN"));
const current = JSON.parse(await readFile(dataFile, "utf8"));
const byId = new Map(current.map((item, index) => [item.id, { item, index }]));
const bySource = new Map(current.map((item, index) => [String(item.source_file || "").replace(/\\/g, "/").toLowerCase(), { item, index }]));
const report = { source: inputRoot, target: dataFile, dry_run: dryRun, started_at: new Date().toISOString(), scanned: files.length, inserted: 0, updated: 0, unchanged: 0, masked_documents: 0, categories: {}, confidence: {}, documents: [], errors: [] };

for (const file of files) {
  try {
    const relativePath = path.relative(inputRoot, file).replace(/\\/g, "/");
    const raw = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
    const { metadata, body } = parseFrontMatter(raw);
    const title = String(metadata.title || titleFrom(body, file)).trim();
    const category = categoryFrom(relativePath, metadata);
    const contentHash = createHash("sha256").update(body).digest("hex");
    const sanitizedBody = sanitizeForStorage(body);
    if (sanitizedBody !== body) report.masked_documents += 1;
    const now = new Date().toISOString();
    const document = sanitizeForStorage({
      id: stableId(relativePath),
      name: title,
      category,
      version: String(metadata.version || "1.0"),
      effective_date: /^\d{4}-\d{2}-\d{2}$/.test(String(metadata.effective_date || "")) ? metadata.effective_date : "",
      status: metadata.knowledge_status === "inactive" ? "inactive" : "active",
      source_file: relativePath,
      keywords: makeKeywords(metadata, title, category, body),
      content: sanitizedBody,
      department: String(metadata.department || "").trim(),
      source: String(metadata.source || "批量导入 Markdown").trim(),
      source_type: String(metadata.source_type || "Markdown").trim(),
      sensitivity: String(metadata.sensitivity || "internal").trim(),
      content_confidence: String(metadata.content_confidence || "unknown").trim(),
      last_verified: String(metadata.last_verified || "待确认").trim(),
      collection: "国创所企业入职助手知识库",
      content_hash: contentHash,
      import_source: "国创所企业入职助手知识库_MD.zip",
      imported_at: now,
      created_at: now,
      updated_at: now,
    });
    const existing = byId.get(document.id) || bySource.get(relativePath.toLowerCase());
    let action = "inserted";
    if (existing) {
      if (existing.item.content_hash === contentHash && existing.item.name === document.name && existing.item.category === document.category) { action = "unchanged"; report.unchanged += 1; }
      else { action = "updated"; report.updated += 1; current[existing.index] = { ...document, id: existing.item.id, created_at: existing.item.created_at || document.created_at }; }
    } else { report.inserted += 1; current.push(document); byId.set(document.id, { item: document, index: current.length - 1 }); bySource.set(relativePath.toLowerCase(), { item: document, index: current.length - 1 }); }
    report.categories[category] = (report.categories[category] || 0) + 1;
    report.confidence[document.content_confidence] = (report.confidence[document.content_confidence] || 0) + 1;
    report.documents.push({ id: existing?.item.id || document.id, source_file: relativePath, name: title, category, action, confidence: document.content_confidence, last_verified: document.last_verified });
  } catch (error) { report.errors.push({ file: path.relative(inputRoot, file).replace(/\\/g, "/"), error: error.message }); }
}

report.completed_at = new Date().toISOString();
report.total_after_import = current.length;
if (!dryRun) {
  await writeFile(dataFile, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(report, null, 2));
