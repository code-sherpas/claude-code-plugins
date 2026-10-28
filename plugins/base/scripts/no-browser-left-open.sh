#!/usr/bin/env bash
# Claude Code `Stop` / `SubagentStop` hook: an agent does not end its turn with
# a visible Playwright browser it opened still open.
#
# It is the automated check of the «Leave Nothing Running» standard, for the
# one kind of resource it can detect. The rule lives in the standard, not
# here: the message below names it and links it instead of restating it.
# https://github.com/code-sherpas/software-development-standards/blob/main/leave-nothing-running.md
#
# Measured 2026-10-28: after the Playwright MCP's `planner_setup_page`,
# `browser_close` answered «No open tabs» and left the Chromium window and its
# worker alive on the developer's screen. Nobody noticed but the person whose
# screen it was.
#
# Each agent answers for the windows IT opened, and only those: closing
# anybody else's needs the person's permission, so it is never pointed at.
# A checkout says nothing about that — several sessions can share one — so a
# browser belongs to the session named by the nearest of its ancestors that
# carries `CLAUDE_CODE_SESSION_ID`, which Claude Code exports to everything it
# launches: its MCP servers and its shell commands, and whatever those leave
# running in the background after detaching. Playwright gives the browser
# itself a filtered environment without it, hence the walk up. A browser with
# no such ancestor is nobody's here, and is never pointed at.
#
# Only Playwright's Chromium (under `ms-playwright`) counts, the browser itself
# rather than a `--type=` child or the crash reporter, and only a visible one:
# an e2e run's are `--headless` and may be running on purpose.
#
# It asks for a decision, not for a close: a window the agent still needs —
# the person is looking at it, or the next turn goes on using it — stays open,
# and the agent says which and why. So it blocks once: Claude Code sets
# `stop_hook_active` when the turn goes on because of this hook, and then it
# only warns. That is also what keeps a browser the agent cannot close from
# trapping the session.
#
# For no-browser-left-open.test.ts, next to this file, `BROWSER_GUARD_PROCESSES`
# replaces the process table — one `pid<TAB>ppid<TAB>session id or -<TAB>command
# line` per line.
set -u

input="$(cat)"
session="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
session="${session:-${CLAUDE_CODE_SESSION_ID:-}}"
[ -n "$session" ] || exit 0

if [ -n "${BROWSER_GUARD_PROCESSES:-}" ]; then
  table="$BROWSER_GUARD_PROCESSES"
else
  table="$(ps -eo pid=,ppid=,args= | awk '{ pid = $1; ppid = $2; $1 = ""; $2 = ""; sub(/^  /, ""); print pid "\t" ppid "\t?\t" $0 }')"
fi

# The session a process was launched by, as its environment says; empty when
# it says none or cannot be read.
session_of() {
  local pid="$1" recorded
  recorded="$(printf '%s\n' "$table" | awk -F '\t' -v pid="$pid" '$1 == pid { print $3; exit }')"
  case "$recorded" in
    "?") ;;
    "-" | "") return ;;
    *) printf '%s' "$recorded"; return ;;
  esac
  if [ -r "/proc/$pid/environ" ]; then
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^CLAUDE_CODE_SESSION_ID=//p' | head -1
  else
    ps -E -ww -o command= -p "$pid" 2>/dev/null | tr ' ' '\n' | sed -n 's/^CLAUDE_CODE_SESSION_ID=//p' | head -1
  fi
}

parent_of() {
  printf '%s\n' "$table" | awk -F '\t' -v pid="$1" '$1 == pid { print $2; exit }'
}

visible_browsers="$(printf '%s\n' "$table" | awk -F '\t' '
  $4 ~ /ms-playwright/ && $4 !~ /--type=/ && $4 !~ /--headless/ {
    binary = $4; sub(/ --.*$/, "", binary)
    if (binary ~ /\/(chrome|Chromium|Google Chrome for Testing)$/) print $1
  }')"

left_open=""
for browser in $visible_browsers; do
  pid="$browser"
  for _ in $(seq 1 64); do
    [ -n "$pid" ] && [ "$pid" -gt 1 ] || break
    owner="$(session_of "$pid")"
    if [ -n "$owner" ]; then
      [ "$owner" = "$session" ] && left_open="$left_open $browser"
      break
    fi
    pid="$(parent_of "$pid")"
  done
done

left_open="$(printf '%s\n' $left_open | sort -n | paste -sd ',' - | sed 's/,/, /g')"
[ -z "$left_open" ] && exit 0

reason="Leave Nothing Running (https://raw.githubusercontent.com/code-sherpas/software-development-standards/main/leave-nothing-running.md): a visible Playwright browser this session opened is still open (PID ${left_open}). Decide before ending the turn. If nothing needs it, close it: browser_close, and if the window is still there, end that browser and the Playwright worker or script that launched it. If you keep it, say in your reply which window and why. This will not stop the turn again."
json_reason="$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')"

if printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  printf '{"systemMessage":"%s"}\n' "$json_reason"
  exit 0
fi

printf '{"decision":"block","reason":"%s"}\n' "$json_reason"
