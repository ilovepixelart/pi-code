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

# Two depths: capture() is the CURRENT screen, for state checks (badges,
# status segments) where scrollback would resurrect stale frames; capture_all()
# adds scrollback, for marker searches where a verbose reply can scroll a
# marker past the visible rows between 2s polls.
capture() { tmux capture-pane -t "$SESSION" -p }
capture_all() { tmux capture-pane -t "$SESSION" -p -S -200 }
send() { tmux send-keys -t "$SESSION" "$@" }
type_prompt() { tmux send-keys -t "$SESSION" -l "$1"; tmux send-keys -t "$SESSION" Enter }

wait_for() { # wait_for <regex> <timeout-seconds>: appearance searches include scrollback
  local deadline=$(($(date +%s) + $2))
  while (($(date +%s) < deadline)); do
    if capture_all | grep -qE "$1"; then return 0; fi
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

wait_for_absent() { # wait_for_absent <regex> <timeout-seconds>: poll until the pane no longer matches
  local deadline=$(($(date +%s) + $2))
  while (($(date +%s) < deadline)); do
    capture | grep -qE "$1" || return 0
    sleep 2
  done
  return 1
}

# --- Fixture: a project exercising every .claude surface ------------------------------
FX=$(mktemp -d)
FX=$(cd "$FX" && pwd -P)

# Installed before anything else exists so an abort at any point cleans up. zsh
# runs no EXIT trap on an untrapped INT/TERM, and a Ctrl-C mid-model-turn would
# otherwise leave a live pi burning the account plus both temp trees; the signal
# traps clean up and re-raise so the exit status stays signal-shaped.
cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null
  rm -rf ${FAKEHOME:+"$FAKEHOME"} "$FX"
}
trap cleanup EXIT
trap 'cleanup; trap - INT; kill -INT $$' INT
trap 'cleanup; trap - TERM; kill -TERM $$' TERM
git -C "$FX" init -qb main
git -C "$FX" -c user.name=e2e -c user.email=e2e@local commit -q --allow-empty -m init
mkdir -p "$FX/.claude/rules" "$FX/.claude/commands" "$FX/.claude/skills/greet" "$FX/.claude/output-styles" "$FX/.claude/agents" "$FX/notes"
printf -- '- Tests must be deterministic.\n' > "$FX/.claude/rules/testing.md"
printf 'Reply with exactly the word HELLO_MARKER and nothing else.\n' > "$FX/.claude/commands/hello.md"
printf 'Reply with exactly the word SLASHTOOL_MARKER and nothing else.\n' > "$FX/.claude/commands/slashtool.md"
printf -- '---\nname: greet\ndescription: Greets people for the e2e test\n---\nWhen this skill runs, reply with exactly the word GREET_SKILL_MARKER and nothing else.\n' > "$FX/.claude/skills/greet/SKILL.md"
# A tone-only style that still codes keeps the coding instructions, per Claude's docs;
# without the flag the new replace semantics would strip tool guidance mid-suite.
printf -- '---\nname: Pirate\ndescription: e2e style\nkeep-coding-instructions: true\n---\nYou may speak like a pirate.\n' > "$FX/.claude/output-styles/pirate.md"
printf '{"outputStyle": "Pirate"}\n' > "$FX/.claude/settings.local.json"
cat > "$FX/.claude/settings.json" <<'EOF'
{
  "env": { "E2E_ENV_MARKER": "ENVWIRE_ABC" },
  "hooks": {
    "SessionStart": [{ "hooks": [{ "command": "touch .e2e-session-start" }] }],
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "command": "if grep -q FORBIDDEN_MARKER; then echo BLOCKED_BY_E2E_HOOK >&2; exit 2; fi" }] }]
  }
}
EOF
printf 'Project context for the e2e run.\n\n@notes/extra.md\n' > "$FX/CLAUDE.md"
printf 'The codeword is ZANZIBAR.\n' > "$FX/notes/extra.md"
printf 'PERSONAL LOCAL NOTE MARKER\n' > "$FX/CLAUDE.local.md"
# The marker lives ONLY in the agent body, never in the typed prompt: the prompt
# echoes into the pane as the rendered user message, so a prompt-carried marker
# would green the check before (and regardless of whether) the child pi ran.
printf -- '---\nname: echoer\ndescription: Replies with its fixed marker word\n---\nWhatever the task says, reply with exactly the word SUBAGENT_OK and nothing else.\n' > "$FX/.claude/agents/echoer.md"
printf 'ORIGINAL\n' > "$FX/data.txt"
printf 'node_modules\n' > "$FX/.gitignore"
ln -s "$REPO/node_modules" "$FX/node_modules"
cat > "$FX/mcp-server.mjs" <<'EOF'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'e2e', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'ping', description: 'Health check; always replies with the marker E2EPONG', inputSchema: { type: 'object', properties: {} } }],
}))
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'E2EPONG' }] }))
// prompts capability: the extension registers this prompt as the /mcp__e2e__greet slash
// command; its returned message is sent as a user message, driving a marker turn.
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: 'greet', description: 'e2e greeting prompt that drives a marker turn' }],
}))
server.setRequestHandler(GetPromptRequestSchema, async () => ({
  messages: [{ role: 'user', content: { type: 'text', text: 'Reply with exactly the word GREET_PROMPT_MARKER and nothing else.' } }],
}))
// resources capability: one text resource, reachable through the global
// list_mcp_resources / read_mcp_resource tools the extension registers.
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: 'e2e://greeting', name: 'greeting', mimeType: 'text/plain', description: 'e2e text resource' }],
}))
server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'MCP_RESOURCE_MARKER' }],
}))
await server.connect(new StdioServerTransport())
EOF
printf '{"mcpServers": {"e2e": {"command": "node", "args": ["mcp-server.mjs"]}}}\n' > "$FX/.mcp.json"

