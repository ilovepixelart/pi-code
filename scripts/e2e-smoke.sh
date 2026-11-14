#!/usr/bin/env bash
# Headless deterministic e2e smoke: boots the pi devDependency against an
# isolated home whose model points at a dead port, and asserts the exact
# provider payload captured by scripts/lib/wire-probe.ts. No tmux, no model,
# no network: before_provider_request fires before the transport acts, so the
# payload exists even though the request itself fails (pi's nonzero exit is
# expected). Runs anywhere `npm ci` has run, including CI.
# Usage: scripts/e2e-smoke.sh
set -uo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
PI_BIN="$REPO/node_modules/.bin/pi"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }

# Under Git Bash on Windows, node reads C:/... paths and takes its home from USERPROFILE,
# not HOME: every path handed to pi or node as data goes through native(). bash's own
# file operations keep the POSIX form.
native() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

SMOKE=$(mktemp -d)
cleanup() { rm -rf "$SMOKE"; }
trap cleanup EXIT
trap 'cleanup; trap - INT; kill -INT $$' INT
trap 'cleanup; trap - TERM; kill -TERM $$' TERM

[ -x "$PI_BIN" ] || { printf 'FAIL smoke: %s missing; run npm ci first\n' "$PI_BIN"; exit 1; }

# --- Fixture: the context surfaces whose payload injection is deterministic ---
FX="$SMOKE/fx"
mkdir -p "$FX/.claude/rules" "$FX/.claude/skills/greet" "$FX/notes"
# Resolved path: the trust key must match the cwd pi sees (on macOS mktemp
# hands out /var/... while processes resolve /private/var/...).
FX=$(cd "$FX" && pwd -P)
git -C "$FX" init -qb main 2>/dev/null
printf 'Project context for the smoke.\n\n@notes/extra.md\n' > "$FX/CLAUDE.md"
printf 'The codeword is ZANZIBAR.\n' > "$FX/notes/extra.md"
printf 'PERSONAL LOCAL NOTE MARKER\n' > "$FX/CLAUDE.local.md"
printf -- '- Tests must be deterministic.\n' > "$FX/.claude/rules/testing.md"
printf -- '---\nname: greet\ndescription: Greets people for the smoke\n---\nReply with a greeting.\n' > "$FX/.claude/skills/greet/SKILL.md"

# --- Isolated home: dead-port model, the committed probe, pre-seeded trust ---
HOMEDIR="$SMOKE/home"
mkdir -p "$HOMEDIR/.pi/agent"
WIRE="$HOMEDIR/wire.jsonl"
# Trust goes through pi's own store, run from the fixture, so its key is the one pi
# resolves for that cwd on every platform. Pre-seeded because headless -p has no dialog,
# and untrusted projects load no project-scoped config, which is most of what this asserts.
# The MCP servers are user-scope stdio: on a pi with native MCP (pi.registerMcpServer, pi
# 0.99 and later) pi-code hands them to pi. smoke is deferred behind tool_search, as Claude
# defers MCP tools by default, so pi lists it in mcp_servers instead of declaring
# mcp__smoke__echo; loaded sets alwaysLoad and is declared upfront. Older pi gets pi-code's
# own smoke_echo.
(cd "$FX" && node --input-type=module - "$(native "$HOMEDIR")" "$(native "$REPO")" <<'JS'
import * as fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const [home, repo] = process.argv.slice(2)
const agent = `${home}/.pi/agent`
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value))
write(`${agent}/models.json`, { providers: { dead: { api: 'openai-completions', apiKey: 'dead-key', baseUrl: 'http://127.0.0.1:1/v1', models: [{ contextWindow: 131072, id: 'dead-model', input: ['text'] }] } } })
write(`${agent}/settings.json`, { packages: [repo], defaultModel: 'dead-model', defaultProvider: 'dead', defaultThinkingLevel: 'off', extensions: [`${repo}/scripts/lib/wire-probe.ts`] })
const echo = { type: 'stdio', command: 'node', args: [`${repo}/scripts/lib/mcp-echo-server.mjs`] }
write(`${home}/.claude.json`, { mcpServers: { smoke: echo, loaded: { ...echo, alwaysLoad: true } } })
const plugin = `${home}/.claude/plugins/cache/smoke/smoke-kit/1.0.0`
fs.mkdirSync(`${plugin}/.claude-plugin`, { recursive: true })
fs.mkdirSync(`${plugin}/skills/deploy`, { recursive: true })
fs.mkdirSync(`${plugin}/skills/guide`, { recursive: true })
write(`${plugin}/.claude-plugin/plugin.json`, { name: 'smoke-kit' })
write(`${home}/.claude/settings.json`, { enabledPlugins: { 'smoke-kit@smoke': true } })
fs.writeFileSync(`${plugin}/skills/deploy/SKILL.md`, '---\nname: deploy\ndescription: SMOKE USER ONLY DESCRIPTION\ndisable-model-invocation: true\n---\nSMOKE PLUGIN BODY $ARGUMENTS\n${CLAUDE_PLUGIN_ROOT}\n')
fs.writeFileSync(`${plugin}/skills/guide/SKILL.md`, '---\nname: guide\ndescription: SMOKE MODEL SKILL DESCRIPTION\n---\nGuide the user.\n')
const { ProjectTrustStore } = await import(pathToFileURL(`${repo}/node_modules/@earendil-works/pi-coding-agent/dist/index.js`).href)
new ProjectTrustStore(agent).set(process.cwd(), true)
JS
)
if grep -q 'registerMcpServer' "$REPO/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts" 2>/dev/null; then MCP_TOOL=mcp__smoke__echo; else MCP_TOOL=smoke_echo; fi

