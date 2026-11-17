#!/usr/bin/env bash
# Claude Code hook: runs the automated checks of the Code Sherpas software
# development standards. Usage:
#   run-standards-checks.sh <event>   # Stop, SubagentStop or PreToolUse; hook input on stdin
#   run-standards-checks.sh prefetch  # SessionStart: only keeps copies, says nothing
#
# The checks are not here. Each one belongs to the standard it backs, in
# code-sherpas/software-development-standards: `checks/checks.tsv` says which
# script runs on which event, and the README's «Automated checks» says what a
# script does. This runner reads that manifest from `main`, downloads the
# scripts it names for <event>, runs them with the hook input, and turns what
# they report into Claude Code's answer. So a check is added, changed or
# removed there, and this plugin never changes for it. A row for an event this
# runner is not called on is skipped.
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
# `PreToolUse` runs before every tool call, so it never downloads anything: it
# runs only the copies kept. They are kept by `prefetch` at the start of each
# session and refreshed at every `Stop` and `SubagentStop`, which download the
# manifest and also the scripts and standards of its `PreToolUse` rows. So a
# change there reaches tool calls by the next turn. When one of those cannot
# be downloaded and has no copy, the end of the turn says so, not every tool
# call; before any copy, tool calls are checked by nothing.
#
# What happens to the agent is decided here, the same way for every check. At
# the end of a turn, a finding stops the turn once, so the agent decides. When
# Claude Code sets `stop_hook_active` because the turn went on after this
# hook, findings only warn, so a check whose finding the agent cannot clear
# never traps the session. That warning is for the person, not the agent: it
# says the agent ended its turn with the finding still there, what to look for
# in its reply, and then quotes what the agent was told. Before a tool call, a
# finding asks the person whether to allow the call, in every permission mode,
# auto included, and says why. A check that fails (non-zero exit) is reported
# and never stops or asks anything.
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

# The events run before a tool call: only kept copies, never a download.
tool_events=" PreToolUse "
case "$tool_events" in *" $event "*) offline=1 ;; *) offline=0 ;; esac

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

# Succeeds if a copy of <path> is there: downloaded first, unless offline.
get() {
  if [ "$offline" = 1 ]; then [ -s "$cache/$1" ]; else fetch "$1"; fi
}

# Only a script inside a standard's own folder, backing a standard's file:
# nothing the manifest says can make this runner fetch or run anything else.
# Says why not, if not.
unsafe_row() { # <standard> <script>
  if ! [[ "$2" =~ ^checks/[a-z0-9-]+/[a-z0-9-]+\.sh$ ]]; then
    printf 'checks.tsv names "%s", which is not a check script path; it did not run.' "$2"
  elif ! [[ "$1" =~ ^[a-z0-9-]+\.md$ ]]; then
    printf 'checks.tsv says "%s" backs "%s", which is not a standard'"'"'s file name; it did not run.' "$2" "$1"
  else
    return 1
  fi
}

findings=""
problems=""

# <a> and <b> as paragraphs of one text, either of them possibly empty.
joined() {
  if [ -n "$1" ] && [ -n "$2" ]; then printf '%s\n\n%s' "$1" "$2"; else printf '%s%s' "$1" "$2"; fi
}

tab="$(printf '\t')"

# Keeps copies of the scripts and standards of the tool-call rows, which run
# with no download, and says which of them has none.
prefetch_tool_checks() {
  local line_event standard script seen=" "
  while IFS="$tab" read -r line_event standard script || [ -n "$line_event" ]; do
    case "$tool_events" in *" $line_event "*) ;; *) continue ;; esac
    case "$seen" in *" $script "*) continue ;; esac
    seen="$seen$script "
    unsafe_row "$standard" "$script" >/dev/null && continue
    fetch "$standard"
    fetch "$script" ||
      problems="$(joined "$problems" "$script (${standard}), checked before $line_event, could not be downloaded and no earlier copy is kept; until it is, it does not run.")"
  done < "$cache/checks/checks.tsv"
}

if [ "$event" = prefetch ]; then
  fetch "checks/checks.tsv" && prefetch_tool_checks
  exit 0
fi

if get "checks/checks.tsv"; then
  ran=" "
  while IFS="$tab" read -r line_event standard script || [ -n "$line_event" ]; do
    [ "$line_event" = "$event" ] || continue
    case "$ran" in *" $script "*) continue ;; esac
    ran="$ran$script "
    if why="$(unsafe_row "$standard" "$script")"; then
      problems="$(joined "$problems" "$why")"
      continue
    fi
    if ! get "$script"; then
      # Before a tool call, the end of the turn says so instead.
      [ "$offline" = 1 ] ||
        problems="$(joined "$problems" "$script (${standard}) could not be downloaded and no earlier copy is kept; it did not run.")"
      continue
    fi
    output="$(printf '%s' "$input" | bash "$cache/$script" 2>/dev/null)"
    status=$?
    if [ "$status" -ne 0 ]; then
      problems="$(joined "$problems" "$script (${standard}) failed with exit status $status; what it checks was not checked.")"
    elif [ -n "$output" ]; then
      title=""
      get "$standard" && title="$(sed -n 's/^# //p' "$cache/$standard" | head -1)"
      findings="$(joined "$findings" "${title:-$standard} ($base/$standard): $output")"
    fi
  done < "$cache/checks/checks.tsv"
  [ "$offline" = 1 ] || prefetch_tool_checks
elif [ "$offline" = 0 ]; then
  problems="$(joined "$problems" "checks/checks.tsv could not be downloaded from $base and no earlier copy is kept; no check ran.")"
fi

[ -n "$problems" ] && problems="Code Sherpas standards checks on $event: $problems"

json() { # a JSON string with the text of $1
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\t\r' '  ' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'
}

if [ "$offline" = 1 ]; then
  if [ -n "$findings" ]; then
    printf '{"hookSpecificOutput":{"hookEventName":"%s","permissionDecision":"ask","permissionDecisionReason":"%s"}' "$event" "$(json "$findings")"
    [ -n "$problems" ] && printf ',"systemMessage":"%s"' "$(json "$problems")"
    printf '}\n'
  elif [ -n "$problems" ]; then
    printf '{"systemMessage":"%s"}\n' "$(json "$problems")"
  fi
  exit 0
fi

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
