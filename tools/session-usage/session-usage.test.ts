import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, originOf, sizeOfRead, toMarkdown } from "./session-usage.ts";

// Why this test exists.
//
// The script is how Code Sherpas decides whether a change to how agents work
// made sessions cheaper. Its figures are compared before and after a change,
// so a wrong rule shows up as an improvement or a regression that did not
// happen. Each test writes transcripts in Claude Code's format into a
// temporary projects folder and checks one rule: each model call counts once,
// only calls inside the dates count, the weights, rewrites of the whole
// context and the pause before them, subagents, who read every standard, and
// where what was read came from.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "session-usage.ts");
const STANDARDS = new Set(Array.from({ length: 25 }, (_, index) => `standard-${index}.md`));

let projects: string;

beforeEach(() => {
  projects = mkdtempSync(join(tmpdir(), "session-usage-"));
});

afterEach(() => {
  rmSync(projects, { recursive: true, force: true });
});

type Usage = { input?: number; write5m?: number; write1h?: number; read?: number; output?: number };

/** One model response, as Claude Code writes it to a transcript. */
function call(id: string, at: string, usage: Usage, content: object[] = []): object {
  return {
    type: "assistant",
    timestamp: at,
    requestId: id,
    message: {
      id: `msg-${id}`,
      content,
      usage: {
        input_tokens: usage.input ?? 0,
        cache_creation_input_tokens: (usage.write5m ?? 0) + (usage.write1h ?? 0),
        cache_read_input_tokens: usage.read ?? 0,
        output_tokens: usage.output ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: usage.write5m ?? 0, ephemeral_1h_input_tokens: usage.write1h ?? 0 },
      },
    },
  };
}

function read(id: string, path: string): object {
  return { type: "tool_use", id, name: "Read", input: { file_path: path } };
}

function result(at: string, toolUseId: string, text: string): object {
  return { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] } };
}