run_pi() {
  (cd "$FX" && env -u PI_CODING_AGENT_DIR -u CLAUDE_CONFIG_DIR HOME="$(native "$HOMEDIR")" USERPROFILE="$(native "$HOMEDIR")" PI_E2E_WIRE="$(native "$WIRE")" PI_SKIP_VERSION_CHECK=1 perl -e 'alarm 150; exec @ARGV' "$@" < /dev/null)
}

# --- Discovery: pi under the isolated home loads THIS checkout ---
# pi prints the native path, with backslashes on Windows.
if run_pi "$PI_BIN" list 2>/dev/null | tr '\\' '/' | grep -qiF "$(native "$REPO")"; then ok "smoke: pi list discovers this checkout"; else bad "smoke: pi list does not load $REPO"; fi

# --- One headless turn; the connection error afterwards is expected ---
run_pi "$PI_BIN" -p "hi" > "$SMOKE/pi-out.log" 2>&1
[ -s "$WIRE" ] && ok "smoke: wire probe captured the provider payload" || bad "smoke: no wire payload captured (pi output: $(tail -1 "$SMOKE/pi-out.log" 2>/dev/null))"

wire_has() { grep -q "$1" "$WIRE" 2>/dev/null; }
if wire_has 'ZANZIBAR'; then ok "smoke: @import chain content on the wire"; else bad "smoke: import content missing from payload"; fi
if wire_has 'PERSONAL LOCAL NOTE MARKER'; then ok "smoke: CLAUDE.local.md on the wire"; else bad "smoke: local marker missing from payload"; fi
if wire_has 'Tests must be deterministic'; then ok "smoke: project rule on the wire"; else bad "smoke: project rule missing from payload"; fi
if wire_has 'available_skills' && wire_has 'greet'; then ok "smoke: skills listing on the wire"; else bad "smoke: skills listing missing from payload"; fi
if wire_has 'plugin_skill' && wire_has '/smoke-kit:guide'; then ok "smoke: plugin skill listed with its namespace"; else bad "smoke: namespaced plugin skill missing"; fi
if wire_has 'SMOKE USER ONLY DESCRIPTION'; then bad "smoke: user-only plugin skill offered to model"; else ok "smoke: user-only plugin skill kept out of model listing"; fi
if [ "$MCP_TOOL" = smoke_echo ]; then
  if wire_has '"smoke_echo"'; then ok "smoke: MCP server tool declared as smoke_echo"; else bad "smoke: MCP tool smoke_echo missing from payload"; fi
else
  if wire_has '"tool_search"' && wire_has 'mcp__smoke (tool_search)'; then ok "smoke: deferred MCP server listed for tool_search"; else bad "smoke: deferred MCP server not listed in mcp_servers, or tool_search not declared"; fi
  if wire_has '"mcp__smoke__echo"'; then bad "smoke: deferred MCP tool mcp__smoke__echo declared upfront"; else ok "smoke: deferred MCP tool not declared upfront"; fi
  if wire_has '"mcp__loaded__echo"'; then ok "smoke: alwaysLoad MCP tool declared as mcp__loaded__echo"; else bad "smoke: alwaysLoad MCP tool mcp__loaded__echo missing from payload"; fi
fi
if grep -q 'builtin:mcp' "$SMOKE/pi-out.log"; then bad "smoke: pi reports pi-code replacing its built-in MCP"; else ok "smoke: no built-in MCP replacement warning"; fi

