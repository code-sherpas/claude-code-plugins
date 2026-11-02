// How the Claude Code sessions of one project spent their tokens, read from
// the transcripts Claude Code keeps on this machine (~/.claude/projects).
//
//   node tools/session-usage/session-usage.ts --project alexandria \
//     --from 2026-10-19 --to 2026-11-01 \
//     [--standards-dir <checkout of software-development-standards>] \
//     [--projects-dir <dir>] [--json]
//
// See README.md, next to this file, for what each figure means and why.
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

/**
 * Relative weights of each kind of token, from the public API prices with
 * input = 1. Only a proxy: how a subscription's limits count usage is not
 * published.
 */
export const WEIGHTS = { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 } as const;

/** A call whose context is mostly written to the cache again: it was not there. */
const REWRITE_MIN_CONTEXT = 60_000;
const REWRITE_MIN_SHARE = 0.6;
/** A session that read at least this many distinct standards read them all. */
const STANDARDS_LOADED = 20;
const STANDARD_URL = /software-development-standards\/(?:main|refs\/heads\/[^/]+)\/([a-z0-9-]+)\.md/g;

export type Options = {
  projectsDir: string;
  project: string;
  from: string;
  to: string;
  /** The standards' file names (`accessibility.md`, …); empty when unknown. */
  standardNames: ReadonlySet<string>;
};

type Call = {
  file: string;
  session: string;
  subagent: boolean;
  at: number;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  context: number;
  weighted: number;
};

type Transcript = { file: string; session: string; subagent: boolean };

export type ReadOrigin = "standards" | "tmp" | "claude" | "node_modules" | "other";

export type Report = {
  project: string;
  from: string;
  to: string;
  transcripts: number;
  calls: number;
  sessions: number;
  subagents: number;
  tokens: { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number };
  weighted: number;
  share: { input: number; cacheWrite: number; cacheRead: number; output: number; subagents: number; topFiveSessions: number };
  contextPerCall: { median: number; p90: number; max: number };
  firstCallContext: { median: number };
  callsPerSession: { median: number; p90: number; max: number };
  sessionHours: { median: number };
  rewrites: { calls: number; share: number; afterPause: { start: number; under5m: number; from5to60m: number; over60m: number } };
  compactions: number;
  /** null when the standards' names were not given. */
  standardsLoaded: { sessions: number; subagents: number } | null;
  readChars: Record<ReadOrigin, number>;
};

/** Every transcript of the project: sessions, and the subagents each one ran. */
export function transcriptsOf(projectsDir: string, project: string): Transcript[] {
  if (!existsSync(projectsDir)) return [];
  const found: Transcript[] = [];
  for (const folder of readdirSync(projectsDir)) {
    if (!folder.includes(project)) continue;
    const root = join(projectsDir, folder);
    if (!statSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push({ file: join(root, entry.name), session: entry.name.slice(0, -6), subagent: false });
      } else if (entry.isDirectory()) {
        const subagents = join(root, entry.name, "subagents");
        if (!existsSync(subagents)) continue;
        for (const name of readdirSync(subagents)) {
          if (name.endsWith(".jsonl")) found.push({ file: join(subagents, name), session: entry.name, subagent: true });
        }
      }
    }
  }
  return found;
}

