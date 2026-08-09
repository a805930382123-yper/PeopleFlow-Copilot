import path from "node:path";

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".pptx", ".docx", ".md", ".txt", ".json"]);

function decodeXml(value = "") {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function textRuns(xml = "") {
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean);
}

function markdownSegments(text = "") {
  const lines = text.replace(/\r/g, "").split("\n");
  const segments = [];
  let title = "正文";
  let buffer = [];
  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) segments.push({ title, content, page: null, slide: null });
    buffer = [];
  };
  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) { flush(); title = heading[1].trim(); }
    else buffer.push(line);
  }
  flush();
  return segments.length ? segments : [{ title: "正文", content: text.trim(), page: null, slide: null }];
}

async function parsePdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true });
  const pdf = await task.promise;
  const segments = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = [];
    let current = "";
    for (const item of content.items || []) {
      if (!("str" in item)) continue;
      current += `${item.str || ""}${item.hasEOL ? "\n" : " "}`;
      if (item.hasEOL) { if (current.trim()) lines.push(current.trim()); current = ""; }
    }
    if (current.trim()) lines.push(current.trim());
    const text = lines.join("\n").trim();
    if (text) segments.push({ title: `第 ${pageNumber} 页`, content: text, page: pageNumber, slide: null });
  }
  const warnings = [];
  if (!segments.length) warnings.push("PDF 未提取到可搜索文本，可能是扫描件；请先进行 OCR 后再发布。");
  return { segments, warnings, parser: "pdfjs" };
}

async function parseDocx(buffer) {
  const mammothModule = await import("mammoth");
  const mammoth = mammothModule.default || mammothModule;
  const result = await mammoth.extractRawText({ buffer });
  const text = String(result.value || "").trim();
  return {
    segments: markdownSegments(text),
    warnings: (result.messages || []).map((item) => String(item.message || item)).slice(0, 20),
    parser: "mammoth",
  };
}

async function parsePptx(buffer) {
  const JSZipModule = await import("jszip");
  const JSZip = JSZipModule.default || JSZipModule;
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1]) - Number(b.match(/slide(\d+)/i)?.[1]));
  const segments = [];
  for (const name of slideFiles) {
    const slide = Number(name.match(/slide(\d+)/i)?.[1]);
    const xml = await zip.file(name)?.async("string");
    const notesName = `ppt/notesSlides/notesSlide${slide}.xml`;
    const notesXml = zip.file(notesName) ? await zip.file(notesName).async("string") : "";
    const runs = [...textRuns(xml), ...textRuns(notesXml)];
    const content = runs.join("\n").trim();
    if (content) segments.push({ title: runs[0] || `第 ${slide} 页幻灯片`, content, page: null, slide });
  }
  return {
    segments,
    warnings: segments.length ? [] : ["PPTX 未提取到文本；请确认内容不是仅由图片组成。"],
    parser: "pptx-xml",
  };
}

export function supportedKnowledgeFile(filename = "") {
  return SUPPORTED_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function knowledgeSourceType(filename = "") {
  return ({ ".pdf": "PDF", ".pptx": "PPTX", ".docx": "DOCX", ".md": "Markdown", ".txt": "Text", ".json": "JSON" })[path.extname(filename).toLowerCase()] || "Unknown";
}

export async function parseKnowledgeFile({ filename, buffer }) {
  const extension = path.extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error("仅支持 PDF、PPTX、DOCX、Markdown、TXT 和 JSON 文件");
  let result;
  if (extension === ".pdf") result = await parsePdf(buffer);
  else if (extension === ".pptx") result = await parsePptx(buffer);
  else if (extension === ".docx") result = await parseDocx(buffer);
  else {
    let text = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
    if (extension === ".json") {
      try {
        const parsed = JSON.parse(text);
        text = typeof parsed === "string" ? parsed : String(parsed.content || JSON.stringify(parsed, null, 2));
      } catch { /* 保留原始文本，交由管理员复核。 */ }
    }
    result = { segments: markdownSegments(text), warnings: [], parser: extension.slice(1) || "text" };
  }
  const text = result.segments.map((item) => item.content).join("\n\n").trim();
  return {
    text,
    segments: result.segments,
    warnings: result.warnings,
    parser: result.parser,
    source_type: knowledgeSourceType(filename),
    requires_ocr: !text && extension === ".pdf",
  };
}
