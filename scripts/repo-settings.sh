#!/bin/zsh
# Repository settings pi-code expects, applied in one run.
#
# These are owner-only: they need repo admin, and an agent session cannot make them.
# Run it once, re-run it any time; every call is a PUT, PATCH or a create that is
# skipped when the object already exists, so a second run changes nothing.
#
#   scripts/repo-settings.sh
#
# What it does not do, because it cannot: after this adds the `npm-publish`
# environment, the same name has to be added to the package's Trusted Publisher
# config on npm, or publishing fails with E404. The script prints that reminder.
set -u

REPO=ilovepixelart/pi-code
# The owner, so a ruleset that binds everyone still leaves one way to fix a bad tag.
# A ruleset with no bypass actor binds admins too.
OWNER_ID=7249538
# GitHub Actions, for the durable `checks` form of required status checks. The older
# `contexts` form carries a closing-down notice.
ACTIONS_APP_ID=15368

step() { printf '\n== %s\n' "$1"; }
ok() { printf '   ok: %s\n' "$1"; }

step 'branch protection on main'
# strict:false on purpose: strict blocks merging any PR whose branch is behind main,
# and the release flow has no branch-update step.
gh api -X PUT "repos/$REPO/branches/main/protection" --input - > /dev/null << JSON && ok 'required checks, no force-push, no deletion'
{"required_status_checks":{"strict":false,"checks":[
   {"context":"Biome, Types & Tests (ubuntu-latest, 22.x)","app_id":$ACTIONS_APP_ID},
   {"context":"Biome, Types & Tests (windows-latest, 22.x)","app_id":$ACTIONS_APP_ID},
   {"context":"Headless e2e smoke","app_id":$ACTIONS_APP_ID}]},
 "enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,
 "allow_force_pushes":false,"allow_deletions":false}
JSON

step 'release tag ruleset'
if gh api "repos/$REPO/rulesets" --jq '.[].name' 2>/dev/null | grep -qx protect-release-tags; then
  ok 'protect-release-tags already exists'
else
  # Creation stays open so the release flow can still make a v* tag; deleting, moving
  # or force-updating one is what this blocks.
  gh api -X POST "repos/$REPO/rulesets" --input - > /dev/null << JSON && ok 'v* tags cannot be deleted, moved or force-updated'
{"name":"protect-release-tags","target":"tag","enforcement":"active",
 "bypass_actors":[{"actor_id":$OWNER_ID,"actor_type":"User","bypass_mode":"always"}],
 "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"update"}]}
JSON
fi

step 'npm-publish environment'
gh api -X PUT "repos/$REPO/environments/npm-publish" > /dev/null && ok 'environment created'

step 'security features'
gh api -X PATCH "repos/$REPO" --input - > /dev/null << 'JSON' && ok 'secret scanning and push protection'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},
 "secret_scanning_push_protection":{"status":"enabled"}}}
JSON
gh api -X PUT "repos/$REPO/vulnerability-alerts" > /dev/null && ok 'Dependabot alerts'
gh api -X PUT "repos/$REPO/automated-security-fixes" > /dev/null && ok 'Dependabot security updates'

step 'CodeQL false positives'
# All four are the same finding: text extraction for a model prompt, not HTML
# sanitization. The output is never parsed as HTML, and entities are decoded after
# tags are removed by design, so the incomplete-sanitization rule does not apply.
DISMISS_REASON='Text extraction for a model prompt, not HTML sanitization: the output is never parsed as HTML and entities are decoded after tags are removed by design.'
for alert in 1 2 3 4; do
  state=$(gh api "repos/$REPO/code-scanning/alerts/$alert" --jq .state 2>/dev/null) || continue
  if [ "$state" = dismissed ]; then
    ok "alert $alert already dismissed"
  else
    gh api -X PATCH "repos/$REPO/code-scanning/alerts/$alert" \
      -f state=dismissed -f dismissed_reason='false positive' \
      -f dismissed_comment="$DISMISS_REASON" > /dev/null && ok "alert $alert dismissed"
  fi
done

step 'what is set now'
gh api "repos/$REPO/branches/main/protection" --jq '"  checks: " + ([.required_status_checks.checks[].context] | join(", "))'
gh api "repos/$REPO/rulesets" --jq '"  rulesets: " + ([.[].name] | join(", "))'
gh api "repos/$REPO" --jq '"  secret scanning: " + .security_and_analysis.secret_scanning.status'

printf '\n== one thing left, on npm not GitHub\n'
printf '   Add the environment name `npm-publish` to this package'"'"'s Trusted Publisher\n'
printf '   config on npmjs.com. Until then the publish workflow fails with E404.\n'
