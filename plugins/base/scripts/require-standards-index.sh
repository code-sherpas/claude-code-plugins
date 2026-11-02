#!/usr/bin/env bash
# Claude Code hook: no agent and no sub-agent works before reading the index
# of the Code Sherpas software development standards. Usage:
#   require-standards-index.sh <event>   # hook input on stdin
#
# Reading the index was an instruction in a repository's AGENTS.md, and an
# instruction is followed until the turn it is not. Measured 2026-11-01 in
# alexandria-web-application: 36 of 37 sessions and 68 of 80 sub-agents read
# it before starting; one sub-agent in seven did not. Only the repositories
# that carry that section asked for it at all. Every agent has to read the
# index, because a standard may apply where nobody foresaw it.
#
# The index is not injected: Claude Code caps what a hook adds to the context
# at 10,000 characters, and the index is twice that. Instead:
#   SessionStart, SubagentStart  download the index from the standards' `main`
#       into a local file, keeping the last copy for when GitHub cannot be
#       reached, and tell the agent where it is and to read it. SessionStart
#       reaches the session's agent only, so each sub-agent is told on its own
#       start. A new start, a `/clear` or a compaction asks for it again.
#   PostToolUse  records that this agent read it, once a Read of that file
#       covered the whole of it.
#   PreToolUse   refuses every other tool to an agent that has not read it.
#       The Read of the index goes through, and so does SubagentHandback, the
#       tool a sub-agent returns its result with. With no index at all,
#       neither downloaded nor kept, nothing is refused: a standard nobody can
#       read cannot be required.
# An agent is the session's (`main`) or a sub-agent, by the `agent_id` Claude
# Code gives the tool hooks of a sub-agent, so a sub-agent's reading never
# counts for the session's agent, nor the other way round.
#
# For require-standards-index.test.ts, next to this file: `STANDARDS_BASE_URL`
# replaces the repository's raw `main` URL (a `file://` one works), and
# `STANDARDS_INDEX_DIR` replaces the directory the copy and the records live in.
set -u

event="${1:-}"
input="$(cat)"

base="${STANDARDS_BASE_URL:-https://raw.githubusercontent.com/code-sherpas/software-development-standards/main}"
dir="${STANDARDS_INDEX_DIR:-${CLAUDE_PLUGIN_DATA:-${XDG_CACHE_HOME:-$HOME/.cache}/code-sherpas-base}/standards-index}"
index="$dir/README.md"

# The first string value of a top-level-looking JSON field in the hook input.
field() {
  printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -1
}

# The first number value of a JSON field in the hook input.
number() {
  printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" | head -1
}

session="$(field session_id)"
[ -n "$session" ] || exit 0
case "$session" in */* | *..*) exit 0 ;; esac
agent="$(field agent_id)"
agent="${agent:-main}"
case "$agent" in */* | *..*) exit 0 ;; esac
record="$dir/read/$session/$agent"

json() { # a JSON string with the text of $1
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\t\r' '  ' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'
}

instruction() {
  printf '%s' "Before anything else, read the Code Sherpas software development standards index in full, with the Read tool and no offset or limit: $index. It lists every standard and when it applies; then read in full every standard your work touches. Each one it links is at $base/<file>. Every other tool is refused until you have read the index."
}

fetch() {
  local partial="$index.partial.$$"
  mkdir -p "$dir" 2>/dev/null || return 1
  if curl -fsSL --connect-timeout 2 --max-time 4 "$base/README.md" -o "$partial" 2>/dev/null; then
    mv -f "$partial" "$index"
  else
    rm -f "$partial"
  fi
  [ -s "$index" ]
}

case "$event" in
  SessionStart | SubagentStart)
    # Records older than a week belong to sessions that are long over.
    find "$dir/read" -type f -mtime +7 -delete 2>/dev/null
    find "$dir/read" -mindepth 1 -type d -empty -delete 2>/dev/null
    rm -f "$record"
    if fetch; then
      context="$(instruction)"
    else
      context="The Code Sherpas software development standards index could not be downloaded from $base and no earlier copy is kept, so reading it is not required this time. Read it at $base/README.md as soon as you can."
    fi
    printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$event" "$(json "$context")"
    ;;

  PostToolUse)
    [ "$(field tool_name)" = "Read" ] && [ "$(field file_path)" = "$index" ] || exit 0
    offset="$(number offset)"
    limit="$(number limit)"
    lines="$(wc -l < "$index" 2>/dev/null | tr -d ' ')"
    [ -z "$offset" ] || [ "$offset" -le 1 ] || exit 0
    [ -z "$limit" ] || [ "$limit" -ge "${lines:-0}" ] || exit 0
    mkdir -p "$(dirname "$record")" && : > "$record"
    ;;

  PreToolUse)
    [ -e "$record" ] && exit 0
    [ -s "$index" ] || exit 0
    tool="$(field tool_name)"
    [ "$tool" = "SubagentHandback" ] && exit 0
    [ "$tool" = "Read" ] && [ "$(field file_path)" = "$index" ] && exit 0
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$(json "$(instruction)")"
    ;;
esac
exit 0
