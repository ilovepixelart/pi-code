# WebSearch / WebFetch

Key-free web tools. Source: [`extensions/web.ts`](../extensions/web.ts).

- WebSearch: DuckDuckGo search with `allowed_domains`/`blocked_domains`, no API key.
- WebFetch: SSRF-guarded fetch that prefers markdown via `Accept` and converts HTML otherwise, with Claude's 15-minute per-URL cache.
- An optional `prompt` runs the page through the model in-process and returns the answer, falling back to markdown when headless or on error.
