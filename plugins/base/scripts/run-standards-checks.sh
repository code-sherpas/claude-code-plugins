#!/usr/bin/env bash
# Claude Code `Stop` / `SubagentStop` hook: runs the automated checks of the
# Code Sherpas software development standards. Usage:
#   run-standards-checks.sh <event>   # hook input on stdin
#
# The checks are not here. Each one belongs to the standard it backs, in
# code-sherpas/software-development-standards: `checks/checks.tsv` says which
# script runs on which event, and the README's «Automated checks» says what a
# script does. This runner reads that manifest from `main`, downloads the
# scripts it names for <event>, runs them with the hook input, and turns what
# they report into Claude Code's answer. So a check is added, changed or
# removed there, and this plugin never changes for it.
#
# A check reports only what it found. Before each finding this runner puts
# the name and the link of the standard the manifest says it backs. The name
# is the standard's first `# ` heading, downloaded and kept like the scripts.
# So the agent always has the whole rule at hand, and no check can forget to
# link it.
#
# Downloads have a short timeout. Each copy is kept, and when GitHub cannot be
# reached the last copy is used. With no copy at all, nothing runs: the hook
# only warns, and never stops the turn.
#
# What happens to the agent is decided here, the same way for every check. A
# finding stops the turn once, so the agent decides. When Claude Code sets
# `stop_hook_active` because the turn went on after this hook, findings only
# warn, so a check whose finding the agent cannot clear never traps the
# session. That warning is for the person, not the agent: it says the agent
# ended its turn with the finding still there, what to look for in its reply,
# and then quotes what the agent was told. A check that fails (non-zero exit) is reported and never stops
# anything.
#
# For run-standards-checks.test.ts, next to this file: `STANDARDS_BASE_URL`
# replaces the repository's raw `main` URL (a `file://` one works), and
# `STANDARDS_CHECKS_CACHE` replaces the directory the copies are kept in.
set -u

event="${1:-}"
input="$(cat)"
[ -n "$event" ] || exit 0

base="${STANDARDS_BASE_URL:-https://raw.githubusercontent.com/code-sherpas/software-development-standards/main}"
cache="${STANDARDS_CHECKS_CACHE:-${CLAUDE_PLUGIN_DATA:-${XDG_CACHE_HOME:-$HOME/.cache}/code-sherpas-base}/standards-checks}"

# Downloads <path> of the standards repository into the cache, and succeeds if
# a copy is there afterwards: the one just downloaded or an earlier one.
fetch() {
  local path="$1" target="$cache/$1" partial
  mkdir -p "$(dirname "$target")" 2>/dev/null || return 1
  partial="$target.partial.$$"
  if curl -fsSL --connect-timeout 2 --max-time 4 "$base/$path" -o "$partial" 2>/dev/null; then
    mv -f "$partial" "$target"
  else
    rm -f "$partial"
  fi
  [ -s "$target" ]
}

findings=""
problems=""

# <a> and <b> as paragraphs of one text, either of them possibly empty.
joined() {
  if [ -n "$1" ] && [ -n "$2" ]; then printf '%s\n\n%s' "$1" "$2"; else printf '%s%s' "$1" "$2"; fi
}

if fetch "checks/checks.tsv"; then
  ran=" "
  tab="$(printf '\t')"
  while IFS="$tab" read -r line_event standard script || [ -n "$line_event" ]; do
    case "$line_event" in "" | "#"*) continue ;; esac
    [ "$line_event" = "$event" ] || continue
    case "$ran" in *" $script "*) continue ;; esac
    ran="$ran$script "
    # Only a script inside a standard's own folder: nothing the manifest says
    # can make this runner fetch or run anything else.
    if ! printf '%s' "$script" | grep -Eq '^checks/[a-z0-9-]+/[a-z0-9-]+\.sh$'; then
      problems="$(joined "$problems" "checks.tsv names \"$script\", which is not a check script path; it did not run.")"
      continue
    fi
    if ! printf '%s' "$standard" | grep -Eq '^[a-z0-9-]+\.md$'; then
      problems="$(joined "$problems" "checks.tsv says \"$script\" backs \"$standard\", which is not a standard's file name; it did not run.")"
      continue
    fi
    if ! fetch "$script"; then
      problems="$(joined "$problems" "$script (${standard}) could not be downloaded and no earlier copy is kept; it did not run.")"
      continue
    fi
    output="$(printf '%s' "$input" | bash "$cache/$script" 2>/dev/null)"
    status=$?
    if [ "$status" -ne 0 ]; then
      problems="$(joined "$problems" "$script (${standard}) failed with exit status $status; what it checks was not checked.")"
    elif [ -n "$output" ]; then
      title=""
      fetch "$standard" && title="$(sed -n 's/^# //p' "$cache/$standard" | head -1)"
      findings="$(joined "$findings" "${title:-$standard} ($base/$standard): $output")"
    fi
  done < "$cache/checks/checks.tsv"
else
  problems="$(joined "$problems" "checks/checks.tsv could not be downloaded from $base and no earlier copy is kept; no check ran.")"
fi

[ -n "$problems" ] && problems="Code Sherpas standards checks on $event: $problems"

json() { # a JSON string with the text of $1
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\t\r' '  ' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'
}

if [ -n "$findings" ] && ! printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  reason="$findings

This will not stop the turn again."
  if [ -n "$problems" ]; then
    printf '{"decision":"block","reason":"%s","systemMessage":"%s"}\n' "$(json "$reason")" "$(json "$problems")"
  else
    printf '{"decision":"block","reason":"%s"}\n' "$(json "$reason")"
  fi
  exit 0
fi

if [ -n "$findings" ]; then
  findings="The agent ended its turn although a check of the Code Sherpas standards still finds what it was stopped once to decide on. Its reply should say what it kept and why. If it does not, ask it, or see to it yourself. What the agent was told:

$findings"
fi
message="$(joined "$findings" "$problems")"
[ -n "$message" ] && printf '{"systemMessage":"%s"}\n' "$(json "$message")"
exit 0
