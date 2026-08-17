#!/bin/zsh
# Record demo GIFs with vhs. Rebuilds the fixture repo, then runs every tape.
set -euo pipefail

# vhs spawns a bare shell that inherits this script's PATH, not an rc file, so
# resolve node through nvm here or the recording runs whatever node came first.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent 22
fi

DEMO_DIR=/tmp/pi-demo
rm -rf "$DEMO_DIR"
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

# The approval dialog is part of the demo, so forget any remembered decision
# for the fixture (macOS canonicalizes /tmp to /private/tmp; clear both).
TRUST="$HOME/.pi/agent/trust.json"
if [ -f "$TRUST" ]; then
  node -e '
    const fs = require("node:fs")
    const file = process.argv[1]
    const data = JSON.parse(fs.readFileSync(file, "utf-8"))
    for (const key of ["/tmp/pi-demo", "/private/tmp/pi-demo"]) delete data[key]
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  ' "$TRUST"
fi

# Seed two memories so boot shows the persistent-memory notice. The store slug
# is dashed-path plus a digest of the path as the extension saw it, which may
# or may not be canonicalized, so seed both spellings.
node -e '
  const fs = require("node:fs")
  const os = require("node:os")
  const path = require("node:path")
  const { createHash } = require("node:crypto")
  for (const cwd of ["/tmp/pi-demo", "/private/tmp/pi-demo"]) {
    const slug = `${cwd.replace(/[/\\]/g, "-")}-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`
    const dir = path.join(os.homedir(), ".pi", "agent", "memory", slug)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "stack.md"), "Vanilla JS + canvas, no bundler.\n")
    fs.writeFileSync(path.join(dir, "controls.md"), "Arrow keys move the snake; wraparound walls.\n")
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Memory index\n- [stack](stack.md): Vanilla JS + canvas, no bundler\n- [controls](controls.md): Arrow keys, wraparound walls\n")
  }
'

# Demos record with this checkout loaded as a user-scope package (so the GIF
# shows the code as it is now, and the fixture stays a plain ".claude repo"
# that triggers pi-code's own approval dialog), at low thinking level for
# faster turns. The original settings come back on exit.
SETTINGS="$HOME/.pi/agent/settings.json"
MODELS="$HOME/.pi/agent/models.json"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cp "$SETTINGS" "$SETTINGS.demo-backup"
cp "$MODELS" "$MODELS.demo-backup"
trap 'mv "$SETTINGS.demo-backup" "$SETTINGS"; mv "$MODELS.demo-backup" "$MODELS"' EXIT
node -e '
  const fs = require("node:fs")
  const [settingsFile, modelsFile, repo, piVersion] = process.argv.slice(1)
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"))
  settings.defaultThinkingLevel = "low"
  settings.packages = [...new Set([...(settings.packages ?? []), repo])]
  // Recorded turns need a model that is fast at tool calls on local hardware;
  // a dense 26B stalls the demo for minutes per call.
  settings.defaultModel = "gpt-oss:20b"
  settings.defaultProvider = "ollama"
  // No release-notes wall on the recorded boot.
  settings.lastChangelogVersion = piVersion
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
  const models = JSON.parse(fs.readFileSync(modelsFile, "utf-8"))
  const ollama = models.providers.ollama.models
  if (!ollama.some((m) => m.id === "gpt-oss:20b")) {
    ollama.push({ contextWindow: 131072, id: "gpt-oss:20b", input: ["text"], reasoning: true })
  }
  fs.writeFileSync(modelsFile, `${JSON.stringify(models, null, 2)}\n`)
' "$SETTINGS" "$MODELS" "$REPO_DIR" "$(pi --version)"

cd "$(dirname "$0")/.."
for tape in demos/*.tape; do
  echo "recording $tape"
  vhs "$tape"
done
echo "done: $(ls demos/*.gif 2>/dev/null | tr '\n' ' ')"
