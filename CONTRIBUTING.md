# Contributing

Thanks for helping improve pi-code. This is a pack of [pi](https://pi.dev) extensions that bridge a project's `.claude/` configuration into pi and add the Claude Code features pi lacks. Each feature is a self-contained extension under [`extensions/`](extensions).

## Getting started

Requirements: Node `>=22.19` and `pi` on your `PATH`.

```bash
git clone https://github.com/ilovepixelart/pi-code
cd pi-code
npm install
npm run check
```

`npm run check` is the whole gate: [Biome](https://biomejs.dev) (format and lint), strict `tsc`, and [Vitest](https://vitest.dev) with coverage. It must pass before a change is ready.

To try your changes in a real session, install the checkout and reload after edits:

```bash
pi install ./pi-code
# edit, then /reload inside pi
```

## Project layout

- `extensions/*.ts` are the extensions pi loads, one file per feature.
- `extensions/internal/*.ts` are shared helpers that pi must not load as extensions (parsers, the trust check, shared-bus contracts, cross-extension seams).
- `tests/*.ts` are the Vitest suites.
- `scripts/e2e.sh` and `scripts/e2e-full.sh` drive a real pi TUI through tmux; they need a working local model.

## Making a change

- Keep each pull request to one focused change, and keep the tree green: run `npm run check` before you push.
- Write tests first, and cover the change across the pyramid where it applies: unit tests for pure logic, integration tests against a stubbed pi API, and an e2e path when the behavior only shows in a real session.
- An extension that reads project-controlled input (a cloned repo's `.claude/`) must gate on `ctx.isProjectTrusted()`. See [SECURITY.md](SECURITY.md) for the trust model.
- Parity with Claude Code is verified against the live docs at [code.claude.com/docs](https://code.claude.com/docs), not memory. Where pi cannot express a Claude behavior, document the deviation rather than approximating it silently.

## Commits and pull requests

Commit subjects are imperative and specific, one topic per commit, for example `Refuse memory index writes when the index cannot be read`. Skip `feat:`/`fix:` prefixes. Pull requests squash-merge, so the PR title becomes the commit subject; keep the body to what the diff does not already show.

## Releases

Maintainers cut a release with a dedicated `release/x.y.z` pull request that bumps only `package.json` and the lockfile, titled `Release x.y.z`. Creating the GitHub release for the tag triggers the publish workflow, which packs, attests, and publishes to npm.

## Reporting bugs and security issues

Open an issue for a bug or a feature idea. For anything security-sensitive, do not open a public issue: report it privately through [GitHub Security Advisories](https://github.com/ilovepixelart/pi-code/security/advisories/new), as described in [SECURITY.md](SECURITY.md).

By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md) and that your work is licensed under the project's [MIT license](LICENSE).
