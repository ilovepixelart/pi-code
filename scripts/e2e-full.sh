#!/bin/zsh
# Full-feature e2e of pi-code in a real pi TUI via tmux: every README feature, one run.
# Deterministic checks first, then model turns (todo, web, memory, subagent, plan, ...).
# Usage: scripts/e2e-full.sh
# Requires: tmux, node, pi on PATH, a working default model in ~/.pi/agent, network.
# Model turns depend on instruction-following; a FAIL there is worth one rerun before
# suspecting the product. Runtime is dominated by the model (typically 5-15 minutes).
set -uo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
SESSION="pi-e2e-full-$$"
PASS=0
FAIL=0
WARN=0

say() { print -P "%F{blue}[e2e-full]%f $1" }
ok() { PASS=$((PASS + 1)); print -P "%F{green}PASS%f $1" }
bad() { FAIL=$((FAIL + 1)); print -P "%F{red}FAIL%f $1" }
warn() { WARN=$((WARN + 1)); print -P "%F{yellow}WARN%f $1" }

capture() { tmux capture-pane -t "$SESSION" -p }
send() { tmux send-keys -t "$SESSION" "$@" }
type_prompt() { tmux send-keys -t "$SESSION" -l "$1"; tmux send-keys -t "$SESSION" Enter }

wait_for() { # wait_for <regex> <timeout-seconds>
  local deadline=$(($(date +%s) + $2))
  while (($(date +%s) < deadline)); do
    if capture | grep -qE "$1"; then return 0; fi
    sleep 2
  done
  return 1
}

wait_file() { # wait_file <path> <timeout-seconds>
  local deadline=$(($(date +%s) + $2))
  while (($(date +%s) < deadline)); do
    [ -e "$1" ] && return 0
    sleep 2
  done
  return 1
}

# --- Fixture: a project exercising every .claude surface ------------------------------
FX=$(mktemp -d)
FX=$(cd "$FX" && pwd -P)
git -C "$FX" init -qb main
git -C "$FX" -c user.name=e2e -c user.email=e2e@local commit -q --allow-empty -m init
mkdir -p "$FX/.claude/rules" "$FX/.claude/commands" "$FX/.claude/skills/greet" "$FX/.claude/output-styles" "$FX/.claude/agents" "$FX/notes"
printf -- '- Tests must be deterministic.\n' > "$FX/.claude/rules/testing.md"
printf 'Reply with exactly the word HELLO_MARKER and nothing else.\n' > "$FX/.claude/commands/hello.md"
printf -- '---\nname: greet\ndescription: Greets people for the e2e test\n---\nSay a friendly greeting.\n' > "$FX/.claude/skills/greet/SKILL.md"
printf -- '---\nname: Pirate\ndescription: e2e style\n---\nYou may speak like a pirate.\n' > "$FX/.claude/output-styles/pirate.md"
printf '{"outputStyle": "Pirate"}\n' > "$FX/.claude/settings.local.json"
cat > "$FX/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "command": "touch .e2e-session-start" }] }],
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "command": "if grep -q FORBIDDEN_MARKER; then echo BLOCKED_BY_E2E_HOOK >&2; exit 2; fi" }] }]
  }
}
EOF
printf 'Project context for the e2e run.\n\n@notes/extra.md\n' > "$FX/CLAUDE.md"
printf 'The codeword is ZANZIBAR.\n' > "$FX/notes/extra.md"
printf 'PERSONAL LOCAL NOTE MARKER\n' > "$FX/CLAUDE.local.md"
printf -- '---\nname: echoer\ndescription: Replies with a requested marker word\n---\nWhen given a task asking for a marker word, reply with exactly that word and nothing else.\n' > "$FX/.claude/agents/echoer.md"
printf 'ORIGINAL\n' > "$FX/data.txt"
printf 'node_modules\n' > "$FX/.gitignore"
ln -s "$REPO/node_modules" "$FX/node_modules"
cat > "$FX/mcp-server.mjs" <<'EOF'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'e2e', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'ping', description: 'Health check; always replies with the marker E2EPONG', inputSchema: { type: 'object', properties: {} } }],
}))
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'E2EPONG' }] }))
await server.connect(new StdioServerTransport())
EOF
printf '{"mcpServers": {"e2e": {"command": "node", "args": ["mcp-server.mjs"]}}}\n' > "$FX/.mcp.json"

