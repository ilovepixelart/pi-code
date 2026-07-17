# pi-code-guardrails

Mechanical git guardrails enforced on every bash tool call:

- `git push --force` is blocked, `--force-with-lease` is allowed
- Commit messages containing AI attribution (Co-Authored-By: Claude, "Generated with", robot emoji) are blocked
- Blanket staging (`git add -A`, `--all`, `.`) requires confirmation, blocked in non-interactive mode

Hand-written, not vendored.

## Install

```bash
pi install git:github.com/ilovepixelart/pi-code-guardrails
```
