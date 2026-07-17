#!/bin/zsh
# Record demo GIFs with vhs. Rebuilds the fixture repo, then runs every tape.
set -euo pipefail

DEMO_DIR=/tmp/pi-demo
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR/.claude/rules"
git -C "$DEMO_DIR" init -qb main
git -C "$DEMO_DIR" -c user.name=demo -c user.email=demo@local commit -q --allow-empty -m init
printf -- '- Tests must be deterministic.\n' > "$DEMO_DIR/.claude/rules/testing.md"

# Demos record at low thinking level: faster turns, no reasoning wall.
SETTINGS="$HOME/.pi/agent/settings.json"
cp "$SETTINGS" "$SETTINGS.demo-backup"
trap 'mv "$SETTINGS.demo-backup" "$SETTINGS"' EXIT
sed -i '' 's/"defaultThinkingLevel": "[a-z]*"/"defaultThinkingLevel": "low"/' "$SETTINGS"

cd "$(dirname "$0")/.."
for tape in demos/*.tape; do
  echo "recording $tape"
  vhs "$tape"
done
echo "done: $(ls demos/*.gif 2>/dev/null | tr '\n' ' ')"
