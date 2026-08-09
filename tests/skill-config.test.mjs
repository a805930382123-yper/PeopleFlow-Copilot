import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("六个最新 Skill 均包含来源、版本和新版输出约束", async () => {
  const skills = JSON.parse(await readFile(new URL("../data/skills.json", import.meta.url), "utf8"));
  assert.equal(skills.length, 6);
  assert.deepEqual(skills.map((skill) => skill.id), ["question_structuring", "task_decision", "process_explanation", "policy_qa", "reply_generation", "risk_review"]);
  assert.ok(skills.every((skill) => skill.version === "2.0.0" && /_Skill\.md$/.test(skill.source_document)));
  assert.match(skills.find((skill) => skill.id === "question_structuring").prompt, /answerability/);
  assert.ok("recommended_actions" in skills.find((skill) => skill.id === "task_decision").output_example);
  assert.ok("materials_or_information_needed" in skills.find((skill) => skill.id === "process_explanation").output_example);
  assert.ok("evidence" in skills.find((skill) => skill.id === "policy_qa").output_example);
  assert.ok("requires_risk_review" in skills.find((skill) => skill.id === "reply_generation").output_example);
  assert.ok("safe_reply" in skills.find((skill) => skill.id === "risk_review").output_example);
});
