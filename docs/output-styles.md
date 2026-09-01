# Output styles

Claude output styles with replace semantics. Source: [`extensions/output-styles.ts`](../extensions/output-styles.ts).

- Reads `.claude/output-styles` plus the active `outputStyle` setting, and styles shipped by enabled plugins (manifest `outputStyles`, default `output-styles/`, ranked below the user's and project's own).
- Claude replace semantics with `keep-coding-instructions`.
- Bundles the Explanatory, Learning, and Proactive built-ins.
- `/output-style [name]` switches styles.
