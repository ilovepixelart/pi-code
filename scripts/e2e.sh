#!/bin/zsh
# Deterministic e2e smoke of the pi-code plugins in a real pi TUI via tmux.
# Usage: scripts/e2e.sh [workdir]  (defaults to a fresh temp fixture repo)
# Requires: tmux, pi on PATH, a working default model in ~/.pi/agent.
set -euo pipefail

SESSION="pi-e2e-$$"
WORKDIR="${1:-}"
PASS=0
FAIL=0

say() { print -P "%F{blue}[e2e]%f $1" }
ok() { PASS=$((PASS + 1)); print -P "%F{green}PASS%f $1" }
bad() { FAIL=$((FAIL + 1)); print -P "%F{red}FAIL%f $1" }

capture() { tmux capture-pane -t "$SESSION" -p }
send() { tmux send-keys -t "$SESSION" "$@" }

wait_for() { # wait_for <regex> <timeout-seconds>
  local deadline=$(($(date +%s) + $2))
  while (($(date +%s) < deadline)); do
    if capture | grep -qE "$1"; then return 0; fi
    sleep 2
  done
  return 1
}

FIXTURE=0
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
# the trust decision in a throwaway store. See e2e-full.sh for the measured impact.
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
    settings = json.load(open(src))
except Exception:
    settings = {}
settings["packages"] = [repo]
settings["defaultThinkingLevel"] = "low"
for key in ("extensions", "skills", "prompts"):
    settings.pop(key, None)
json.dump(settings, open(dst, "w"))
PY

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" "HOME=$FAKEHOME pi"
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true; rm -rf "$FAKEHOME"' EXIT

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
if wait_for '\[Extensions\]' 120 && capture | grep -A20 '\[Extensions\]' | grep -q 'todo.ts'; then
  ok "boot: extensions loaded"
else
  bad "boot: extensions missing"
fi

# 2. Rules plugin announces itself
if capture | grep -q 'Rules loaded'; then ok "rules: loaded"; else bad "rules: no announcement"; fi

# 3. Plan mode toggles on and off with status badge
send "/plan" Enter
if wait_for '⏸ plan' 15; then ok "plan-mode: badge on"; else bad "plan-mode: badge missing"; fi
send "/plan" Enter
sleep 2
if capture | grep -q '⏸ plan'; then bad "plan-mode: badge stuck"; else ok "plan-mode: badge off"; fi

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
print "e2e finished: $PASS passed, $FAIL failed"
exit $((FAIL > 0))
