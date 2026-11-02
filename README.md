# Code Sherpas Claude Code plugins

The Claude Code marketplace of Code Sherpas: hooks, and anything else Claude Code can load from a plugin, kept in one place instead of copied into every repository.

## Plugins

| Plugin | What it does |
| :- | :- |
| `base` | What every Code Sherpas repository enables:<br>• **The checks of the standards**: at the end of a turn (`Stop`, `SubagentStop`), it runs the checks the [software development standards](https://github.com/code-sherpas/software-development-standards#automated-checks) declare for that event — today, [Leave Nothing Running](https://github.com/code-sherpas/software-development-standards/blob/main/leave-nothing-running.md)'s: a visible Playwright browser this session opened is still open. A finding stops the turn once so the agent decides, and only warns the second time.<br>• **The agents that ship increments**: `base:increment-builder`, `base:increment-reviewer` and `base:increment-verifier`, the roles of the [Shipping Increments](https://github.com/code-sherpas/software-development-standards/blob/main/shipping-increments.md) standard. Each holds only its role and its tools, and points to the standard for the rules; the reviewer and the verifier cannot use Claude Code's editing tools.<br>• **The Code Sherpas agent skills** (`/base:fix-error`, `/base:build-prototype`, …), from [code-sherpas/agent-skills](https://github.com/code-sherpas/agent-skills). |

**Nothing here is a second copy of something that lives elsewhere.** The rules live in the [software development standards](https://github.com/code-sherpas/software-development-standards), not here, and so do their checks. Each check sits next to the standard it backs, and the repository's `checks/checks.tsv` says on which event it runs. `plugins/base/scripts/run-standards-checks.sh` is only the runner. On each `Stop` and `SubagentStop` it downloads that manifest and the scripts it lists for the event from `main`, runs them, and turns what they find into Claude Code's answer, putting the name and link of the standard behind each finding in front of it. It keeps the last copy it downloaded (in `${CLAUDE_PLUGIN_DATA}`, or `~/.cache/code-sherpas-base` where Claude Code sets none) for when GitHub cannot be reached; if it has no copy, it warns and stops nothing. So a check is added or changed there, and this repository does not change for it. The trust is the same as for the plugin itself: whatever reaches `main` there runs on every machine at the next end of a turn.

**The skills live in [code-sherpas/agent-skills](https://github.com/code-sherpas/agent-skills)**, their single source of truth, in the [Agent Skills](https://agentskills.io/specification) format. `plugins/base/agent-skills` is a git submodule pointing at a commit of that repository, never a copy. Dependabot moves it to the latest commit every day, `.github/workflows/enqueue-dependabot.yaml` puts that pull request in the merge queue as the `agent-plugins-updater` GitHub App (the workflow's own token cannot: GitHub starts no workflow, the queue's build included, for what that token does), and it lands once the queue's build passes — with nobody reviewing it. **The workflow enqueues that pull request and nothing else**: being opened by Dependabot is not enough, since another ecosystem or a security update would open pull requests as Dependabot too. It enqueues only one from a `dependabot/submodules/` branch that changes exactly `plugins/base/agent-skills`, and only as a submodule pointer; any other stays open for a person. `plugins/base/skills.test.ts` stands in for the reviewer: every skill must keep to the specification, or the pull request stays out of `main`, open, for a person. Change a skill in agent-skills, never here.

## Tools

Not part of any plugin: they run by hand, from a checkout of this repository.

| Tool | What it does |
| :- | :- |
| [`tools/session-usage`](tools/session-usage/README.md) | How the Claude Code sessions of one project spent their tokens, read from the transcripts on this machine: context per call, length of sessions, cache rewrites, subagents, who read every standard. Used to compare before and after a change to how agents work. |

## Enable it

It takes two steps, and they do different jobs: **each machine installs `base` once, switched off; each repository switches it on.** So it runs in Code Sherpas repositories, and nowhere else.

**Once per machine**, in a shell:

```bash
claude plugin marketplace add code-sherpas/claude-code-plugins
claude plugin install base@code-sherpas --scope user   # installs it for every repository and worktree…
claude plugin disable base@code-sherpas --scope user   # …switched off unless a repository switches it on
```

Without the install, an interactive session in a repository that enables `base` does not load it — measured on 2026-10-28: `Plugin "base" not cached`, and no hook runs. The repository's settings switch a plugin on, but do not install it. Installing with `--scope project` does not do either: it is tied to the path of one checkout, so every new worktree would need it again. And `install` alone, without `disable`, switches `base` on in every session on the machine, Code Sherpas or not.

**Once per repository**, in its versioned `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "code-sherpas": {
      "source": { "source": "github", "repo": "code-sherpas/claude-code-plugins" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "base@code-sherpas": true }
}
```

Project settings take precedence over user settings, so `true` here switches on what the machine left off. With `autoUpdate`, every session refreshes the marketplace after it starts and the next one loads what is on `main` — the same semantics as the standards. **No plugin sets `version`**, on purpose: with a version, nobody receives a commit until the string changes.

**This repository is public on purpose**: Claude Code fetches and updates it with `git` and never prompts, so a public repository needs no credentials on any machine, in a cloud session or in CI. Nothing that is internal to Code Sherpas goes here; if a plugin ever needs that, it goes in a separate, non-public marketplace.

## Develop

```bash
git submodule update --init             # the skills, from agent-skills
node --test 'plugins/**/*.test.ts' 'tools/**/*.test.ts'   # Node 24 or later: runs TypeScript as is
claude plugin validate .                # not --strict: the missing `version` is a warning on purpose
```

To try a change before merging, load the plugin from your checkout: `claude --plugin-dir ./plugins/base`.

CI runs the tests on Linux and macOS, where the hooks run, and validates the marketplace — **only in the merge queue**, as in alexandria-web-application: a push to a pull request runs nothing, and a green pull request means nothing has been checked yet. A person's pull request reaches `main` through the queue (`gh pr merge <n>`), whose build of the tree that will land must pass `quality_checks`. Dependabot's are put there by the workflow above.
