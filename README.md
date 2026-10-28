# Code Sherpas Claude Code plugins

The Claude Code marketplace of Code Sherpas: hooks, and anything else Claude Code can load from a plugin, kept in one place instead of copied into every repository.

## Plugins

| Plugin | What it does |
| :- | :- |
| `base` | What every Code Sherpas repository enables:<br>• **A hook**: at the end of a turn (`Stop`, `SubagentStop`), a visible Playwright browser this session opened is still open → it stops the turn once so the agent decides, and only warns the second time. It is the automated check of [Leave Nothing Running](https://github.com/code-sherpas/software-development-standards/blob/main/leave-nothing-running.md).<br>• **The Code Sherpas agent skills** (`/base:fix-error`, `/base:build-prototype`, …), from [code-sherpas/agent-skills](https://github.com/code-sherpas/agent-skills). |

**Nothing here is a second copy of something that lives elsewhere.** The rules live in the [software development standards](https://github.com/code-sherpas/software-development-standards), not here. A hook is the automated check of a standard: its message names the standard and links it instead of restating it, so a rule changes in one place.

**The skills live in [code-sherpas/agent-skills](https://github.com/code-sherpas/agent-skills)**, their single source of truth, in the [Agent Skills](https://agentskills.io/specification) format. `plugins/base/agent-skills` is a git submodule pointing at a commit of that repository, never a copy. Dependabot moves it to the latest commit every day, `.github/workflows/enqueue-dependabot.yaml` puts that pull request in the merge queue, and it lands once the queue's build passes — with nobody reviewing it. `plugins/base/skills.test.ts` stands in for the reviewer: every skill must keep to the specification, or the pull request stays out of `main`, open, for a person. Change a skill in agent-skills, never here.

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
node --test 'plugins/**/*.test.ts'      # Node 24 or later: runs TypeScript as is
claude plugin validate .                # not --strict: the missing `version` is a warning on purpose
```

To try a change before merging, load the plugin from your checkout: `claude --plugin-dir ./plugins/base`.

CI runs the tests on Linux and macOS, where the hooks run, and validates the marketplace — **only in the merge queue**, as in alexandria-web-application: a push to a pull request runs nothing, and a green pull request means nothing has been checked yet. A person's pull request reaches `main` through the queue (`gh pr merge <n>`), whose build of the tree that will land must pass `quality_checks`. Dependabot's are put there by the workflow above.
