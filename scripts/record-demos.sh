#!/bin/zsh
# Record demo GIFs with vhs. Rebuilds the fixture repo, then runs every tape in a
# throwaway HOME so the recording shows only pi-code plus the fixture's own
# .claude config: no user-scope skills, rules, or memory leak in, the trust store
# is empty so the approval dialog fires, and the developer's real ~/.pi is never
# touched. The fake home is removed on exit.
set -euo pipefail

# vhs spawns a bare shell that inherits this script's PATH, not an rc file, so
# resolve node through nvm here or the recording runs whatever node came first.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent 22
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PI_VERSION="$(pi --version)"

# The recorded turns run against a local ollama model over its HTTP API (the same
# endpoint pi uses), so probe that rather than the CLI, which may not be on PATH.
if ! curl -sf http://localhost:11434/api/tags 2>/dev/null | grep -q '"gpt-oss:20b"'; then
  echo "error: ollama is not serving gpt-oss:20b at localhost:11434. Start ollama and run: ollama pull gpt-oss:20b" >&2
  exit 1
fi

# A fresh dir per run: the old fixed /tmp/pi-demo was rm -rf'd on every start,
# colliding across users and concurrent runs on a shared machine.
DEMO_DIR=$(mktemp -d -t pi-demo)
mkdir -p "$DEMO_DIR/.claude/rules" "$DEMO_DIR/.claude/commands"
git -C "$DEMO_DIR" init -qb main
git -C "$DEMO_DIR" -c user.name=demo -c user.email=demo@local commit -q --allow-empty -m init
printf -- '- Tests must be deterministic.\n' > "$DEMO_DIR/.claude/rules/testing.md"
printf -- '---\ndescription: Summarize the repo state\n---\nSummarize the state of this repository in two sentences.\n' > "$DEMO_DIR/.claude/commands/summary.md"

# The fixture ships its own MCP server so the demo shows project config being
# approved and connected without any network or API keys: a minimal newline-
# delimited JSON-RPC stdio server, no SDK needed.
cat > "$DEMO_DIR/mcp-server.mjs" << 'EOF'
import * as readline from 'node:readline'
const tools = [
  { name: 'roll_dice', description: 'Roll an N-sided die', inputSchema: { type: 'object', properties: { sides: { type: 'number' } } } },
  { name: 'fortune', description: 'A short fortune for the day', inputSchema: { type: 'object', properties: {} } },
]
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1.0.0' } })
  else if (msg.method === 'tools/list') reply(msg.id, { tools })
  else if (msg.method === 'tools/call') {
    const text = msg.params.name === 'roll_dice' ? `You rolled a ${1 + Math.floor(Math.random() * (msg.params.arguments?.sides ?? 6))}.` : 'Ship it.'
    reply(msg.id, { content: [{ type: 'text', text }] })
  } else if (msg.id !== undefined) reply(msg.id, {})
})
EOF
printf '{\n  "mcpServers": { "demo": { "command": "node", "args": ["./mcp-server.mjs"] } }\n}\n' > "$DEMO_DIR/.mcp.json"

# A throwaway home, seeded only with what the recording needs: the model catalog
# and auth pi already has, and a settings file that loads this checkout as a
# package at low thinking on the local model. Nothing here is the developer's
# real config, so no user skills/rules/memory appear in the demo.
FAKEHOME="$(mktemp -d)"
trap 'rm -rf "$FAKEHOME" "$DEMO_DIR"' EXIT
mkdir -p "$FAKEHOME/.pi/agent"
for f in auth.json models.json models-store.json; do
  [ -f "$HOME/.pi/agent/$f" ] && cp "$HOME/.pi/agent/$f" "$FAKEHOME/.pi/agent/$f"
done
# Prebuilt fd/rg from the real home, so a fresh home does not print "Downloading..."
# for them on the recorded boot.
[ -d "$HOME/.pi/agent/bin" ] && cp -R "$HOME/.pi/agent/bin" "$FAKEHOME/.pi/agent/bin"
node -e '
  const fs = require("node:fs")
  const [dir, repo, piVersion] = process.argv.slice(1)
  const settings = {
    packages: [repo],
    defaultThinkingLevel: "low",
    // Recorded turns need a model that is fast at tool calls on local hardware;
    // a dense 26B stalls the demo for minutes per call.
    defaultModel: "gpt-oss:20b",
    defaultProvider: "ollama",
    // No release-notes wall on the recorded boot.
    lastChangelogVersion: piVersion,
  }
  fs.writeFileSync(`${dir}/.pi/agent/settings.json`, `${JSON.stringify(settings, null, 2)}\n`)
  const modelsFile = `${dir}/.pi/agent/models.json`
  if (fs.existsSync(modelsFile)) {
    const models = JSON.parse(fs.readFileSync(modelsFile, "utf-8"))
    const ollama = models.providers?.ollama?.models
    if (ollama && !ollama.some((m) => m.id === "gpt-oss:20b")) {
      ollama.push({ contextWindow: 131072, id: "gpt-oss:20b", input: ["text"], reasoning: true })
      fs.writeFileSync(modelsFile, `${JSON.stringify(models, null, 2)}\n`)
    }
  }
' "$FAKEHOME" "$REPO_DIR" "$PI_VERSION"

# Seed two memories under the fixture's repo-root slug so boot shows the
# persistent-memory notice. They live in the fake home and vanish with it.
node -e '
  const fs = require("node:fs")
  const path = require("node:path")
  const { createHash } = require("node:crypto")
  const home = process.argv[1]
  for (const cwd of ["/tmp/pi-demo", "/private/tmp/pi-demo"]) {
    const slug = `${cwd.replace(/[/\\]/g, "-")}-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`
    const dir = path.join(home, ".pi", "agent", "memory", slug)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "stack.md"), "Vanilla JS + canvas, no bundler.\n")
    fs.writeFileSync(path.join(dir, "controls.md"), "Arrow keys move the snake; wraparound walls.\n")
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Memory index\n- [stack](stack.md): Vanilla JS + canvas, no bundler\n- [controls](controls.md): Arrow keys, wraparound walls\n")
  }
' "$FAKEHOME"

export HOME="$FAKEHOME"

cd "$REPO_DIR"
for tape in demos/*.tape; do
  echo "recording $tape"
  vhs "$tape"
done
echo "done: $(ls demos/*.gif 2>/dev/null | tr '\n' ' ')"
