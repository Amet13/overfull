#!/usr/bin/env bash
# Merges the open same-repository pull request for <branch> labelled `automerge` when its
# head is <sha> and every check run on <sha> passed, then starts ci, image, pages and
# regenerate on main (a merge made with GITHUB_TOKEN starts no workflows by itself).
#
# Only pull requests opened by the repository owner, the repository's own workflows
# (GitHub Actions) or Dependabot are merged; anyone else's is left for a person, even
# with the label (adding a label needs triage access, so this matters only for people
# given access to the repository).
#
#   .github/scripts/automerge.sh <branch> <sha> [check suite to ignore]
#
# The third argument is the calling run's own check suite: its jobs are still running
# while it asks, and the caller has already checked them.
# Needs GH_TOKEN (contents: write, pull-requests: write, actions: write, checks: read)
# and GH_REPO.
set -euo pipefail
branch="$1"
sha="$2"
ignore_suite="${3:-0}"

owner="${GH_REPO%%/*}"
# gh names apps "app/<slug>"; the REST form "<slug>[bot]" is accepted too.
pr="$(SHA="$sha" OWNER="$owner" gh pr list --head "$branch" --state open \
  --json number,headRefOid,labels,isCrossRepository,author \
  --jq '[.[] | select(.isCrossRepository == false and .headRefOid == env.SHA
      and any(.labels[]; .name == "automerge")
      and (.author.login | IN(env.OWNER, "app/github-actions", "github-actions[bot]",
        "app/dependabot", "dependabot[bot]")))][0].number // empty')"
if [ -z "$pr" ]; then
  echo "No open same-repository PR labelled automerge at $sha opened by $owner, GitHub Actions or Dependabot."
  exit 0
fi

pending="$(gh api "repos/$GH_REPO/commits/$sha/check-runs?per_page=100" --paginate \
  --jq ".check_runs[] | select(.check_suite.id != $ignore_suite) |
    select(.status != \"completed\" or (.conclusion as \$c | [\"success\",\"skipped\",\"neutral\"] | index(\$c) | not)) | .name")"
if [ -n "$pending" ]; then
  echo "Not merging #$pr yet; waiting for or failed:"
  echo "$pending"
  exit 0
fi

gh pr merge "$pr" --squash --delete-branch
for w in ci.yml image.yml pages.yml regenerate.yml; do gh workflow run "$w" --ref main; done
echo "Merged #$pr and started ci, image, pages and regenerate on main."