/** The standards' file names, from a checkout of software-development-standards. */
export function standardNamesIn(dir: string): Set<string> {
  return new Set(readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md"));
}

export function originOf(path: string, standardNames: ReadonlySet<string>): ReadOrigin {
  // A standard is read wherever it was downloaded to: agents curl them into
  // their scratchpad first, then Read each file.
  if (path.includes("software-development-standards") || standardNames.has(basename(path))) return "standards";
  if (path.includes("/node_modules/")) return "node_modules";
  if (path.startsWith("/tmp/")) return "tmp";
  if (path.includes("/.claude/")) return "claude";
  return "other";
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function analyze({ projectsDir, project, from, to, standardNames }: Options): Promise<Report> {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`) + 86_400_000;
  const inWindow = (at: number) => at >= start && at < end;

  const transcripts = transcriptsOf(projectsDir, project);
  const calls: Call[] = [];
  const seen = new Set<string>();
  const readChars: Record<ReadOrigin, number> = { standards: 0, tmp: 0, claude: 0, node_modules: 0, other: 0 };
  let compactions = 0;
  const loaders = { sessions: new Set<string>(), subagents: new Set<string>() };

  for (const transcript of transcripts) {
    const readPaths = new Map<string, string>();
    const standardsRead = new Set<string>();
    let callsHere = 0;
    const lines = createInterface({ input: createReadStream(transcript.file), crlfDelay: Infinity });
    for await (const line of lines) {
      for (const match of line.matchAll(STANDARD_URL)) {
        if (standardNames.has(`${match[1]}.md`)) standardsRead.add(`${match[1]}.md`);
      }
      if (!line.includes('"usage"') && !line.includes('"tool_result"') && !line.includes("compact_boundary")) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(entry.timestamp ?? "");
      if (!inWindow(at)) continue;
      if (entry.type === "system" && entry.subtype === "compact_boundary") {
        compactions += 1;
        continue;
      }
      const message = entry.message ?? {};
      const content = Array.isArray(message.content) ? message.content : [];
      if (entry.type === "assistant") {
        for (const block of content) {
          if (block?.type !== "tool_use" || block.name !== "Read") continue;
          const path = String(block.input?.file_path ?? "");
          readPaths.set(block.id, path);
          if (standardNames.has(basename(path))) standardsRead.add(basename(path));
        }
        const usage = message.usage;
        const key = entry.requestId ?? message.id;
        if (!usage || !key || seen.has(key)) continue;
        seen.add(key);
        const split = usage.cache_creation;
        const call = {
          file: transcript.file,
          session: transcript.session,
          subagent: transcript.subagent,
          at,
          input: usage.input_tokens ?? 0,
          cacheWrite5m: split ? (split.ephemeral_5m_input_tokens ?? 0) : (usage.cache_creation_input_tokens ?? 0),
          cacheWrite1h: split ? (split.ephemeral_1h_input_tokens ?? 0) : 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          context: 0,
          weighted: 0,
        };
        call.context = call.input + call.cacheWrite5m + call.cacheWrite1h + call.cacheRead;
        call.weighted =
          call.input * WEIGHTS.input +
          call.cacheWrite5m * WEIGHTS.cacheWrite5m +
          call.cacheWrite1h * WEIGHTS.cacheWrite1h +
          call.cacheRead * WEIGHTS.cacheRead +
          call.output * WEIGHTS.output;
        calls.push(call);
        callsHere += 1;
      } else if (entry.type === "user") {
        for (const block of content) {
          if (block?.type !== "tool_result" || !readPaths.has(block.tool_use_id)) continue;
          readChars[originOf(readPaths.get(block.tool_use_id) ?? "", standardNames)] += JSON.stringify(block.content ?? "").length;
        }
      }
    }
    if (callsHere > 0 && standardsRead.size >= STANDARDS_LOADED) {
      (transcript.subagent ? loaders.subagents : loaders.sessions).add(transcript.file);
    }
  }

  return summarize({
    project,
    from,
    to,
    transcripts: transcripts.length,
    calls,
    compactions,
    readChars,
    loaders: standardNames.size > 0 ? loaders : null,
  });
}

function summarize(input: {
  project: string;
  from: string;
  to: string;
  transcripts: number;
  calls: Call[];
  compactions: number;
  readChars: Record<ReadOrigin, number>;
  loaders: { sessions: Set<string>; subagents: Set<string> } | null;
}): Report {
  const { calls } = input;
  const sum = (pick: (call: Call) => number, of: Call[] = calls) => of.reduce((total, call) => total + pick(call), 0);
  const weighted = sum((call) => call.weighted);
  const share = (part: number) => (weighted === 0 ? 0 : part / weighted);

  const bySession = new Map<string, Call[]>();
  const byFile = new Map<string, Call[]>();
  for (const call of calls) {
    if (!call.subagent) bySession.set(call.session, [...(bySession.get(call.session) ?? []), call]);
    byFile.set(call.file, [...(byFile.get(call.file) ?? []), call]);
  }
  const weightBySession = new Map<string, number>();
  for (const call of calls) weightBySession.set(call.session, (weightBySession.get(call.session) ?? 0) + call.weighted);

  const rewrites = { calls: 0, weight: 0, afterPause: { start: 0, under5m: 0, from5to60m: 0, over60m: 0 } };
  for (const fileCalls of byFile.values()) {
    fileCalls.sort((a, b) => a.at - b.at);
    fileCalls.forEach((call, index) => {
      const written = call.cacheWrite5m + call.cacheWrite1h;
      if (call.context <= REWRITE_MIN_CONTEXT || written <= REWRITE_MIN_SHARE * call.context) return;
      rewrites.calls += 1;
      rewrites.weight += call.weighted;
      if (index === 0) return void (rewrites.afterPause.start += 1);
      const pause = call.at - fileCalls[index - 1].at;
      if (pause < 300_000) rewrites.afterPause.under5m += 1;
      else if (pause < 3_600_000) rewrites.afterPause.from5to60m += 1;
      else rewrites.afterPause.over60m += 1;
    });
  }

  const sessions = [...bySession.values()].map((sessionCalls) => sessionCalls.sort((a, b) => a.at - b.at));
  const mainContexts = calls.filter((call) => !call.subagent).map((call) => call.context);
  const callCounts = sessions.map((sessionCalls) => sessionCalls.length);
  const topFive = [...weightBySession.values()].sort((a, b) => b - a).slice(0, 5);

  return {
    project: input.project,
    from: input.from,
    to: input.to,
    transcripts: input.transcripts,
    calls: calls.length,
    sessions: sessions.length,
    subagents: new Set(calls.filter((call) => call.subagent).map((call) => call.file)).size,
    tokens: {
      input: sum((call) => call.input),
      cacheWrite5m: sum((call) => call.cacheWrite5m),
      cacheWrite1h: sum((call) => call.cacheWrite1h),
      cacheRead: sum((call) => call.cacheRead),
      output: sum((call) => call.output),
    },
    weighted,
    share: {
      input: share(sum((call) => call.input * WEIGHTS.input)),
      cacheWrite: share(sum((call) => call.cacheWrite5m * WEIGHTS.cacheWrite5m + call.cacheWrite1h * WEIGHTS.cacheWrite1h)),
      cacheRead: share(sum((call) => call.cacheRead * WEIGHTS.cacheRead)),
      output: share(sum((call) => call.output * WEIGHTS.output)),
      subagents: share(sum((call) => call.weighted, calls.filter((call) => call.subagent))),
      topFiveSessions: share(topFive.reduce((a, b) => a + b, 0)),
    },
    contextPerCall: { median: median(mainContexts), p90: quantile(mainContexts, 0.9), max: Math.max(0, ...mainContexts) },
    firstCallContext: { median: median(sessions.map((sessionCalls) => sessionCalls[0].context)) },
    callsPerSession: { median: median(callCounts), p90: quantile(callCounts, 0.9), max: Math.max(0, ...callCounts) },
    sessionHours: {
      median: median(sessions.map((sessionCalls) => (sessionCalls[sessionCalls.length - 1].at - sessionCalls[0].at) / 3_600_000)),
    },
    rewrites: { calls: rewrites.calls, share: share(rewrites.weight), afterPause: rewrites.afterPause },
    compactions: input.compactions,
    standardsLoaded: input.loaders && { sessions: input.loaders.sessions.size, subagents: input.loaders.subagents.size },
    readChars: input.readChars,
  };
}

export function toMarkdown(report: Report): string {
  const n = (value: number) => Math.round(value).toLocaleString("en-US");
  const m = (value: number) => `${(value / 1e6).toFixed(1)} M`;
  const p = (value: number) => `${Math.round(value * 100)} %`;
  const pauses = report.rewrites.afterPause;
  return [
    `# Session usage: ${report.project}, ${report.from} to ${report.to}`,
    "",
    `${n(report.sessions)} sessions, ${n(report.calls)} model calls, ${n(report.subagents)} subagents, from ${n(report.transcripts)} transcripts.`,
    `Weighted usage: ${m(report.weighted)} (API price ratios, input = 1; a proxy for the subscription limits).`,
    "",
    "| Measure | Value |",
    "| :- | -: |",
    `| Context per call, main sessions: median | ${n(report.contextPerCall.median)} |`,
    `| Context per call, main sessions: p90 | ${n(report.contextPerCall.p90)} |`,
    `| Context per call, main sessions: max | ${n(report.contextPerCall.max)} |`,
    `| Context of a session's first call: median | ${n(report.firstCallContext.median)} |`,
    `| Calls per session: median / p90 / max | ${n(report.callsPerSession.median)} / ${n(report.callsPerSession.p90)} / ${n(report.callsPerSession.max)} |`,
    `| Session length, first to last call: median hours | ${report.sessionHours.median.toFixed(1)} |`,
    `| Share: cache reads / cache writes / output / input | ${p(report.share.cacheRead)} / ${p(report.share.cacheWrite)} / ${p(report.share.output)} / ${p(report.share.input)} |`,
    `| Share: subagents | ${p(report.share.subagents)} |`,
    `| Share: the five costliest sessions | ${p(report.share.topFiveSessions)} |`,
    `| Whole-context rewrites: calls (share) | ${n(report.rewrites.calls)} (${p(report.rewrites.share)}) |`,
    `| Rewrites by the pause before them: start / <5 min / 5-60 min / >60 min | ${pauses.start} / ${pauses.under5m} / ${pauses.from5to60m} / ${pauses.over60m} |`,
    `| Cache written for 5 min / 1 h | ${m(report.tokens.cacheWrite5m)} / ${m(report.tokens.cacheWrite1h)} |`,
    `| Compactions | ${n(report.compactions)} |`,
    `| Read every standard (≥${STANDARDS_LOADED} of them): sessions / subagents | ${
      report.standardsLoaded ? `${n(report.standardsLoaded.sessions)} / ${n(report.standardsLoaded.subagents)}` : "n/a: pass --standards-dir"
    } |`,
    `| Characters read, by origin: standards / /tmp / ~/.claude / node_modules / other | ${(["standards", "tmp", "claude", "node_modules", "other"] as const).map((origin) => m(report.readChars[origin])).join(" / ")} |`,
    "",
  ].join("\n");
}

function parseArguments(argv: string[]): (Options & { json: boolean }) | string {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") json = true;
    else if (["--project", "--from", "--to", "--projects-dir", "--standards-dir"].includes(flag) && index + 1 < argv.length) {
      values.set(flag, argv[++index]);
    }
    else return `unknown argument: ${flag}`;
  }
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const project = values.get("--project");
  const from = values.get("--from");
  const to = values.get("--to");
  if (!project || !from || !to) return "--project, --from and --to are required";
  if (!date.test(from) || !date.test(to)) return "--from and --to are dates, YYYY-MM-DD";
  const standardsDir = values.get("--standards-dir");
  if (standardsDir && !existsSync(standardsDir)) return `--standards-dir ${standardsDir} does not exist`;
  return {
    project,
    from,
    to,
    json,
    projectsDir: values.get("--projects-dir") ?? join(homedir(), ".claude", "projects"),
    standardNames: standardsDir ? standardNamesIn(standardsDir) : new Set(),
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (typeof options === "string") {
    process.stderr.write(
      `${options}\nusage: node ${basename(dirname(process.argv[1]))}/session-usage.ts --project <name> --from YYYY-MM-DD --to YYYY-MM-DD [--standards-dir <dir>] [--projects-dir <dir>] [--json]\n`,
    );
    process.exitCode = 2;
    return;
  }
  const report = await analyze(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : toMarkdown(report));
}

if (import.meta.main) await main();
