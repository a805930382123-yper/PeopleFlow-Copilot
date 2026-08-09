import { readJson, writeJson } from "./json-store.mjs";

const secretKey = /(^|_)(token|secret|api_key|password)$/i;

function rejectSecrets(value, path = "config") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (secretKey.test(key) && child) throw new Error(`导入配置禁止包含敏感值：${path}.${key}；请只填写环境变量名`);
    rejectSecrets(child, `${path}.${key}`);
  }
}

export async function exportConfiguration() {
  const [skills, tools, plans, knowledgeDocuments] = await Promise.all([readJson("skills.json"), readJson("tools.json"), readJson("plans.json"), readJson("knowledge_documents.json")]);
  const clean = (rows) => rows.map((row) => { const copy = { ...row }; delete copy.last_test; return copy; });
  return { format: "peopleflow-config", version: 2, exported_at: new Date().toISOString(), skills: clean(skills), tools: clean(tools), plans, knowledge_documents: knowledgeDocuments };
}

export async function importConfiguration(config) {
  if (config?.format !== "peopleflow-config" || ![1, 2].includes(config?.version)) throw new Error("不支持的配置文件格式或版本");
  if (!Array.isArray(config.skills) || !Array.isArray(config.tools) || !Array.isArray(config.plans)) throw new Error("配置必须包含 skills、tools、plans 数组");
  rejectSecrets(config);
  const unique = (rows, label) => {
    const ids = rows.map((item) => item?.id);
    if (ids.some((id) => typeof id !== "string" || !id)) throw new Error(`${label} 存在无效 ID`);
    if (new Set(ids).size !== ids.length) throw new Error(`${label} 存在重复 ID`);
  };
  unique(config.skills, "skills"); unique(config.tools, "tools"); unique(config.plans, "plans");
  if (config.knowledge_documents !== undefined) { if (!Array.isArray(config.knowledge_documents)) throw new Error("knowledge_documents 必须是数组"); unique(config.knowledge_documents, "knowledge_documents"); }
  const writes = [writeJson("skills.json", config.skills), writeJson("tools.json", config.tools), writeJson("plans.json", config.plans)];
  if (config.knowledge_documents) writes.push(writeJson("knowledge_documents.json", config.knowledge_documents));
  await Promise.all(writes);
  return { imported: true, counts: { skills: config.skills.length, tools: config.tools.length, plans: config.plans.length, knowledge_documents: config.knowledge_documents?.length || 0 } };
}
