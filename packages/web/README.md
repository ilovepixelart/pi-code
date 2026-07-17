# pi-code-web

Key-free web access honoring a local-only setup: no API keys, no cloud accounts.

- `web_search`: DuckDuckGo HTML endpoint, parsed to titles + URLs + snippets
- `web_fetch`: fetch a URL as readable text (scripts/styles stripped, 30KB cap)
- Zero dependencies (node's global fetch)

Replaces `@ollama/pi-web-search`, which requires an ollama cloud API key.

## Install

```bash
pi install ~/Documents/pi-code/packages/web
```