# Mirrors projectSlug in extensions/memory.ts: readable dashed path + sha256 prefix.
SLUG=$(python3 -c "
import hashlib, sys
cwd = sys.argv[1]
readable = cwd.replace('/', '-').replace('\\\\', '-')
while readable.startswith('--'):
    readable = readable[1:]
print(f'{readable}-{hashlib.sha256(cwd.encode()).hexdigest()[:8]}')
" "$FX")

# --- Isolated HOME --------------------------------------------------------------------
# The developer's global config would otherwise ride into every prompt (observed: the
# real ~/.claude.json MCP servers alone pushed 97 tools and 104KB into a 128KB payload),
# destabilizing the model checks and delaying boot on failing servers. Only model access
# and this checkout are copied in; trust, memory and checkpoints land in the throwaway
# home, so no developer state needs snapshotting or restoring.
FAKEHOME=$(mktemp -d)
mkdir -p "$FAKEHOME/.pi/agent"
for f in auth.json models.json models-store.json; do
  [ -f "$HOME/.pi/agent/$f" ] && cp "$HOME/.pi/agent/$f" "$FAKEHOME/.pi/agent/$f"
done
# A wire probe records the exact provider payload of each request, giving the context
# checks a deterministic oracle: what the model was actually sent, not what it recalls.
WIRE="$FAKEHOME/wire.json"
# The committed probe (also used by the headless smoke) appends one JSON line
# per request, so a later request cannot clobber the payload under test.
cp "$REPO/scripts/lib/wire-probe.ts" "$FAKEHOME/wire-probe.ts"
# Allowlist, not denylist: only the model-selection keys ride in from the real
# settings. Copying everything minus a strip list let any other developer key (a
# global statusLine, hooks, timeout tuning) shape the "isolated" run; a fresh
# home also means no stale lastChangelogVersion, so no changelog wall over boot.
python3 - "$HOME/.pi/agent/settings.json" "$FAKEHOME/.pi/agent/settings.json" "$REPO" "$FAKEHOME/wire-probe.ts" <<'PY'
import json, sys
src, dst, repo, probe = sys.argv[1:5]
try:
    real = json.load(open(src))
except Exception:
    real = {}
settings = {key: real[key] for key in ("defaultModel", "defaultProvider") if key in real}
settings["packages"] = [repo]
settings["defaultThinkingLevel"] = "low"
settings["extensions"] = [probe]
json.dump(settings, open(dst, "w"))
PY

# This harness only means anything if pi is loading THIS checkout. A developer with a
# published pi-code installed would otherwise get a green run for the wrong code.
if ! HOME="$FAKEHOME" PI_SKIP_VERSION_CHECK=1 pi list 2>/dev/null | grep -qF "$REPO"; then
  say "%F{red}pi under the isolated home is not loading this checkout ($REPO)%f"
  exit 2
fi

# Project trust is the gate for every project-scoped .claude surface. pi-code's
# project-approval extension reads it through ctx.isProjectTrusted(), which pi only exposes
# from 0.79.1 on. On an older runtime that callback is undefined, so isProjectApproved()
# short-circuits to "unapproved": the "Trust this project?" prompt never appears and none of
# the project rules, hooks, MCP servers, output styles, project agents, context imports,
# skills or commands load. pi 0.75.0+ needs Node >= 22.19.0, so a stuck-on-Node-22.18 box is
# pinned to 0.74.x and will fail every trust-gated beat below. Warn loudly rather than let the
# cascade read like a harness bug.
# pi prints --version to stderr, so capture both streams before parsing.
PI_VERSION=$(pi --version 2>&1 | tr -d '[:space:]')
autoload -Uz is-at-least
if [ -z "$PI_VERSION" ] || ! is-at-least 0.79.1 "$PI_VERSION"; then
  warn "pi ${PI_VERSION:-unknown} predates ctx.isProjectTrusted() (pi 0.79.1); every project-trust-gated beat will FAIL until pi >= 0.79.1 (needs Node >= 22.19.0)"
fi

say "fixture: $FX"

# The tmux server keeps its own environment: an inherited PI_CODING_AGENT_DIR or
# CLAUDE_CONFIG_DIR would point pi inside the "isolated" home at the real config
# (the scripted trust-approve would then write the real trust store), and PATH
# drift could boot a different pi than the one the guards above validated.
PI_BIN=$(command -v pi)
BOOT_CMD="env -u PI_CODING_AGENT_DIR -u CLAUDE_CONFIG_DIR HOME=$FAKEHOME PI_E2E_WIRE=$WIRE PI_SKIP_VERSION_CHECK=1 $PI_BIN"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$FX" "$BOOT_CMD"

# --- Deterministic checks -------------------------------------------------------------
if wait_for 'Trust this project\?' 30; then
  ok "trust: prompted for the claude-shaped fixture"
  send Enter
else
  bad "trust: no approval prompt"
fi

# pi 0.81 flushes the resource block only after session_start handlers complete,
# which serial MCP connect timeouts can push well past an eager window.
# Two independent greps, not a fixed -A window: the extension block grows with
# every added extension and a clipped window false-FAILs at exactly the count
# that pushes an entry out of it.
if wait_for '\[Extensions\]' 120 && capture_all | grep -q 'todo.ts'; then
  ok "boot: extensions loaded"
else
  bad "boot: extensions missing"
fi

# Known pi TUI interaction: on a fast boot pi drops all but the last session_start
# notify() banner (reproduced with only this checkout loaded). One consistent rule:
# every individual banner is a warn (which banner survives is ordering luck; the
# old scheme hard-failed output-style only because it happened to be last), and
# ONE bad check requires that at least one banner rendered at all, so a
# regression silencing the whole notify path cannot hide behind the warns.
# Features are asserted on substance elsewhere: rules/imports on the wire, MCP by
# the /mcp turn, memory by the on-disk file.
if wait_for 'Rules loaded: global (yes|no), project 1' 20; then ok "rules: project rule counted"; else warn "rules: banner not rendered (known pi TUI interaction)"; fi
if wait_for 'Output style: Pirate' 15; then ok "output-style: active style announced"; else warn "output-style: banner not rendered (known pi TUI interaction)"; fi
if wait_for 'MCP: ' 30; then ok "mcp: connect summary banner"; else warn "mcp: summary banner not rendered (known pi TUI interaction)"; fi
if capture_all | grep -qE 'Rules loaded: |Output style: |MCP: '; then ok "boot: at least one session-start banner rendered"; else bad "boot: notify path rendered no banner at all"; fi
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
if wait_for_absent '⏸ plan' 20; then ok "plan-mode: badge off"; else bad "plan-mode: badge stuck"; fi

send "/rewind" Enter
if wait_for 'No checkpoints recorded yet' 15; then ok "checkpoint: empty-session notice"; else bad "checkpoint: no empty notice"; fi

# The /hooks viewer resolves the settings chain; the fixture's PreToolUse guard (its
# command carries FORBIDDEN_MARKER) must show under the PreToolUse heading. This runs
# before the FORBIDDEN_MARKER model turn below, so the match cannot be a stale echo.
send "/hooks" Enter
if wait_for 'PreToolUse:' 15 && capture | grep -q 'FORBIDDEN_MARKER'; then ok "hooks: /hooks viewer shows the PreToolUse guard"; else bad "hooks: /hooks viewer missing the guard"; fi

# The fixture ships a project agent, so /agents must list it with its file path.
send "/agents" Enter
if wait_for 'echoer - ' 15; then ok "agents: /agents lists the project agent"; else bad "agents: echoer missing from the listing"; fi

# --- Model turns ----------------------------------------------------------------------
type_prompt "/hello"
if wait_for 'HELLO_MARKER' 200; then ok "commands: /hello template drove the turn"; else bad "commands: no HELLO_MARKER"; fi
if wait_for '✓ turn' 60; then ok "statusline: turn counter"; else bad "statusline: no turn segment"; fi

# After a completed turn /context has usage to report.
send "/context" Enter
if wait_for 'Context usage' 15; then ok "context: /context renders usage"; else bad "context: no usage output"; fi

# The wire dump written during the /hello turn is the ground truth for context
# injection: the exact payload the provider received, independent of model recall
# (which proved unreliable in both directions as the prompt and thinking level varied).
if wait_file "$WIRE" 20 && grep -q 'ZANZIBAR' "$WIRE"; then ok "context-imports: @import content on the wire"; else bad "context-imports: import missing from payload"; fi
if grep -q 'PERSONAL LOCAL NOTE MARKER' "$WIRE" 2>/dev/null; then ok "context-imports: CLAUDE.local.md on the wire"; else bad "context-imports: local marker missing from payload"; fi
# The fixture rule (.claude/rules/testing.md) carries no `paths:` frontmatter, so claude-rules
# inlines its body into the system prompt rather than surfacing a scoped pointer. Assert the
# injected body on the wire, like the two import checks above; the filename never rides along.
if grep -q 'Tests must be deterministic' "$WIRE" 2>/dev/null; then ok "rules: project rule on the wire"; else bad "rules: project rule missing from payload"; fi
# The skills PLUMBING is deterministic even though the invocation below is
# model-dependent: the available_skills listing with the fixture skill must
# reach the provider payload, so a discovery regression fails here instead of
# hiding behind the model-declined warn.
if grep -q 'available_skills' "$WIRE" 2>/dev/null && grep -q 'greet' "$WIRE" 2>/dev/null; then ok "skills: listing reaches the wire"; else bad "skills: available_skills/greet missing from payload"; fi

type_prompt "Call the e2e_ping tool now and repeat its output verbatim."
if wait_for 'E2EPONG' 200; then ok "mcp: model called the MCP tool"; else bad "mcp: no E2EPONG"; fi

type_prompt "Run this exact bash command: echo FORBIDDEN_MARKER"
if wait_for 'BLOCKED_BY_E2E_HOOK' 200; then ok "hooks: PreToolUse blocked with its reason"; else bad "hooks: block reason missing"; fi

# env-settings: the fixture's settings env must reach tool subprocesses. The
# typed prompt carries the variable NAME unexpanded, so the value can only
# appear through real execution.
type_prompt "Run this exact bash command: echo marker is \$E2E_ENV_MARKER"
if wait_for 'marker is ENVWIRE_ABC' 200; then ok "env-settings: settings env reached the bash tool"; else bad "env-settings: ENVWIRE_ABC missing"; fi

type_prompt "Use the memory tool with action save, name wraptest, description e2e check, content MEMCONTENT_XYZ. Do nothing else."
if wait_file "$FAKEHOME/.pi/agent/memory/$SLUG/wraptest.md" 200 && grep -q 'MEMCONTENT_XYZ' "$FAKEHOME/.pi/agent/memory/$SLUG/wraptest.md"; then
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
      # Wait for the completion notice instead of a fixed sleep; a slow restore
      # made the file assertions race the checkout.
      wait_for 'Rewind complete|Code restored' 30 || true
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

# The marker must never appear in the typed prompt: the prompt echoes into the
# pane as the rendered user message, which once made this check unable to fail.
# The echoer agent's BODY carries SUBAGENT_OK, so the pane can only show it when
# the child pi actually loaded the project agent and ran. The self-check makes
# that property mechanical for future edits.
SUBAGENT_PROMPT="Use the subagent tool with agentScope set to both, agent echoer, and this task: follow your instructions exactly."
case "$SUBAGENT_PROMPT" in *SUBAGENT_OK*) bad "self-check: subagent prompt must not carry the marker" ;; esac
type_prompt "$SUBAGENT_PROMPT"
if wait_for 'project agent|Source:' 200; then
  ok "subagent: consent prompt for project agent"
  sleep 1
  send Enter
