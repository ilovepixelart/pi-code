#!/bin/zsh
# Gated merge-and-release: the ONLY sanctioned way to merge a PR and cut a release.
#
# Usage: scripts/release.sh <pr-number> <version> "<release notes>"
#
# Every stage is &&-chained so a red stage stops everything after it, and the gate
# checks three independent sources before any merge:
#   1. `gh pr checks` UNPIPED - piping through tail/head swallows the exit code,
#      which once let a PR merge through a red SonarCloud check.
#   2. The SonarCloud findings API - a green quality gate can still carry findings.
#   3. The SonarCloud quality-gate API - findings can be zero while the gate fails
#      a condition such as new-code coverage.
# The publish is verified against the registry, not the pipeline's exit code.
set -u

REPO_KEY=ilovepixelart_pi-code
PR=${1:?pr number}
VERSION=${2:?version}
NOTES=${3:?release notes}

gate() {
  local pr=$1
  gh pr checks "$pr" > /dev/null \
    && python3 ~/.claude/scripts/sonar-findings.py "$REPO_KEY" "$pr" \
    && [ "$(curl -s "https://sonarcloud.io/api/qualitygates/project_status?projectKey=$REPO_KEY&pullRequest=$pr" | python3 -c 'import json,sys; print(json.load(sys.stdin)["projectStatus"]["status"])')" = "OK" ] \
    && echo "GATE-OK-$pr"
}

wait_ci() {
  local branch=$1
  until gh run list --branch "$branch" --json headSha,status -q '.[] | select(.headSha=="'"$(git rev-parse HEAD)"'") | .status' | grep -q completed; do sleep 20; done
}

# Wait for the publish run CREATED AFTER the given UTC timestamp and require it
# to succeed. The old latest-run poll could latch onto the previous release's
# completed run (a delayed release event is a documented real occurrence) and
# spun forever when the new run failed; this binds to the new run and bounds
# both waits so a dead publish surfaces as a red release, not a hang.
wait_publish() {
  local since=$1
  local deadline=$((SECONDS + 1800))
  local conclusion=""
  while [ -z "$conclusion" ]; do
    if ((SECONDS >= deadline)); then
      echo "publish run did not complete within 30m (started after $since)" >&2
      return 1
    fi
    conclusion=$(gh run list --workflow=publish.yaml --json createdAt,status,conclusion -q '[.[] | select(.createdAt >= "'"$since"'") | select(.status=="completed")][0].conclusion' 2>/dev/null)
    [ -n "$conclusion" ] || sleep 30
  done
  if [ "$conclusion" != "success" ]; then
    echo "publish run concluded: $conclusion" >&2
    return 1
  fi
}

wait_npm() {
  local version=$1
  local deadline=$((SECONDS + 900))
  until [ "$(npm view pi-code version 2>/dev/null)" = "$version" ]; do
    if ((SECONDS >= deadline)); then
      echo "npm still does not serve $version 15m after a successful publish run" >&2
      return 1
    fi
    sleep 30
  done
}

BRANCH=$(gh pr view "$PR" --json headRefName -q .headRefName) \
  && git checkout "$BRANCH" && git pull \
  && wait_ci "$BRANCH" && gate "$PR" \
  && gh pr merge "$PR" --squash \
  && git checkout main && git pull \
  && git checkout -b "release/$VERSION" \
  && npm version "$VERSION" --no-git-tag-version \
  && npm run check > "/tmp/release-$VERSION-check.log" 2>&1 \
  && git add package.json package-lock.json \
  && git commit -m "Release $VERSION" \
  && git push origin "HEAD:release/$VERSION" \
  && BUMP_PR=$(gh pr create --title "Release $VERSION" --body "Version bump to $VERSION." | grep -o '[0-9]*$') \
  && wait_ci "release/$VERSION" && gate "$BUMP_PR" \
  && gh pr merge "$BUMP_PR" --squash --delete-branch \
  && git checkout main && git pull \
  && RELEASE_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  && gh release create "v$VERSION" --target main --title "$VERSION" --notes "$NOTES" \
  && wait_publish "$RELEASE_AT" \
  && wait_npm "$VERSION" \
  && echo "RELEASED-$VERSION"
