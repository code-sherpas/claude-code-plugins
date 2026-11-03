# Session usage

How the Claude Code sessions of one project spent their tokens. It reads the transcripts Claude Code keeps on this machine, under `~/.claude/projects`, and is meant for comparing **before and after** a change to how agents work: the same measure over a period before the change and a period of the same length after it.

```bash
node tools/session-usage/session-usage.ts \
  --project alexandria \
  --from 2026-10-19 --to 2026-11-01 \
  --standards-dir ~/code-sherpas/software-development-standards
```

| Option | |
| :- | :- |
| `--project` | Part of the project folder's name. Every folder that contains it counts, so `alexandria` takes the main checkout and every worktree of `alexandria-web-application`. |
| `--from`, `--to` | Dates, both included (UTC). A call counts if it was **made** between them, whatever the session's start or its file's date. |
| `--standards-dir` | A checkout of [software-development-standards](https://github.com/code-sherpas/software-development-standards): the standards' file names come from it. Without it, the figures about the standards say `n/a`. |
| `--projects-dir` | Where the transcripts are, if not `~/.claude/projects`. |
| `--json` | The whole report as JSON, rather than a Markdown table. |

Node 24 or later runs it as is.

## What it measures

**Each model call counts once.** Claude Code writes one transcript line per block of a response (text, thinking, each tool call), and each one repeats the response's usage. The script counts a response once, by its request id.

**The weights are a proxy.** How a subscription's 5-hour and weekly limits count usage is not published. The script weighs each kind of token by its public API price relative to input:

| Kind of token | Weight |
| :- | -: |
| input | 1 |
| cache written for 5 minutes | 1.25 |
| cache written for 1 hour | 2 |
| cache read | 0.1 |
| output, thinking included | 5 |

The shares use those weights.

| Figure | Meaning |
| :- | :- |
| Context per call | Everything the model read on a call: input plus cache written plus cache read. Only main sessions count, not subagents. Every call reads its whole context again, so this is the main driver of usage. |
| Context of a session's first call | What a session costs before doing anything: system prompt, tools, `CLAUDE.md` / `AGENTS.md`, skills. |
| Calls per session, session length | The session's calls between the dates, and the hours from its first call to its last. |
| Whole-context rewrite | A call with more than 60,000 tokens of context, more than 60 % of them written to the cache: the cache had expired, or the context is new. They are grouped by the pause since the same transcript's previous call. **Start** is a transcript's first call, such as a subagent starting. Under 5 minutes, the cache should still have been there. 5 to 60 minutes means a 5-minute cache expired. Over an hour, a 1-hour cache did too. |
| Subagents | A subagent's transcript, `<session>/subagents/*.jsonl`, counts toward the session that ran it, and its share is also given apart. |
| Read every standard | A session or subagent that read at least 20 distinct standards, either by their URL or as a file of the same name. Agents download the standards into their scratchpad and then `Read` them. |
| Characters read, by origin | The characters of text the `Read` tool returned, by where the file was: a standard (by name), `/tmp`, `~/.claude`, `node_modules`, or anything else. |
| Images read, by origin | How many images the `Read` tool returned, such as screenshots, by the same origins. An image counts once, not by its encoded size: the model sees a screenshot as some 1,500 tokens. Before 2026-11-03 images were counted as characters of their base64, which made `/tmp` look like tens of millions of characters of logs. |
| Compactions | Times the context was summarised to make room. |

## What it cannot see

- **Only this machine's transcripts.** Every person runs it on their own machine, so a team's figure is the sum of theirs.
- **Transcripts Claude Code has already cleaned up.** Claude Code deletes old transcripts after a while, `cleanupPeriodDays` in its settings. Measure a period before it is gone.
- **Cloud sessions**, and sessions run with other tools, such as the claude.ai chat.

## Develop

```bash
node --test 'tools/**/*.test.ts'
```