SLUG=$(print -r -- "$FX" | sed 's#[/\\]#-#g' | sed 's#^--*#-#')
rm -rf "$HOME/.pi/agent/memory/$SLUG"

say "fixture: $FX"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$FX" "pi"
trap 'tmux kill-session -t "$SESSION" 2>/dev/null; rm -rf "$HOME/.pi/agent/memory/$SLUG"' EXIT

# --- Deterministic checks -------------------------------------------------------------
if wait_for 'Trust this project\?' 30; then
  ok "trust: prompted for the claude-shaped fixture"
  send Enter
else
  bad "trust: no approval prompt"
fi

if wait_for '\[Extensions\]' 40 && capture | grep -A20 '\[Extensions\]' | grep -q 'todo.ts'; then
  ok "boot: extensions loaded"
else
  bad "boot: extensions missing"
fi

if wait_for 'Rules loaded: global (yes|no), project 1' 20; then ok "rules: project rule counted"; else bad "rules: banner missing"; fi
if wait_for 'Output style: Pirate' 15; then ok "output-style: active style announced"; else bad "output-style: no banner"; fi
if wait_for 'MCP: ' 60; then ok "mcp: connect summary banner"; else bad "mcp: no summary banner"; fi
if wait_file "$FX/.e2e-session-start" 10; then ok "hooks: SessionStart hook ran"; else bad "hooks: SessionStart marker missing"; fi
if capture | grep -q '○ ready'; then ok "statusline: ready segment"; else bad "statusline: no ready segment"; fi

send "/mcp" Enter
if wait_for 'e2e: connected \(1 tools\)' 15; then ok "mcp: /mcp lists the fixture server"; else bad "mcp: /mcp listing wrong"; fi

send "/output-style" Enter
if wait_for 'Pirate' 15; then ok "output-style: picker opens"; send Escape; else bad "output-style: picker missing"; fi
sleep 1

send "/plan" Enter
if wait_for '⏸ plan' 15; then ok "plan-mode: badge on"; else bad "plan-mode: badge missing"; fi
send "/plan" Enter
sleep 2
if capture | grep -q '⏸ plan'; then bad "plan-mode: badge stuck"; else ok "plan-mode: badge off"; fi

send "/rewind" Enter
if wait_for 'No checkpoints recorded yet' 15; then ok "checkpoint: empty-session notice"; else bad "checkpoint: no empty notice"; fi

# --- Model turns ----------------------------------------------------------------------
type_prompt "/hello"
if wait_for 'HELLO_MARKER' 200; then ok "commands: /hello template drove the turn"; else bad "commands: no HELLO_MARKER"; fi
if wait_for '✓ turn' 60; then ok "statusline: turn counter"; else bad "statusline: no turn segment"; fi

type_prompt "Two questions. 1: What is the codeword in the imported context? 2: What marker does the CLAUDE.local.md section contain? Answer both."
if wait_for 'ZANZIBAR' 200; then ok "context-imports: @import content reached the model"; else bad "context-imports: codeword missing"; fi
# The codeword streams before the second answer; keep waiting for the marker.
if wait_for 'PERSONAL LOCAL NOTE MARKER' 60; then ok "context-imports: CLAUDE.local.md loaded"; else bad "context-imports: local marker missing"; fi

type_prompt "Call the e2e_ping tool now and repeat its output verbatim."
if wait_for 'E2EPONG' 200; then ok "mcp: model called the MCP tool"; else bad "mcp: no E2EPONG"; fi

type_prompt "Run this exact bash command: echo FORBIDDEN_MARKER"
if wait_for 'BLOCKED_BY_E2E_HOOK' 200; then ok "hooks: PreToolUse blocked with its reason"; else bad "hooks: block reason missing"; fi

