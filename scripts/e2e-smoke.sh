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
# The MCP server is user-scope stdio: on a pi with native MCP (pi.registerMcpServer, pi
# 0.99 and later) pi-code hands it to pi, which declares it as mcp__smoke__echo; older pi
# gets pi-code's own smoke_echo.
(cd "$FX" && node --input-type=module - "$(native "$HOMEDIR")" "$(native "$REPO")" <<'JS'
import * as fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const [home, repo] = process.argv.slice(2)
const agent = `${home}/.pi/agent`
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value))
write(`${agent}/models.json`, { providers: { dead: { api: 'openai-completions', apiKey: 'dead-key', baseUrl: 'http://127.0.0.1:1/v1', models: [{ contextWindow: 131072, id: 'dead-model', input: ['text'] }] } } })
write(`${agent}/settings.json`, { packages: [repo], defaultModel: 'dead-model', defaultProvider: 'dead', defaultThinkingLevel: 'off', extensions: [`${repo}/scripts/lib/wire-probe.ts`] })
write(`${home}/.claude.json`, { mcpServers: { smoke: { type: 'stdio', command: 'node', args: [`${repo}/scripts/lib/mcp-echo-server.mjs`] } } })
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
if wire_has "\"$MCP_TOOL\""; then ok "smoke: MCP server tool declared as $MCP_TOOL"; else bad "smoke: MCP tool $MCP_TOOL missing from payload"; fi
if grep -q 'builtin:mcp' "$SMOKE/pi-out.log"; then bad "smoke: pi reports pi-code replacing its built-in MCP"; else ok "smoke: no built-in MCP replacement warning"; fi

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
WIRE="$HOMEDIR/wire-untrusted.jsonl"
FX="$UNTRUSTED" run_pi "$PI_BIN" -p "hi" > "$SMOKE/pi-untrusted.log" 2>&1
[ -s "$WIRE" ] || bad "smoke: no wire payload captured for the untrusted project (pi output: $(tail -1 "$SMOKE/pi-untrusted.log" 2>/dev/null))"
if wire_has 'Untrusted project context' && wire_has 'INSIDE THE PROJECT MARKER'; then ok "smoke: untrusted CLAUDE.md and its in-project import on the wire"; else bad "smoke: untrusted CLAUDE.md or its in-project import missing"; fi
if wire_has 'OUTSIDE THE PROJECT MARKER'; then bad "smoke: untrusted project imported a file outside it"; else ok "smoke: untrusted project's outside import refused"; fi
if wire_has 'UNTRUSTED LOCAL MARKER'; then bad "smoke: untrusted CLAUDE.local.md on the wire"; else ok "smoke: untrusted CLAUDE.local.md kept out"; fi
if wire_has 'UNTRUSTED RULE MARKER'; then bad "smoke: untrusted project rule on the wire"; else ok "smoke: untrusted project rule kept out"; fi

printf '\n'
printf 'e2e-smoke finished: %s passed, %s failed\n' "$PASS" "$FAIL"
exit $((FAIL > 0))
