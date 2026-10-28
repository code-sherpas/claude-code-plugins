import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Why this test exists.
//
// The skills in `base` are not written here: they are code-sherpas/agent-skills,
// their single source of truth, pinned as a submodule that Dependabot moves
// and the merge queue merges with nobody reviewing it. This is the gate that
// stands in for the reviewer. Every skill keeps to the Agent Skills
// specification (https://agentskills.io/specification), so it also loads in
// any other agent that follows it, and the six fields it defines are the
// only ones: claude.ai uploads and the Skills API fail on anything else.

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "agent-skills", "skills");
const ALLOWED_FIELDS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];

function frontmatterOf(skill: string): Map<string, string> {
  const text = readFileSync(join(SKILLS, skill, "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${skill}/SKILL.md starts with a YAML frontmatter`);
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2]);
  }
  return fields;
}

describe("the agent skills base ships", () => {
  const skills = existsSync(SKILLS)
    ? readdirSync(SKILLS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];

  it("come from the agent-skills submodule, checked out", () => {
    assert.ok(skills.length > 0, `no skills under ${SKILLS}: is the submodule checked out?`);
  });

  for (const skill of skills) {
    it(`${skill} keeps to the Agent Skills specification`, () => {
      const fields = frontmatterOf(skill);
      const name = fields.get("name") ?? "";
      const description = fields.get("description") ?? "";

      assert.deepEqual(
        [...fields.keys()].filter((field) => !ALLOWED_FIELDS.includes(field)),
        [],
        "only the fields the specification defines",
      );
      assert.equal(name, skill, "name matches the directory");
      assert.match(name, /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/, "name is lowercase letters, digits and single hyphens");
      assert.ok(description.length >= 1 && description.length <= 1024, "description has 1 to 1024 characters");
    });
  }
});