else
  bad "subagent: no consent prompt"
fi
if wait_for 'SUBAGENT_OK' 280; then ok "subagent: child pi ran and reported back"; else bad "subagent: no SUBAGENT_OK"; fi

# --- MCP prompts/resources, slash_command, skills, background tasks --------------------
# The fixture MCP server also advertises the prompts and resources capabilities. The
# extension exposes the greet prompt as /mcp__e2e__greet, whose returned message is sent
# as a user message and drives the marker turn (the marker rides in on that message, so
# it appears only when the prompt was actually fetched).
type_prompt "/mcp__e2e__greet"
if wait_for 'GREET_PROMPT_MARKER' 200; then ok "mcp-prompts: prompt command drove a turn"; else bad "mcp-prompts: no GREET_PROMPT_MARKER"; fi

# The resources capability registers the global list_mcp_resources / read_mcp_resource
# tools; the marker only surfaces if the model lists then reads the fixture resource.
type_prompt "List MCP resources with the list_mcp_resources tool, then read the first one with the read_mcp_resource tool and quote its text verbatim."
if wait_for 'MCP_RESOURCE_MARKER' 240; then ok "mcp-resources: model listed and read the resource"; else bad "mcp-resources: no MCP_RESOURCE_MARKER"; fi

# The slash_command tool expands a discovered custom command into its own tool result;
# /slashtool carries a marker distinct from /hello so an earlier turn cannot false-green.
type_prompt "Use the slash_command tool to run /slashtool. Do nothing else."
if wait_for 'SLASHTOOL_MARKER' 200; then ok "slash-command: slash_command tool expanded /slashtool"; else bad "slash-command: no SLASHTOOL_MARKER"; fi