# A registered plugin command must send the expanded skill, not raw slash input. RPC
# keeps the session alive while the fire-and-forget command drives its own agent turn;
# older pi print mode exits as soon as an extension command's handler returns.
WIRE="$HOMEDIR/wire-plugin.jsonl"
run_pi node --input-type=module -e '
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
const packageRoot = join(process.argv[1], "node_modules/@earendil-works/pi-coding-agent")
const cli = join(packageRoot, JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).bin.pi)
const child = spawn(process.execPath, [cli, "--mode", "rpc"], { stdio: ["pipe", "pipe", "inherit"] })
let buffer = ""
let finished = false
const deadline = setTimeout(() => child.kill("SIGTERM"), 120000)
child.stdout.on("data", (chunk) => {
  buffer += chunk
  const lines = buffer.split("\n")
  buffer = lines.pop()
  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === "agent_end") {
      finished = true
      child.kill("SIGTERM")
    }
  }
})
child.on("error", () => { clearTimeout(deadline); process.exitCode = 1 })
child.on("exit", () => { clearTimeout(deadline); process.exitCode = finished ? 0 : 1 })
child.stdin.write(JSON.stringify({ type: "prompt", message: "/smoke-kit:deploy prod" }) + "\n")
' "$(native "$REPO")" > "$SMOKE/pi-plugin.log" 2>&1
if wire_has 'SMOKE PLUGIN BODY prod'; then ok "smoke: plugin command expands its body and arguments"; else bad "smoke: plugin command body missing (pi output: $(tail -1 "$SMOKE/pi-plugin.log" 2>/dev/null))"; fi
if wire_has 'CLAUDE_PLUGIN_ROOT'; then bad "smoke: plugin root variable was not expanded"; else ok "smoke: plugin root variable expanded"; fi

# The explicit skill prefix also works in print mode, where older pi versions return
# before a registered extension command's fire-and-forget prompt has started.
WIRE="$HOMEDIR/wire-plugin-print.jsonl"
run_pi "$PI_BIN" -p "/skill:smoke-kit:deploy staging" > "$SMOKE/pi-plugin-print.log" 2>&1
if wire_has 'SMOKE PLUGIN BODY staging'; then ok "smoke: qualified skill input expands in print mode"; else bad "smoke: qualified skill input missing in print mode"; fi

# --- A freshly cloned project nobody was asked about, headless: no prompt can approve it ---
# pi itself still loads its CLAUDE.md, and an import inside the project is only more of
# what the repository ships; everything else project-scoped stays out.
UNTRUSTED="$SMOKE/untrusted"
mkdir -p "$UNTRUSTED/.claude/rules" "$UNTRUSTED/notes"
UNTRUSTED=$(cd "$UNTRUSTED" && pwd -P)
git -C "$UNTRUSTED" init -qb main 2>/dev/null
printf 'OUTSIDE THE PROJECT MARKER\n' > "$HOMEDIR/outside.md"
printf 'Untrusted project context.\n\n@notes/inside.md\n@%s/outside.md\n' "$(native "$HOMEDIR")" > "$UNTRUSTED/CLAUDE.md"
printf 'INSIDE THE PROJECT MARKER\n' > "$UNTRUSTED/notes/inside.md"
printf 'UNTRUSTED LOCAL MARKER\n' > "$UNTRUSTED/CLAUDE.local.md"
printf -- '- UNTRUSTED RULE MARKER\n' > "$UNTRUSTED/.claude/rules/rule.md"
# A project MCP server is the vector that runs a command; unapproved, it must never connect.
printf '{"mcpServers":{"proj":{"type":"stdio","command":"node","args":["%s/scripts/lib/mcp-echo-server.mjs"]}}}' "$(native "$REPO")" > "$UNTRUSTED/.mcp.json"
PROJ_TOOL="${MCP_TOOL/smoke/proj}"
WIRE="$HOMEDIR/wire-untrusted.jsonl"
FX="$UNTRUSTED" run_pi "$PI_BIN" -p "hi" > "$SMOKE/pi-untrusted.log" 2>&1
[ -s "$WIRE" ] || bad "smoke: no wire payload captured for the untrusted project (pi output: $(tail -1 "$SMOKE/pi-untrusted.log" 2>/dev/null))"
if wire_has 'Untrusted project context' && wire_has 'INSIDE THE PROJECT MARKER'; then ok "smoke: untrusted CLAUDE.md and its in-project import on the wire"; else bad "smoke: untrusted CLAUDE.md or its in-project import missing"; fi
# The refusal notice is the evidence the import was resolved and refused, not just absent.
if wire_has 'OUTSIDE THE PROJECT MARKER'; then bad "smoke: untrusted project imported a file outside it"; elif wire_has 'Imports not loaded (@)'; then ok "smoke: untrusted project's outside import refused, and the prompt says so"; else bad "smoke: no refusal notice for the untrusted project's outside import"; fi
if wire_has 'UNTRUSTED LOCAL MARKER'; then bad "smoke: untrusted CLAUDE.local.md on the wire"; else ok "smoke: untrusted CLAUDE.local.md kept out"; fi
if wire_has 'UNTRUSTED RULE MARKER'; then bad "smoke: untrusted project rule on the wire"; else ok "smoke: untrusted project rule kept out"; fi
# On native pi a registered server is declared (alwaysLoad) or listed in mcp_servers
# (deferred), so its mcp__proj namespace reaches the wire either way.
PROJ_MARK="${PROJ_TOOL%__echo}"
if wire_has "$PROJ_MARK"; then bad "smoke: untrusted project's MCP server registered ($PROJ_MARK on the wire)"; else ok "smoke: untrusted project's MCP server not registered"; fi

printf '\n'
printf 'e2e-smoke finished: %s passed, %s failed\n' "$PASS" "$FAIL"
exit $((FAIL > 0))
