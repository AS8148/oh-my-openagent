#!/usr/bin/env bash
# Non-blocking Claude Code SessionEnd launcher for cleanup.sh.
#
# Claude may cancel shutdown hooks while the session is closing. Keep this hook
# tiny and best-effort, then let cleanup.sh do strict synchronous work outside
# the hook process.
set -u

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CLEANUP_SCRIPT="$PROJECT_DIR/script/agent/cleanup.sh"
# The log must never land inside the project tree: cleanup.sh prunes transient
# files there and a log write could clobber a tracked file. Any absolute,
# existing temp directory outside the project is accepted, so the hook works on
# hosts whose TMPDIR lives outside /tmp. A rejected TMPDIR falls back to /tmp
# and SAYS SO on stderr instead of substituting silently (#10735).
resolve_log_dir() {
  candidate="${TMPDIR:-/tmp}"
  reason=""
  case "$candidate" in
    "") reason="TMPDIR is empty" ;;
    *..*) reason="TMPDIR contains '..'" ;;
    /*) ;;
    *) reason="TMPDIR is not an absolute path" ;;
  esac
  if [ -z "$reason" ] && [ ! -d "$candidate" ]; then
    reason="TMPDIR is not an existing directory"
  fi
  if [ -z "$reason" ]; then
    case "${candidate%/}/" in
      "${PROJECT_DIR%/}"/*) reason="TMPDIR is inside the project directory" ;;
    esac
  fi
  if [ -n "$reason" ]; then
    printf '[cleanup-hook] %s (%s); logging under /tmp instead\n' "$reason" "$candidate" >&2
    printf '%s\n' "/tmp"
    return 0
  fi
  printf '%s\n' "${candidate%/}"
}

LOG_DIR="$(resolve_log_dir)"
LOG_FILE="${LOG_DIR%/}/oh-my-openagent-cleanup.log"

# Single source of truth for the resolved log path, so callers (tests included)
# read the path this hook actually uses instead of re-implementing the rules.
if [ "${1:-}" = "--print-log-file" ]; then
  printf '%s\n' "$LOG_FILE"
  exit 0
fi

if [ ! -f "$CLEANUP_SCRIPT" ]; then
  printf '[cleanup-hook] missing cleanup script: %s\n' "$CLEANUP_SCRIPT" >&2
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

if [ "${OMO_AGENT_CLEANUP_SYNC:-0}" = "1" ]; then
  bash "$CLEANUP_SCRIPT" >>"$LOG_FILE" 2>&1 || true
  exit 0
fi

if command -v nohup >/dev/null 2>&1; then
  nohup bash "$CLEANUP_SCRIPT" >>"$LOG_FILE" 2>&1 </dev/null &
else
  bash "$CLEANUP_SCRIPT" >>"$LOG_FILE" 2>&1 </dev/null &
fi

disown "$!" 2>/dev/null || true
exit 0