/** Writes a transcript: `<project folder>/<session>.jsonl`, or a subagent's under it. */
function transcript(folder: string, session: string, entries: object[], subagent?: string): void {
  const file = subagent
    ? join(projects, folder, session, "subagents", `${subagent}.jsonl`)
    : join(projects, folder, `${session}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function measure(standardNames: ReadonlySet<string> = STANDARDS) {
  return analyze({ projectsDir: projects, project: "myproject", from: "2026-10-19", to: "2026-11-01", standardNames });
}

describe("session-usage", () => {
  it("counts each model call once, though Claude Code writes one line per content block", async () => {
    const same = call("r1", "2026-10-20T10:00:00Z", { read: 1000, output: 10 });
    transcript("-home-me-myproject", "s1", [same, same, same]);

    const report = await measure();

    assert.equal(report.calls, 1);
    assert.equal(report.tokens.cacheRead, 1000);
  });

  it("counts only the calls made between the two dates, both included", async () => {
    transcript("-home-me-myproject", "s1", [
      call("before", "2026-10-18T23:59:59Z", { read: 1 }),
      call("first-day", "2026-10-19T00:00:00Z", { read: 1 }),
      call("last-day", "2026-11-01T23:59:59Z", { read: 1 }),
      call("after", "2026-11-02T00:00:00Z", { read: 1 }),
    ]);

    assert.equal((await measure()).calls, 2);
  });

  it("reads only the project asked for, in every worktree of it", async () => {
    transcript("-home-me-myproject", "s1", [call("a", "2026-10-20T10:00:00Z", { read: 1 })]);
    transcript("-home-me-worktrees-myproject-blenny", "s2", [call("b", "2026-10-20T10:00:00Z", { read: 1 })]);
    transcript("-home-me-otherproject", "s3", [call("c", "2026-10-20T10:00:00Z", { read: 1 })]);

    const report = await measure();

    assert.equal(report.sessions, 2);
    assert.equal(report.calls, 2);
  });

  it("weighs each kind of token by its API price, input = 1", async () => {
    transcript("-home-me-myproject", "s1", [
      call("r1", "2026-10-20T10:00:00Z", { input: 100, write5m: 100, write1h: 100, read: 1000, output: 100 }),
    ]);

    const report = await measure();

    assert.equal(report.weighted, 100 + 125 + 200 + 100 + 500);
    assert.equal(report.share.output, 500 / 1025);
  });

  it("measures each session's context per call, calls and length", async () => {
    transcript("-home-me-myproject", "s1", [
      call("r1", "2026-10-20T10:00:00Z", { write5m: 50_000 }),
      call("r2", "2026-10-20T11:00:00Z", { read: 50_000, write5m: 10_000 }),
      call("r3", "2026-10-20T12:00:00Z", { read: 60_000, input: 2 }),
    ]);

    const report = await measure();

    assert.deepEqual(report.contextPerCall, { median: 60_000, p90: 60_002, max: 60_002 });
    assert.equal(report.firstCallContext.median, 50_000);
    assert.deepEqual(report.callsPerSession, { median: 3, p90: 3, max: 3 });
    assert.equal(report.sessionHours.median, 2);
  });

  it("tells a whole-context rewrite apart, and the pause before it", async () => {
    transcript("-home-me-myproject", "s1", [
      // The session starts: everything is written, no pause before it.
      call("start", "2026-10-20T10:00:00Z", { write5m: 100_000 }),
      // One minute later the cache is there: read, not rewritten.
      call("warm", "2026-10-20T10:01:00Z", { read: 100_000, write5m: 1_000 }),
      // Ten minutes later the 5-minute cache is gone: all of it written again.
      call("cold", "2026-10-20T10:11:00Z", { write5m: 101_000 }),
      // Two hours later, even the 1-hour cache is gone.
      call("colder", "2026-10-20T12:11:00Z", { write1h: 101_000 }),
      // A small context written again is not a costly rewrite.
      call("small", "2026-10-20T15:00:00Z", { write5m: 10_000 }),
    ]);

    const { rewrites } = await measure();

    assert.equal(rewrites.calls, 3);
    assert.deepEqual(rewrites.afterPause, { start: 1, under5m: 0, from5to60m: 1, over60m: 1 });
  });

  it("counts subagents apart, as part of the session that ran them", async () => {
    transcript("-home-me-myproject", "s1", [call("main", "2026-10-20T10:00:00Z", { output: 100 })]);
    transcript("-home-me-myproject", "s1", [call("sub", "2026-10-20T10:05:00Z", { output: 300 })], "agent-a");

    const report = await measure();

    assert.equal(report.sessions, 1);
    assert.equal(report.subagents, 1);
    assert.equal(report.share.subagents, 0.75);
    assert.equal(report.share.topFiveSessions, 1);
  });

  it("finds who read every standard, wherever they downloaded them to", async () => {
    const downloaded = Array.from({ length: 20 }, (_, index) => read(`t${index}`, `/tmp/scratch/std/standard-${index}.md`));
    transcript("-home-me-myproject", "s1", [call("main", "2026-10-20T10:00:00Z", { read: 1 }, downloaded.slice(0, 19))]);
    transcript("-home-me-myproject", "s1", [call("sub", "2026-10-20T10:05:00Z", { read: 1 }, downloaded)], "agent-a");

    const report = await measure();

    // The session read 19, one short of the threshold; its subagent read 20.
    assert.deepEqual(report.standardsLoaded, { sessions: 0, subagents: 1 });
  });

  it("says nothing about the standards when it does not know their names", async () => {
    transcript("-home-me-myproject", "s1", [call("main", "2026-10-20T10:00:00Z", { read: 1 })]);

    const report = await measure(new Set());

    assert.equal(report.standardsLoaded, null);
    assert.match(toMarkdown(report), /n\/a: pass --standards-dir/);
  });

  it("sizes what Read returned by where it came from", async () => {
    transcript("-home-me-myproject", "s1", [
      call("r1", "2026-10-20T10:00:00Z", { read: 1 }, [
        read("a", "/tmp/claude/scratch/std/standard-3.md"),
        read("b", "/tmp/claude/scratch/dump.log"),
        read("c", "/home/me/myproject/src/index.ts"),
      ]),
      result("2026-10-20T10:00:01Z", "a", "x".repeat(98)),
      result("2026-10-20T10:00:01Z", "b", "y".repeat(48)),
      result("2026-10-20T10:00:01Z", "c", "z".repeat(8)),
    ]);

    const { readChars, readImages } = await measure();

    assert.deepEqual(readChars, { standards: 98, tmp: 48, claude: 0, node_modules: 0, other: 8 });
    assert.deepEqual(readImages, { standards: 0, tmp: 0, claude: 0, node_modules: 0, other: 0 });
  });

  it("counts an image read as one image, never by its base64", () => {
    const screenshot = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(400_000) } },
      { type: "text", text: "caption" },
    ];
    assert.deepEqual(sizeOfRead(screenshot), { chars: 7, images: 1 });
    assert.deepEqual(sizeOfRead("plain text"), { chars: 10, images: 0 });
  });

  it("files a read under the standards by its name, then by where it lives", () => {
    assert.equal(originOf("/tmp/x/standard-1.md", STANDARDS), "standards");
    assert.equal(originOf("/home/me/software-development-standards/README.md", STANDARDS), "standards");
    assert.equal(originOf("/home/me/repo/node_modules/a/index.js", STANDARDS), "node_modules");
    assert.equal(originOf("/home/me/.claude/projects/x.jsonl", STANDARDS), "claude");
    assert.equal(originOf("/tmp/dump.log", STANDARDS), "tmp");
    assert.equal(originOf("/home/me/repo/README.md", STANDARDS), "other");
  });

  it("counts the compactions inside the dates", async () => {
    transcript("-home-me-myproject", "s1", [
      { type: "system", subtype: "compact_boundary", timestamp: "2026-10-20T10:00:00Z" },
      { type: "system", subtype: "compact_boundary", timestamp: "2026-10-01T10:00:00Z" },
    ]);

    assert.equal((await measure()).compactions, 1);
  });

  it("runs from the command line, and refuses to run without a project and dates", () => {
    transcript("-home-me-myproject", "s1", [call("r1", "2026-10-20T10:00:00Z", { read: 5 })]);
    const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

    const markdown = run("--project", "myproject", "--from", "2026-10-19", "--to", "2026-11-01", "--projects-dir", projects);
    const json = run("--project", "myproject", "--from", "2026-10-19", "--to", "2026-11-01", "--projects-dir", projects, "--json");
    const missing = run("--project", "myproject");

    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /^# Session usage: myproject, 2026-10-19 to 2026-11-01/);
    assert.equal(JSON.parse(json.stdout).calls, 1);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--project, --from and --to are required/);
  });
});