# The greet skill's body instructs the marker, so it appears only when the model actually
# invokes the skill pi surfaced from .claude/skills. Wire-verified 2026-09-02: the
# <available_skills> listing (name, description, location) reaches the request and
# the read tool is present, so a miss here is the local test model declining the
# affordance (gpt-oss:20b skips it even when told "use the greet skill"), not a
# plumbing defect. Model-dependent: a warn, not a failure.
type_prompt "Use the greet skill now."
if wait_for 'GREET_SKILL_MARKER' 200; then ok "skills: model invoked the greet skill"; else warn "skills: model declined the greet skill (listing wire-verified present; model-capability dependent)"; fi

# A background subagent returns a run id immediately; /tasks then lists it without
# interrupting. general-purpose is builtin, so no project-agent consent prompt fires.
type_prompt "Use the subagent tool with background true, agent general-purpose, and task: print the exact word BGTASK_MARKER. Do nothing else."
if wait_for 'Started background run' 200; then
  ok "subagent: background run started"
  sleep 2
  send "/tasks" Enter
  if wait_for 'general-purpose: (running|done)' 30; then ok "tasks: /tasks lists the background run"; else bad "tasks: no background run entry"; fi
  # 'running' alone proved only registration: a child that hangs or crashes
  # after registering still listed as running. Re-poll /tasks until it reports
  # done, so the check covers actual execution to completion.
  finished=0
  for attempt in 1 2 3 4 5 6 7 8; do
    if capture_all | grep -qE 'general-purpose: done'; then finished=1; break; fi
    sleep 15
    send "/tasks" Enter
    sleep 3
  done
  if ((finished)); then ok "tasks: background run ran to completion"; else bad "tasks: background run never reached done"; fi
