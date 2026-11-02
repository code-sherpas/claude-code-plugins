import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Why this test exists.
//
// Every agent and sub-agent has to read the standards index before working;
// this hook is what makes that hold instead of trusting an instruction. Its
// mistakes are costly in both directions. If it lets an agent through
// unread, the rule is gone without a trace. If it refuses the wrong thing —
// the Read of the index itself, the tool a sub-agent hands its result back
// with, a session with no index to read — it traps the agent. And an agent is
// the session's or a sub-agent: one's reading must never count for another.
// Each test serves a fake standards repository from a `file://` URL
// (STANDARDS_BASE_URL) and keeps the copy and the records in a temporary
// directory (STANDARDS_INDEX_DIR).

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "require-standards-index.sh");
const SESSION = "821b8d62-63eb-4657-a5fc-9b5ecec50eb8";
const SUBAGENT = "a81724e32609646bf";
const INDEX_TEXT = Array.from({ length: 40 }, (_, line) => `line ${line + 1}`).join("\n") + "\n";

let workspace: string;
let repository: string;
let state: string;
let index: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "standards-index-"));
  repository = join(workspace, "standards");
  state = join(workspace, "state");
  index = join(state, "README.md");
  mkdirSync(repository);
  writeFileSync(join(repository, "README.md"), INDEX_TEXT);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

type Answer = {
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

function hook(event: string, input: object, { reachable = true } = {}): Answer {
  const result = spawnSync("bash", [HOOK, event], {
    input: JSON.stringify({ session_id: SESSION, hook_event_name: event, ...input }),
    env: {
      ...process.env,
      STANDARDS_BASE_URL: pathToFileURL(reachable ? repository : join(workspace, "unreachable")).href,
      STANDARDS_INDEX_DIR: state,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout.trim() === "" ? {} : JSON.parse(result.stdout);
}

const asSubagent = { agent_id: SUBAGENT, agent_type: "base:increment-builder" };
const bash = (who: object = {}) => hook("PreToolUse", { ...who, tool_name: "Bash", tool_input: { command: "ls" } });
const readIndex = (who: object = {}, extra: object = {}) =>
  hook("PostToolUse", { ...who, tool_name: "Read", tool_input: { file_path: index, ...extra }, tool_response: {} });
const refused = (answer: Answer) => answer.hookSpecificOutput?.permissionDecision === "deny";

describe("require-standards-index hook", () => {
  it("downloads the index at the start of a session and tells its agent to read it, and where", () => {
    const answer = hook("SessionStart", { source: "startup" });

    assert.equal(answer.hookSpecificOutput?.hookEventName, "SessionStart");
    assert.ok(answer.hookSpecificOutput?.additionalContext?.includes(`read the Code Sherpas software development standards index in full`));
    assert.ok(answer.hookSpecificOutput?.additionalContext?.includes(index));
    assert.ok(existsSync(index));
  });

  it("tells each sub-agent on its own start, since the session's context does not reach it", () => {
    const answer = hook("SubagentStart", asSubagent);

    assert.equal(answer.hookSpecificOutput?.hookEventName, "SubagentStart");
    assert.ok(answer.hookSpecificOutput?.additionalContext?.includes(index));
  });

  it("refuses every other tool until the index is read, and lets the Read of the index through", () => {
    hook("SessionStart", { source: "startup" });

    const before = bash();
    const theRead = hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: index } });

    assert.ok(refused(before));
    assert.ok(before.hookSpecificOutput?.permissionDecisionReason?.includes(index));
    assert.deepEqual(theRead, {});
  });

  it("lets everything through once the index was read in full", () => {
    hook("SessionStart", { source: "startup" });
    readIndex();

    assert.deepEqual(bash(), {});
  });

  it("does not count a read that left part of the index out", () => {
    hook("SessionStart", { source: "startup" });
    readIndex({}, { limit: 10 });
    readIndex({}, { offset: 20 });

    assert.ok(refused(bash()));
  });

  it("counts a read whose limit covers the whole index", () => {
    hook("SessionStart", { source: "startup" });
    readIndex({}, { offset: 1, limit: 2000 });

    assert.deepEqual(bash(), {});
  });

  it("never counts one agent's reading for another", () => {
    hook("SessionStart", { source: "startup" });
    hook("SubagentStart", asSubagent);
    readIndex();

    assert.deepEqual(bash(), {});
    assert.ok(refused(bash(asSubagent)));

    readIndex(asSubagent);

    assert.deepEqual(bash(asSubagent), {});
  });

  it("lets a sub-agent hand its result back, even unread", () => {
    hook("SubagentStart", asSubagent);

    assert.deepEqual(hook("PreToolUse", { ...asSubagent, tool_name: "SubagentHandback", tool_input: {} }), {});
  });

  it("asks for it again after a /clear or a compaction", () => {
    hook("SessionStart", { source: "startup" });
    readIndex();
    hook("SessionStart", { source: "compact" });

    assert.ok(refused(bash()));
  });

  it("uses the last copy it downloaded when the repository cannot be reached", () => {
    hook("SessionStart", { source: "startup" });
    const answer = hook("SessionStart", { source: "clear" }, { reachable: false });

    assert.ok(answer.hookSpecificOutput?.additionalContext?.includes(index));
    assert.ok(refused(bash()));
  });

  it("refuses nothing when there is no index at all to read, and says so", () => {
    const answer = hook("SessionStart", { source: "startup" }, { reachable: false });

    assert.match(answer.hookSpecificOutput?.additionalContext ?? "", /could not be downloaded .* not required this time/);
    assert.deepEqual(bash(), {});
  });

  it("refuses a session that started before the hook existed, telling it what to read", () => {
    hook("SessionStart", { source: "startup" });
    const elsewhere = { session_id: "f0f0f0f0-0000-4000-8000-000000000000" };

    const answer = hook("PreToolUse", { ...elsewhere, tool_name: "Bash", tool_input: { command: "ls" } });

    assert.ok(refused(answer));
    assert.ok(answer.hookSpecificOutput?.permissionDecisionReason?.includes(index));
  });

  it("removes the records of sessions over a week old, and keeps the recent ones", () => {
    const old = join(state, "read", "old-session", "main");
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, "");
    const eightDaysAgo = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    hook("SessionStart", { source: "startup" });
    readIndex();

    hook("SubagentStart", asSubagent);

    assert.equal(existsSync(old), false);
    assert.equal(existsSync(dirname(old)), false);
    assert.ok(existsSync(join(state, "read", SESSION, "main")));
  });

  it("ignores an id that would escape its directory", () => {
    assert.deepEqual(
      hook("PreToolUse", { session_id: "../../etc", tool_name: "Bash", tool_input: { command: "ls" } }),
      {},
    );
  });
});
