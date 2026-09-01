# Output styles

Claude output styles with replace semantics. Source: [`extensions/output-styles.ts`](../extensions/output-styles.ts).

- Reads every `.claude/output-styles` between the working directory and the repository root (the style closest to the working directory winning a name clash) plus the active `outputStyle` setting, and styles shipped by enabled plugins (manifest `outputStyles`, default `output-styles/`, ranked below the user's and project's own).
- Claude replace semantics with `keep-coding-instructions`; `force-for-plugin` on a plugin style applies it automatically over the `outputStyle` setting (first loaded wins); a managed-settings `outputStyle` wins over every file.
- Bundles the Concise, Explanatory, Learning, and Proactive built-ins.
- `/output-style [name]` switches styles.
