import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  knowledgeDocumentChunks,
  listKnowledgeDocuments,
  publishKnowledgeDocument,
  reindexKnowledgeDocument,
  saveKnowledgeDocument,
} from "../knowledge-service.mjs";
import { ingestKnowledgeFile, listKnowledgeImportJobs } from "../knowledge-ingestion.mjs";
import { knowledgeRagStats, searchKnowledgeDocuments } from "../knowledge-rag.mjs";
import { readRequestBody, send } from "../http.mjs";

export async function handleKnowledgeRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/knowledge-documents") {
    send(res, 200, await listKnowledgeDocuments());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/knowledge-documents") {
    send(res, 201, await createKnowledgeDocument(await readRequestBody(req)));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/knowledge-files") {
    send(res, 201, await ingestKnowledgeFile(await readRequestBody(req)));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/knowledge-import-jobs") {
    send(res, 200, await listKnowledgeImportJobs());
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/knowledge-runtime") {
    send(res, 200, await knowledgeRagStats());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/knowledge-search/preview") {
    send(res, 200, await searchKnowledgeDocuments(await readRequestBody(req)));
    return true;
  }

  const documentMatch = url.pathname.match(/^\/api\/knowledge-documents\/([^/]+)$/);
  const publishMatch = url.pathname.match(/^\/api\/knowledge-documents\/([^/]+)\/publish$/);
  const reindexMatch = url.pathname.match(/^\/api\/knowledge-documents\/([^/]+)\/reindex$/);
  const chunksMatch = url.pathname.match(/^\/api\/knowledge-documents\/([^/]+)\/chunks$/);
  if (req.method === "POST" && publishMatch) {
    send(res, 200, await publishKnowledgeDocument(publishMatch[1], await readRequestBody(req)));
    return true;
  }
  if (req.method === "POST" && reindexMatch) {
    send(res, 200, await reindexKnowledgeDocument(reindexMatch[1]));
    return true;
  }
  if (req.method === "GET" && chunksMatch) {
    send(res, 200, await knowledgeDocumentChunks(chunksMatch[1]));
    return true;
  }
  if (req.method === "PUT" && documentMatch) {
    send(res, 200, await saveKnowledgeDocument(documentMatch[1], await readRequestBody(req)));
    return true;
  }
  if (req.method === "DELETE" && documentMatch) {
    send(res, 200, await deleteKnowledgeDocument(documentMatch[1]));
    return true;
  }
  return false;
}
