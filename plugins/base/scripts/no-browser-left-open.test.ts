import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Why this test exists.
//
// The hook is the automated check of «Leave Nothing Running» for browsers: on
// 2026-10-28 `browser_close` left a Chromium window and its Playwright worker
// open on the developer's screen. What it must tell apart is narrow — a
// visible browser THIS session opened, not a headless e2e run and never
// another session's, even one working in the same checkout — and a mistake
// either way is silent: it never fires, or it points an agent at somebody
// else's window. The process table is injected through
// BROWSER_GUARD_PROCESSES, one `pid<TAB>ppid<TAB>session<TAB>command line` per
// line, where the session is the `CLAUDE_CODE_SESSION_ID` in that process's
// environment, or `-` for none.

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "no-browser-left-open.sh");
const STANDARD =
  "https://raw.githubusercontent.com/code-sherpas/software-development-standards/main/leave-nothing-running.md";
const CHROME = "/home/someone/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const MAC_CHROMIUM =
  "/Users/someone/Library/Caches/ms-playwright/chromium-1248/chrome-mac/Chromium.app/Contents/MacOS/Chromium";

const THIS_SESSION = "821b8d62-63eb-4657-a5fc-9b5ecec50eb8";
const ANOTHER_SESSION = "6f7d933c-7253-48f3-87b9-777b429d1987";

/**
 * Two Claude Code sessions in the same checkout, each with a Playwright MCP
 * server and its worker. Playwright gives the browsers it launches a filtered
 * environment, so a browser row carries no session of its own.
 */
const SESSIONS = [
  row(1, 0, "-", "/sbin/init"),
  row(10, 1, "-", "/usr/bin/zsh -l"),
  row(100, 10, "-", "claude --resume abc"),
  row(110, 100, THIS_SESSION, "pnpm exec playwright run-test-mcp-server"),
  row(111, 110, THIS_SESSION, "node playwright/lib/worker"),
  row(200, 10, "-", "claude"),
  row(210, 200, ANOTHER_SESSION, "pnpm exec playwright run-test-mcp-server"),
  row(211, 210, ANOTHER_SESSION, "node playwright/lib/worker"),
];

function row(pid: number, ppid: number, session: string, args: string): string {
  return `${pid}\t${ppid}\t${session}\t${args}`;
}

function runHook(
  processes: string[],
  input: object = { session_id: THIS_SESSION, hook_event_name: "Stop", stop_hook_active: false },
): { status: number | null; output: string } {
  const result = spawnSync("bash", [HOOK], {
    input: JSON.stringify(input),
    env: { ...process.env, BROWSER_GUARD_PROCESSES: [...SESSIONS, ...processes].join("\n") },
    encoding: "utf8",
  });
  return { status: result.status, output: result.stdout };
}

function decisionOf(output: string): {
  decision?: string;
  reason?: string;
  systemMessage?: string;
} {
  return output.trim() === "" ? {} : JSON.parse(output);
}

describe("no-browser-left-open hook", () => {
  it("blocks the end of a turn while a visible browser this session opened is open", () => {
    const { status, output } = runHook([row(41, 111, "-", `${CHROME} --user-data-dir=/tmp/x`)]);
    const { decision, reason = "" } = decisionOf(output);

    assert.equal(status, 0);
    assert.equal(decision, "block");
    assert.match(reason, /PID 41/);
    // The rule lives in the standard: the message names it and links it.
    assert.ok(reason.startsWith("Leave Nothing Running"));
    assert.ok(reason.includes(STANDARD));
    // A decision, not an order: a window still needed stays open, said in the reply.
    assert.match(reason, /If nothing needs it, close it/);
    assert.match(reason, /If you keep it, say in your reply which window and why/);
  });

  for (const [description, processes] of [
    [
      "by a script whose launcher detached from the session's shell",
      [
        row(31, 1, THIS_SESSION, "node ts-node record.ts"),
        row(42, 31, "-", `${CHROME} --no-first-run`),
      ],
    ],
    ["on a Mac", [row(42, 111, "-", `${MAC_CHROMIUM} --no-first-run`)]],
  ] as const) {
    it(`blocks for a browser opened ${description}`, () => {
      const { output } = runHook([...processes]);

      assert.equal(decisionOf(output).decision, "block");
    });
  }

  for (const [description, processes] of [
    ["nothing is open", []],
    ["the browser belongs to another session in the same checkout", [row(43, 211, "-", CHROME)]],
    [
      "the browser was launched by another session inside this one's process tree",
      [row(32, 111, ANOTHER_SESSION, "node other.ts"), row(44, 32, "-", CHROME)],
    ],
    ["no ancestor says which session opened it", [row(45, 1, "-", CHROME)]],
    [
      "the browser is headless, as e2e runs are",
      [row(46, 111, "-", `${CHROME} --headless --no-sandbox`)],
    ],
    ["it is one of the browser's own children", [row(47, 111, "-", `${CHROME} --type=renderer`)]],
    ["it is the crash reporter", [row(48, 111, "-", `${CHROME}_crashpad_handler --monitor-self`)]],
    ["it is not Playwright's", [row(49, 111, "-", "/usr/bin/google-chrome --no-first-run")]],
  ] as const) {
    it(`lets the turn end when ${description}`, () => {
      const { status, output } = runHook([...processes]);

      assert.equal(status, 0);
      assert.equal(output.trim(), "");
    });
  }

  it("only warns the second time, so a browser the agent cannot close never traps the session", () => {
    const { status, output } = runHook([row(50, 111, "-", CHROME)], {
      session_id: THIS_SESSION,
      hook_event_name: "Stop",
      stop_hook_active: true,
    });

    assert.equal(status, 0);
    assert.equal(decisionOf(output).decision, undefined);
    assert.match(decisionOf(output).systemMessage ?? "", /PID 50/);
  });

  it("names every browser this session left open, and none of the others", () => {
    const { output } = runHook([
      row(52, 111, "-", CHROME),
      row(51, 111, "-", CHROME),
      row(53, 211, "-", CHROME),
    ]);

    assert.match(decisionOf(output).reason ?? "", /PID 51, 52\)/);
  });

  it("reads this machine's real process table without failing, on Linux and on macOS", () => {
    // No injected table: `ps`, and `/proc` or `ps -E`, run for real. A session
    // that cannot exist owns no browser, so the turn ends silently.
    const result = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "no-such-session", hook_event_name: "Stop" }),
      env: { ...process.env, BROWSER_GUARD_PROCESSES: "" },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), "");
  });

  it("asks the other session's agent, not this one, about the other session's browser", () => {
    const { output } = runHook([row(54, 211, "-", CHROME)], {
      session_id: ANOTHER_SESSION,
      hook_event_name: "Stop",
      stop_hook_active: false,
    });

    assert.match(decisionOf(output).reason ?? "", /PID 54/);
  });
});