type_prompt "Use the memory tool with action save, name wraptest, description e2e check, content MEMCONTENT_XYZ. Do nothing else."
if wait_file "$HOME/.pi/agent/memory/$SLUG/wraptest.md" 200 && grep -q 'MEMCONTENT_XYZ' "$HOME/.pi/agent/memory/$SLUG/wraptest.md"; then
  ok "memory: save wrote the memory file on disk"
else
  bad "memory: no memory file for $SLUG"
fi

type_prompt "Use the web_fetch tool on https://example.com and quote the page heading."
if wait_for 'Example Domain' 200; then ok "web: web_fetch returned real page text"; else bad "web: no Example Domain"; fi

type_prompt "Use the question tool to ask me to choose between alpha and beta. Then just acknowledge my choice."
if wait_for 'Enter to select' 200; then
  ok "question: overlay opened"
  sleep 1
  send Enter
  # The picked option renders as "✓ 1. alpha" in the tool result.
  if wait_for '✓ 1\. alpha' 60; then ok "question: selection returned to the model"; else bad "question: no selection result"; fi
else
  bad "question: overlay missing"
fi

type_prompt "Use the todo tool to add two todos for testing, then use the start action on the first. Do nothing else."
if wait_for 'Todos \(' 240; then ok "todo: overlay rendered"; else bad "todo: no overlay"; fi

type_prompt "Replace the entire content of the file data.txt with the single word MODIFIED. Use the write tool. Do nothing else."
deadline=$(($(date +%s) + 200))
while (($(date +%s) < deadline)); do grep -q MODIFIED "$FX/data.txt" 2>/dev/null && break; sleep 2; done
if grep -q MODIFIED "$FX/data.txt" 2>/dev/null; then
  ok "checkpoint: model modified data.txt"
  printf 'created after the checkpoint\n' > "$FX/probe-new.txt"
  sleep 3
  send "/rewind" Enter
  if wait_for 'Rewind to checkpoint' 20; then
    send Enter
    if wait_for 'Code only' 20; then
      send Down Down Enter
      sleep 5
      if grep -q ORIGINAL "$FX/data.txt"; then ok "checkpoint: code-only restore reverted data.txt"; else bad "checkpoint: data.txt not reverted"; fi
      if [ -f "$FX/probe-new.txt" ]; then ok "checkpoint: later file survives restore (overlay semantics)"; else bad "checkpoint: restore deleted a later file"; fi
    else
      bad "checkpoint: restore mode menu missing"
    fi
  else
    bad "checkpoint: picker missing"
  fi
else
  bad "checkpoint: model never modified data.txt"
fi

type_prompt "Use the subagent tool with agentScope set to both, agent echoer, and this task: reply with the word SUBAGENT_OK."
if wait_for 'project agent|Source:' 200; then
  ok "subagent: consent prompt for project agent"
  sleep 1
  send Enter
else
  bad "subagent: no consent prompt"
fi
if wait_for 'SUBAGENT_OK' 280; then ok "subagent: child pi ran and reported back"; else bad "subagent: no SUBAGENT_OK"; fi

send "/plan" Enter
sleep 2
type_prompt "Create a two step plan for adding an FAQ section to the README, then call the plan_mode_complete tool with the numbered plan."
if wait_for 'Plan mode - what next|Plan Steps' 240; then
  ok "plan-mode: plan_mode_complete reached the review prompt"
  sleep 1
  send Down Enter
  sleep 2
else
  bad "plan-mode: review prompt missing"
fi
send "/plan" Enter
sleep 2

# --- Second session: persistence checks -----------------------------------------------
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$FX" "pi"
if wait_for '\[Extensions\]' 40; then ok "trust: stored decision honored on re-boot"; else bad "trust: re-boot failed"; fi
# Known pi TUI interaction: this banner renders standalone but not always in the full
# extension load; the memory feature itself is asserted above via the on-disk file.
if wait_for 'Memory: 1 memories loaded' 20; then ok "memory: index banner on next session"; else warn "memory: index banner not rendered (known pi TUI interaction)"; fi

print ""
print "e2e-full finished: $PASS passed, $FAIL failed, $WARN warned"
exit $((FAIL > 0))
