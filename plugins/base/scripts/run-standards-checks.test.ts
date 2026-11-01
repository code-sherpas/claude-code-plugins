import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Why this test exists.
//
// The checks of the standards live in code-sherpas/software-development-
// standards, next to the standard each one backs. This runner is all the
// plugin keeps: it reads checks/checks.tsv from that repository's `main`,
// downloads the scripts listed for the event and runs them. It also decides
// what a finding does to the agent: it stops the turn once, and after that
// it only warns. A mistake here is silent or traps people. Silent means every
// check stops running and nothing says so. Trapped means a session cannot end
// its turn. Each test serves a fake standards repository from a `file://`
// URL (STANDARDS_BASE_URL) and keeps the downloaded copies in a temporary
// directory (STANDARDS_CHECKS_CACHE).

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "run-standards-checks.sh");
const SESSION = "821b8d62-63eb-4657-a5fc-9b5ecec50eb8";

let workspace: string;
let repository: string;
let cache: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "standards-checks-"));
  repository = join(workspace, "standards");
  cache = join(workspace, "cache");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** The standards repository as `main` serves it: path → content. */
function publish(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), content);
  }
}

function manifest(...lines: string[]): string {
  return ["# event\tstandard\tscript", ...lines, ""].join("\n");
}

/** A check that reports `message` every time it runs. */
function reporting(message: string): string {
  return `cat > /dev/null\nprintf '%s\\n' ${JSON.stringify(message)}\n`;
}

const SILENT = "cat > /dev/null\n";

function run(
  event: string,
  { stopHookActive = false, reachable = true } = {},
): { status: number | null; answer: { decision?: string; reason?: string; systemMessage?: string } } {
  const result = spawnSync("bash", [RUNNER, event], {
    input: JSON.stringify({ session_id: SESSION, hook_event_name: event, stop_hook_active: stopHookActive }),
    env: {
      ...process.env,
      STANDARDS_BASE_URL: pathToFileURL(reachable ? repository : join(workspace, "unreachable")).href,
      STANDARDS_CHECKS_CACHE: cache,
    },
    encoding: "utf8",
  });
  assert.equal(result.stderr, "");
  return { status: result.status, answer: result.stdout.trim() === "" ? {} : JSON.parse(result.stdout) };
}

describe("run-standards-checks hook", () => {
  it("stops the turn once with what a check of the event found", () => {
    publish({
      "checks/checks.tsv": manifest("Stop\tleave-nothing-running.md\tchecks/leave-nothing-running/browser.sh"),
      "checks/leave-nothing-running/browser.sh": reporting("Leave Nothing Running (url): PID 41 is open."),
    });

    const { status, answer } = run("Stop");

    assert.equal(status, 0);
    assert.equal(answer.decision, "block");
    assert.match(answer.reason ?? "", /^Leave Nothing Running \(url\): PID 41 is open\.\n\nThis will not stop the turn again\.$/);
  });

  it("only warns once the turn already went on because of it, so it never traps the session", () => {
    publish({
      "checks/checks.tsv": manifest("Stop\ta.md\tchecks/a/check.sh"),
      "checks/a/check.sh": reporting("A (url): still there."),
    });

    const { answer } = run("Stop", { stopHookActive: true });

    assert.equal(answer.decision, undefined);
    assert.equal(answer.systemMessage, "A (url): still there.");
  });

  it("gives a check the hook input on stdin", () => {
    publish({
      "checks/checks.tsv": manifest("Stop\ta.md\tchecks/a/check.sh"),
      "checks/a/check.sh": `sed -n 's/.*"session_id":"\\([^"]*\\)".*/session \\1/p'\n`,
    });

    assert.match(run("Stop").answer.reason ?? "", new RegExp(`^session ${SESSION}`));
  });

  it("runs only the checks listed for its event, each once", () => {
    publish({
      "checks/checks.tsv": manifest(
        "SubagentStop\ta.md\tchecks/a/sub.sh",
        "Stop\ta.md\tchecks/a/one.sh",
        "Stop\tb.md\tchecks/b/two.sh",
        "Stop\ta.md\tchecks/a/one.sh",
      ),
      "checks/a/sub.sh": reporting("from sub"),
      "checks/a/one.sh": reporting("from one"),
      "checks/b/two.sh": reporting("from two"),
    });

    assert.equal(run("Stop").answer.reason, "from one\n\nfrom two\n\nThis will not stop the turn again.");
    assert.match(run("SubagentStop").answer.reason ?? "", /^from sub\n/);
  });

  it("lets the turn end in silence when no check finds anything", () => {
    publish({
      "checks/checks.tsv": manifest("Stop\ta.md\tchecks/a/check.sh"),
      "checks/a/check.sh": SILENT,
    });

    assert.deepEqual(run("Stop"), { status: 0, answer: {} });
  });

  it("uses the last copy it downloaded when the repository cannot be reached", () => {
    publish({
      "checks/checks.tsv": manifest("Stop\ta.md\tchecks/a/check.sh"),
      "checks/a/check.sh": reporting("found offline"),
    });
    run("Stop");

    const { answer } = run("Stop", { reachable: false });

    assert.equal(answer.decision, "block");
    assert.match(answer.reason ?? "", /^found offline/);
    assert.equal(answer.systemMessage, undefined);
  });

  it("runs what main serves now, not the copy it kept", () => {
    publish({
      "checks/checks.tsv": manifest("Stop\ta.md\tchecks/a/check.sh"),
      "checks/a/check.sh": reporting("old rule"),
    });
    run("Stop");
    publish({ "checks/a/check.sh": SILENT });

    assert.deepEqual(run("Stop").answer, {});
  });

  it("only warns, and never stops the turn, when it has no copy and cannot download one", () => {
    const { status, answer } = run("Stop", { reachable: false });

    assert.equal(status, 0);
    assert.equal(answer.decision, undefined);
    assert.match(answer.systemMessage ?? "", /checks\/checks\.tsv could not be downloaded .* no check ran/);
  });

  it("reports a check that fails instead of stopping the turn for it, and still runs the others", () => {
    publish({
      "checks/checks.tsv": manifest("Stop\ta.md\tchecks/a/broken.sh", "Stop\tb.md\tchecks/b/check.sh"),
      "checks/a/broken.sh": "cat > /dev/null\nexit 3\n",
      "checks/b/check.sh": reporting("B found it"),
    });

    const { answer } = run("Stop");

    assert.equal(answer.decision, "block");
    assert.match(answer.reason ?? "", /^B found it/);
    assert.match(answer.systemMessage ?? "", /checks\/a\/broken\.sh \(a\.md\) failed with exit status 3/);
  });

  for (const script of ["../outside.sh", "/etc/profile", "checks/a/../../outside.sh", "checks/a/check.py"]) {
    it(`never fetches or runs a path outside a standard's checks folder: ${script}`, () => {
      publish({
        "checks/checks.tsv": manifest(`Stop\ta.md\t${script}`),
        "outside.sh": reporting("ran outside"),
      });

      const { answer } = run("Stop");

      assert.equal(answer.decision, undefined);
      assert.match(answer.systemMessage ?? "", /is not a check script path; it did not run/);
    });
  }

  it("keeps quotes, backslashes and tabs from a check's message valid JSON", () => {
    publish({
      "checks/checks.tsv": manifest("Stop\ta.md\tchecks/a/check.sh"),
      "checks/a/check.sh": `cat > /dev/null\nprintf 'say "hi" \\\\ there\\tnow\\n'\n`,
    });

    assert.match(run("Stop").answer.reason ?? "", /^say "hi" \\ there now\n/);
  });
});
