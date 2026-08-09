import { readJson, updateRecord } from "./json-store.mjs";
import { getVersion, listVersions, nextPatchVersion, snapshotVersion, textDiff } from "./versioning.mjs";

const VERSION_FILE = "skill_versions.json";
const CONFIG_KEYS = new Set(["name", "description", "prompt", "enabled", "model", "model_strategy", "temperature", "max_tokens", "dependent_tools", "output_example"]);

export const listSkills = () => readJson("skills.json");

export async function getSkill(id, requireEnabled = true) {
  const skill = (await listSkills()).find((item) => item.id === id);
  if (!skill) throw Object.assign(new Error(`Skill 不存在：${id}`), { code: "SKILL_NOT_FOUND", status: 404 });
  if (requireEnabled && !skill.enabled) throw Object.assign(new Error(`Skill 已禁用，Executor 拒绝执行：${skill.name}`), { code: "SKILL_DISABLED", status: 409 });
  return skill;
}

async function validateSkill(id, candidate) {
  if (!candidate.name?.trim()) throw Object.assign(new Error("Skill 名称不能为空"), { code: "SKILL_NAME_REQUIRED" });
  if (!candidate.prompt?.trim()) throw Object.assign(new Error("Skill Prompt 不能为空"), { code: "SKILL_PROMPT_REQUIRED" });
  const temperature = Number(candidate.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw Object.assign(new Error("temperature 必须在 0 到 2 之间"), { code: "INVALID_TEMPERATURE" });
  const maxTokens = Number(candidate.max_tokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 32 || maxTokens > 32768) throw Object.assign(new Error("Token 上限必须是 32 到 32768 的整数"), { code: "INVALID_MAX_TOKENS" });
  if (!['global', 'skill'].includes(candidate.model_strategy || "global")) throw Object.assign(new Error("模型策略只能是 global 或 skill"), { code: "INVALID_MODEL_STRATEGY" });
  if (candidate.model_strategy === "skill" && !candidate.model?.trim()) throw Object.assign(new Error("使用 Skill 独立模型时必须填写模型名称"), { code: "SKILL_MODEL_REQUIRED" });
  const tools = await readJson("tools.json");
  const missing = (candidate.dependent_tools || []).filter((toolId) => !tools.some((tool) => tool.id === toolId));
  if (missing.length) throw Object.assign(new Error(`依赖 Tool 不存在：${missing.join("、")}`), { code: "SKILL_TOOL_NOT_FOUND", details: { missing } });
  return { ...candidate, id, name: candidate.name.trim(), description: String(candidate.description || "").trim(), prompt: candidate.prompt.trim(), temperature, max_tokens: maxTokens, model_strategy: candidate.model_strategy || "global", dependent_tools: [...new Set(candidate.dependent_tools || [])] };
}

export async function saveSkill(id, patch, options = {}) {
  const current = await getSkill(id, false);
  const cleanPatch = { ...patch };
  const changeNote = cleanPatch.change_note || cleanPatch.changeNote || options.changeNote || "更新 Skill 配置";
  delete cleanPatch.id;
  delete cleanPatch.change_note;
  delete cleanPatch.changeNote;
  const configurationChanged = Object.keys(cleanPatch).some((key) => CONFIG_KEYS.has(key));
  const candidate = await validateSkill(id, { ...current, ...cleanPatch });
  if (configurationChanged && options.snapshot !== false) await snapshotVersion(VERSION_FILE, id, current, changeNote, options.source || "management");
  const next = {
    ...candidate,
    version: configurationChanged ? nextPatchVersion(current.version || "1.0.0") : current.version || "1.0.0",
    updated_at: new Date().toISOString(),
  };
  return updateRecord("skills.json", id, next);
}

export const toggleSkill = (id, enabled, changeNote) => saveSkill(id, { enabled: Boolean(enabled), change_note: changeNote || `${enabled ? "启用" : "禁用"} Skill` });

export async function skillVersions(id) {
  const current = await getSkill(id, false);
  const versions = await listVersions(VERSION_FILE, id);
  return versions.map((item) => ({ ...item, diff: textDiff(item.content?.prompt, current.prompt) }));
}

export async function skillVersion(id, versionId) {
  const current = await getSkill(id, false);
  const version = await getVersion(VERSION_FILE, id, versionId);
  return { ...version, diff: textDiff(version.content?.prompt, current.prompt) };
}

export async function restoreSkillVersion(id, versionId, changeNote) {
  const current = await getSkill(id, false);
  const historical = await getVersion(VERSION_FILE, id, versionId);
  await snapshotVersion(VERSION_FILE, id, current, changeNote || `恢复前快照：${current.version}`, "restore");
  const restored = await validateSkill(id, { ...historical.content, id, version: nextPatchVersion(current.version || "1.0.0") });
  return updateRecord("skills.json", id, { ...restored, version: nextPatchVersion(current.version || "1.0.0"), updated_at: new Date().toISOString() });
}
