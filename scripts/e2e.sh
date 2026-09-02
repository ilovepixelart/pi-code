#!/bin/zsh
# Deterministic e2e smoke of the pi-code plugins in a real pi TUI via tmux.
# Usage: scripts/e2e.sh [workdir]  (defaults to a fresh temp fixture repo)
# Requires: tmux, pi on PATH, a working default model in ~/.pi/agent.
set -euo pipefail

SESSION="pi-e2e-$$"
WORKDIR="${1:-}"
PASS=0
FAIL=0
WARN=0

say() { print -P "%F{blue}[e2e]%f $1" }
ok() { PASS=$((PASS + 1)); print -P "%F{green}PASS%f $1" }
bad() { FAIL=$((FAIL + 1)); print -P "%F{red}FAIL%f $1" }
warn() { WARN=$((WARN + 1)); print -P "%F{yellow}WARN%f $1" }

# Two depths, as in e2e-full.sh: current screen for state, scrollback for markers.
capture() { tmux capture-pane -t "$SESSION" -p }
capture_all() { tmux capture-pane -t "$SESSION" -p -S -200 }
send() { tmux send-keys -t "$SESSION" "$@" }

wait_for() { # wait_for <regex> <timeout-seconds>
  local deadline=$(($(date +%s) + $2))
  while (($(date +%s) < deadline)); do
    if capture_all | grep -qE "$1"; then return 0; fi
    sleep 2
  done
  return 1
}

wait_for_absent() { # wait_for_absent <regex> <timeout-seconds>
  local deadline=$(($(date +%s) + $2))
  while (($(date +%s) < deadline)); do
    capture | grep -qE "$1" || return 0
    sleep 2
  done
  return 1
}

# Signal-safe cleanup, installed before the first mktemp: zsh runs no EXIT trap
# on an untrapped INT/TERM, which leaked the session and both temp trees. A
# caller-supplied workdir is not ours to delete.
FIXTURE=0
cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null
  rm -rf ${FAKEHOME:+"$FAKEHOME"}
  [ "$FIXTURE" = 1 ] && rm -rf ${WORKDIR:+"$WORKDIR"}
  return 0
}
trap cleanup EXIT
trap 'cleanup; trap - INT; kill -INT $$' INT
trap 'cleanup; trap - TERM; kill -TERM $$' TERM

if [ -z "$WORKDIR" ]; then
  FIXTURE=1
  WORKDIR=$(mktemp -d)
  git -C "$WORKDIR" init -qb main
  git -C "$WORKDIR" -c user.name=e2e -c user.email=e2e@local commit -q --allow-empty -m init
  mkdir -p "$WORKDIR/.claude/rules"
  printf -- '- Tests must be deterministic.\n' > "$WORKDIR/.claude/rules/testing.md"
  mkdir -p "$WORKDIR/.pi"
  printf '{"mcpServers": {}}\n' > "$WORKDIR/.pi/mcp.json"
fi

say "workdir: $WORKDIR"

# Isolated HOME: keeps the developer's global MCP servers, rules and skills out of the
# boot (they inflate the prompt and stall session_start on failing servers) and lands
# the trust decision in a throwaway store. Settings are an allowlist, as in e2e-full.sh:
# only the model-selection keys ride in from the real file.
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FAKEHOME=$(mktemp -d)
mkdir -p "$FAKEHOME/.pi/agent"
for f in auth.json models.json models-store.json; do
  [ -f "$HOME/.pi/agent/$f" ] && cp "$HOME/.pi/agent/$f" "$FAKEHOME/.pi/agent/$f"
done
python3 - "$HOME/.pi/agent/settings.json" "$FAKEHOME/.pi/agent/settings.json" "$REPO" <<'PY'
import json, sys
src, dst, repo = sys.argv[1:4]
try:
    real = json.load(open(src))
except Exception:
    real = {}
settings = {key: real[key] for key in ("defaultModel", "defaultProvider") if key in real}
settings["packages"] = [repo]
settings["defaultThinkingLevel"] = "low"
json.dump(settings, open(dst, "w"))
PY

# Absolute pi path plus scrubbed config-dir vars: an inherited PI_CODING_AGENT_DIR
# or CLAUDE_CONFIG_DIR would point the "isolated" session at the real config.
PI_BIN=$(command -v pi)
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" "env -u PI_CODING_AGENT_DIR -u CLAUDE_CONFIG_DIR HOME=$FAKEHOME PI_SKIP_VERSION_CHECK=1 $PI_BIN"

# 0. The fixture ships .claude config pi would trust silently, so pi-code must ask.
#    Session start blocks on the answer; approve before expecting anything else.
if [ "$FIXTURE" = 1 ]; then
  if wait_for 'Trust this project\?' 30; then
    ok "trust: prompted for the claude-shaped fixture"
    send Enter
  else
    bad "trust: no approval prompt"
  fi
fi

# 1. Boot: all pi-code extensions load. First boot after a pi upgrade also renders the
# changelog, and failing MCP servers block session_start serially, so allow the full budget.
if wait_for '\[Extensions\]' 120 && capture_all | grep -q 'todo.ts'; then
  ok "boot: extensions loaded"
else
  bad "boot: extensions missing"
fi

# 2. Rules banner: same known pi TUI interaction as e2e-full.sh (fast boot drops all
# but the last session_start banner), so a warn, not a failure; the rule content is
# wire-asserted in e2e-full.sh.
if capture_all | grep -q 'Rules loaded'; then ok "rules: loaded"; else warn "rules: banner not rendered (known pi TUI interaction)"; fi

# 3. Plan mode toggles on and off with status badge
send "/plan" Enter
if wait_for '⏸ plan' 15; then ok "plan-mode: badge on"; else bad "plan-mode: badge missing"; fi
send "/plan" Enter
if wait_for_absent '⏸ plan' 20; then ok "plan-mode: badge off"; else bad "plan-mode: badge stuck"; fi

# 4. Model turn: todo tool renders the persistent overlay
send "Use the todo tool to add two todos for testing, then use the start action on the first. Do nothing else." Enter
if wait_for 'Todos \(' 240; then ok "todo: overlay rendered"; else bad "todo: no overlay"; fi

# 5. /rewind picker opens and cancels
send "/rewind" Enter
if wait_for 'Rewind to checkpoint' 15; then
  ok "checkpoint: picker opens"
  send Escape
else
  bad "checkpoint: no picker"
fi

print ""
print "e2e finished: $PASS passed, $FAIL failed, $WARN warned"
exit $((FAIL > 0))
