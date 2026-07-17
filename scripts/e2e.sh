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

if [ -z "$WORKDIR" ]; then
  WORKDIR=$(mktemp -d)
  git -C "$WORKDIR" init -qb main
  git -C "$WORKDIR" -c user.name=e2e -c user.email=e2e@local commit -q --allow-empty -m init
  mkdir -p "$WORKDIR/.claude/rules"
  printf -- '- Tests must be deterministic.\n' > "$WORKDIR/.claude/rules/testing.md"
  mkdir -p "$WORKDIR/.pi"
  printf '{"mcpServers": {}}\n' > "$WORKDIR/.pi/mcp.json"
fi

say "workdir: $WORKDIR"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$WORKDIR" "pi"
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true' EXIT

# 1. Boot: all pi-code extensions load
if wait_for '\[Extensions\]' 30 && capture | grep -A2 '\[Extensions\]' | grep -q 'guardrails.ts'; then
  ok "boot: extensions loaded"
else
  bad "boot: extensions missing"
fi

# 2. Rules plugin announces itself
if capture | grep -q 'Rules loaded'; then ok "rules: loaded"; else bad "rules: no announcement"; fi

# 3. /permissions command responds
send "/permissions" Enter
if wait_for 'permission|No rules configured|-> (allow|ask|deny)' 15; then ok "permissions: command works"; else bad "permissions: no output"; fi

# 4. Plan mode toggles on and off with status badge
send "/plan" Enter
if wait_for 'plan' 15 && capture | grep -q '⏸ plan'; then ok "plan-mode: badge on"; else bad "plan-mode: badge missing"; fi
send "/plan" Enter
sleep 2
if capture | grep -q '⏸ plan'; then bad "plan-mode: badge stuck"; else ok "plan-mode: badge off"; fi

# 5. Model turn: todo tool renders the persistent overlay
send "Use the todo tool to add two todos for testing, then use the start action on the first. Do nothing else." Enter
if wait_for 'Todos \(' 240; then ok "todo: overlay rendered"; else bad "todo: no overlay"; fi

# 6. Model turn: permission deny (guardrails floor asks; deny needs a project rule, so use force-push block instead)
send "Run this exact bash command and report the outcome: git push --force origin main" Enter
if wait_for 'Force-push is blocked|hand the command' 240; then ok "guardrails: force-push stopped"; else bad "guardrails: not stopped"; fi

# 7. /rewind picker opens and cancels
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