else
  bad "subagent: background run did not start"
fi

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

# /init sends the analysis prompt as a user message; the deterministic part is
# that prompt reaching the conversation. Escape cancels the model turn so the
# suite does not pay for a full codebase analysis.
send "/init" Enter
if wait_for 'AGENTS.md' 20; then ok "init: /init sent the analysis prompt"; else bad "init: no analysis prompt"; fi
send Escape
sleep 2

# --- Second session: persistence checks -----------------------------------------------
# A custom statusLine command replaces the built-in ready/turn segments the first session
# asserts, so it is added only now, for the re-boot below. Editing the project settings
# does not disturb the stored trust decision (keyed on the path, not the file contents).
python3 - "$FX/.claude/settings.json" <<'PY'
import json, sys
path = sys.argv[1]
settings = json.load(open(path))
settings["statusLine"] = {"type": "command", "command": "echo STATUS_E2E"}
json.dump(settings, open(path, "w"))
PY

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$FX" "$BOOT_CMD"
if wait_for '\[Extensions\]' 120; then ok "trust: stored decision honored on re-boot"; else bad "trust: re-boot failed"; fi
# The statusLine command runs on the first status refresh after boot; its output replaces
# the built-in segment, so STATUS_E2E in the pane proves the configured command drove it.
if wait_for 'STATUS_E2E' 30; then ok "statusline: custom statusLine command output rendered"; else bad "statusline: no STATUS_E2E segment"; fi
# Known pi TUI interaction: this banner renders standalone but not always in the full
# extension load; the memory feature itself is asserted above via the on-disk file.
if wait_for 'Memory: 1 memories loaded' 20; then ok "memory: index banner on next session"; else warn "memory: index banner not rendered (known pi TUI interaction)"; fi

print ""
print "e2e-full finished: $PASS passed, $FAIL failed, $WARN warned"
exit $((FAIL > 0))
