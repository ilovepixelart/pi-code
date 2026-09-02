#!/bin/zsh
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

ok() { PASS=$((PASS + 1)); print "PASS $1" }
bad() { FAIL=$((FAIL + 1)); print "FAIL $1" }

SMOKE=$(mktemp -d)
cleanup() { rm -rf "$SMOKE" }
trap cleanup EXIT
trap 'cleanup; trap - INT; kill -INT $$' INT
trap 'cleanup; trap - TERM; kill -TERM $$' TERM

[ -x "$PI_BIN" ] || { print "FAIL smoke: $PI_BIN missing; run npm ci first"; exit 1 }

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
python3 - "$HOMEDIR" "$REPO" "$FX" <<'PY'
import json, sys
home, repo, fx = sys.argv[1:4]
agent = f"{home}/.pi/agent"
json.dump({"providers": {"dead": {"api": "openai-completions", "apiKey": "dead-key", "baseUrl": "http://127.0.0.1:1/v1", "models": [{"contextWindow": 131072, "id": "dead-model", "input": ["text"]}]}}}, open(f"{agent}/models.json", "w"))
json.dump({"packages": [repo], "defaultModel": "dead-model", "defaultProvider": "dead", "defaultThinkingLevel": "off", "extensions": [f"{repo}/scripts/lib/wire-probe.ts"]}, open(f"{agent}/settings.json", "w"))
# Pre-seeded trust: headless -p has no dialog, and untrusted projects load no
# project-scoped config at all, which is most of what this smoke asserts.
json.dump({fx: True}, open(f"{agent}/trust.json", "w"))
PY

run_pi() {
  (cd "$FX" && env -u PI_CODING_AGENT_DIR -u CLAUDE_CONFIG_DIR HOME="$HOMEDIR" PI_E2E_WIRE="$WIRE" PI_SKIP_VERSION_CHECK=1 perl -e 'alarm 150; exec @ARGV' "$@" < /dev/null)
}

# --- Discovery: pi under the isolated home loads THIS checkout ---
if run_pi "$PI_BIN" list 2>/dev/null | grep -qF "$REPO"; then ok "smoke: pi list discovers this checkout"; else bad "smoke: pi list does not load $REPO"; fi

# --- One headless turn; the connection error afterwards is expected ---
run_pi "$PI_BIN" -p "hi" > "$SMOKE/pi-out.log" 2>&1
[ -s "$WIRE" ] && ok "smoke: wire probe captured the provider payload" || bad "smoke: no wire payload captured (pi output: $(tail -1 "$SMOKE/pi-out.log" 2>/dev/null))"

wire_has() { grep -q "$1" "$WIRE" 2>/dev/null }
if wire_has 'ZANZIBAR'; then ok "smoke: @import chain content on the wire"; else bad "smoke: import content missing from payload"; fi
if wire_has 'PERSONAL LOCAL NOTE MARKER'; then ok "smoke: CLAUDE.local.md on the wire"; else bad "smoke: local marker missing from payload"; fi
if wire_has 'Tests must be deterministic'; then ok "smoke: project rule on the wire"; else bad "smoke: project rule missing from payload"; fi
if wire_has 'available_skills' && wire_has 'greet'; then ok "smoke: skills listing on the wire"; else bad "smoke: skills listing missing from payload"; fi

print ""
print "e2e-smoke finished: $PASS passed, $FAIL failed"
exit $((FAIL > 0))
