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

`npm run check` is the whole gate: [Biome](https://biomejs.dev) (format and lint), strict `tsc`, [knip](https://knip.dev) (unused exports and dependencies), and [Vitest](https://vitest.dev) with coverage floors and shuffled test order. It must pass before a change is ready. CI runs it on ubuntu and windows, node 22 and 24, plus the headless smoke.

To try your changes in a real session, install the checkout and reload after edits:

```bash
pi install ./pi-code
# edit, then /reload inside pi
```

## Project layout

- `extensions/*.ts` are the extensions pi loads, one file per feature.
- `extensions/internal/*.ts` are shared helpers that pi must not load as extensions (parsers, the trust check, shared-bus contracts, cross-extension seams).
- `tests/*.ts` are the Vitest suites.
- `scripts/e2e-smoke.sh` is the headless deterministic smoke: it boots the pi devDependency against a dead-port model and asserts the exact provider payload (no real model or network); CI runs it on every PR.
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

[`scripts/release.sh`](scripts/release.sh) runs that whole sequence, from an open pull request to a verified package:

```bash
scripts/release.sh <pr-number> <version> "<release notes>"
```

Prefer it over doing the steps by hand, because the checks it runs are easy to skip and have each let a bad release through before. Every stage is `&&`-chained, so a red one stops what follows. Before either merge it consults three independent sources: `gh pr checks` unpiped, since piping it through `tail` swallows the exit code; the SonarCloud findings API, because a green quality gate can still carry findings; and the quality-gate API itself, because findings can be zero while a condition such as new-code coverage fails. It waits on the CI runs for the exact HEAD commit rather than the newest run, and it confirms the release by asking the npm registry for the version, not by trusting the publish workflow's exit code.

It starts from an unmerged pull request and merges it. A release for work already on `main` has to follow the same steps from the version bump onward.

## Reporting bugs and security issues

Open an issue for a bug or a feature idea. For anything security-sensitive, do not open a public issue: report it privately through [GitHub Security Advisories](https://github.com/ilovepixelart/pi-code/security/advisories/new), as described in [SECURITY.md](SECURITY.md).

By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md) and that your work is licensed under the project's [MIT license](LICENSE).
