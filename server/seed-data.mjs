import accessPolicies from "../data/access_policies.json" with { type: "json" };
import contacts from "../data/contacts.json" with { type: "json" };
import employees from "../data/employees.json" with { type: "json" };
import evaluationCases from "../data/evaluation_cases.json" with { type: "json" };
import badCaseEvaluationCases from "../data/bad_case_evaluation_cases.json" with { type: "json" };
import knowledgeChunks from "../data/knowledge_chunks.json" with { type: "json" };
import knowledgeDocuments from "../data/knowledge_documents.json" with { type: "json" };
import llmConfig from "../data/llm_config.json" with { type: "json" };
import onboardingMaterials from "../data/onboarding_materials.json" with { type: "json" };
import onboardingTasks from "../data/onboarding_tasks.json" with { type: "json" };
import plannerVersions from "../data/planner_versions.json" with { type: "json" };
import plans from "../data/plans.json" with { type: "json" };
import policies from "../data/policies.json" with { type: "json" };
import skills from "../data/skills.json" with { type: "json" };
import tokenMonitorConfig from "../data/token_monitor_config.json" with { type: "json" };
import tools from "../data/tools.json" with { type: "json" };
import trainings from "../data/trainings.json" with { type: "json" };

const EMPTY_ARRAY_FILES = [
  "conversations.json",
  "conversation_feedback.json",
  "coze_sessions.json",
  "evaluation_case_runs.json",
  "evaluation_runs.json",
  "execution_logs.json",
  "handoffs.json",
  "knowledge_import_jobs.json",
  "security_events.json",
  "skill_versions.json",
  "tool_test_logs.json",
  "tool_versions.json",
];

const seeds = {
  "access_policies.json": accessPolicies,
  "contacts.json": contacts,
  "employees.json": employees,
  "evaluation_cases.json": evaluationCases,
  "bad_case_evaluation_cases.json": badCaseEvaluationCases,
  "knowledge_chunks.json": knowledgeChunks,
  "knowledge_documents.json": knowledgeDocuments,
  "llm_config.json": llmConfig,
  "onboarding_materials.json": onboardingMaterials,
  "onboarding_tasks.json": onboardingTasks,
  "planner_versions.json": plannerVersions,
  "plans.json": plans,
  "policies.json": policies,
  "skills.json": skills,
  "token_monitor_config.json": tokenMonitorConfig,
  "tools.json": tools,
  "trainings.json": trainings,
  ...Object.fromEntries(EMPTY_ARRAY_FILES.map((name) => [name, []])),
};

export function seedFor(name) {
  return Object.prototype.hasOwnProperty.call(seeds, name) ? structuredClone(seeds[name]) : undefined;
}
