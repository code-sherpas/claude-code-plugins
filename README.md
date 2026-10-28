# Code Sherpas Claude Code plugins

The Claude Code marketplace of Code Sherpas: hooks, and anything else Claude Code can load from a plugin, kept in one place instead of copied into every repository.

## Plugins

| Plugin | What it does |
| :- | :- |
| `base` | What every Code Sherpas repository enables. Today, one hook: at the end of a turn (`Stop`, `SubagentStop`), a visible Playwright browser this session opened is still open → it stops the turn once so the agent decides, and only warns the second time. It is the automated check of [Leave Nothing Running](https://github.com/code-sherpas/software-development-standards/blob/main/leave-nothing-running.md). |

**The rules live in the [software development standards](https://github.com/code-sherpas/software-development-standards), not here.** A hook is the automated check of a standard: its message names the standard and links it instead of restating it, so a rule changes in one place.

## Enable it in a repository

Add this to the repository's versioned `.claude/settings.json`:

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

Once a person trusts the folder, Claude Code registers the marketplace and loads `base` from it, with no install command. With `autoUpdate`, every session refreshes the marketplace after it starts and the next one loads what is on `main` — the same semantics as the standards. **No plugin sets `version`**, on purpose: with a version, nobody receives a commit until the string changes.

**This repository is public on purpose**: Claude Code fetches and updates it with `git` and never prompts, so a public repository needs no credentials on any machine, in a cloud session or in CI. Nothing that is internal to Code Sherpas goes here; if a plugin ever needs that, it goes in a separate, non-public marketplace.

## Develop

```bash
node --test 'plugins/**/*.test.ts'      # Node 24 or later: runs TypeScript as is
claude plugin validate .                # not --strict: the missing `version` is a warning on purpose
```

To try a change before merging, load the plugin from your checkout: `claude --plugin-dir ./plugins/base`.

CI runs the tests on Linux and macOS, where the hooks run, and validates the marketplace.
