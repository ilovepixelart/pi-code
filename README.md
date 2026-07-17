# pi-code-statusline

Adds a status segment to pi's footer: turn state plus running session cost (summed from per-message usage on the current branch, so it survives `/tree` navigation and forks).

pi's built-in footer already shows path, branch, context, and model; this plugin only adds what is missing instead of replacing the footer.

Started from the pi v0.74.2 `status-line` example (a turn-counter demo), rewritten.

## Install

```bash
pi install git:github.com/ilovepixelart/pi-code-statusline
```
