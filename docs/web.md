# WebSearch / WebFetch

Key-free web tools. Source: [`extensions/web.ts`](../extensions/web.ts).

- WebSearch: DuckDuckGo search with `allowed_domains`/`blocked_domains`, no API key.
- WebFetch: SSRF-guarded fetch that prefers markdown via `Accept` and converts HTML otherwise.
- An optional `prompt` runs the page through the model in-process and returns the answer, falling back to markdown when headless or on error.

## Aligned with Claude

- **http is upgraded to https** before the request, as Claude documents. The upgraded URL is also the cache key, so both spellings of a page share one entry.
- **A redirect to a different host is reported, not followed**: the result names the original URL and the target, and Claude fetches the target with a second call if it wants it. Same-host redirects are still followed, up to 5 of them, with the address guard re-applied per hop. Because a cross-host target is never requested, it cannot be reached from here at all.
- **Cache TTL** is 15 minutes per URL by default and honors `CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`. An unset, blank, negative or non-numeric value keeps the default.

The cross-host rule is WebFetch's. The internal search fetch still follows its own endpoint's redirects: those hops are ours, and Claude's rule does not describe them.

## Divergences

- **User-Agent** is pi-code's own, not `Claude-User*`. The tools reference does not document the string, so there is nothing to match.
- **WebSearch `allowed_domains` + `blocked_domains`** in one call: pi-code applies allowed and ignores blocked. Claude's tool description calls them mutually exclusive; the reference gives no behavior for the combination.
- **No 200-call per-session WebSearch cap.** Not in the reference either; recorded here because Claude's product surface has one.
- Page extraction runs on the session model, where Claude uses a small fast model.
