#!/usr/bin/env bash
set -euo pipefail

remote="${PROD_DEPLOY_GUARD_REMOTE:-origin}"
branch="${PROD_DEPLOY_GUARD_BRANCH:-main}"
paths="${PROD_DEPLOY_GUARD_PATHS:-}"
deployed="${PROD_DEPLOY_GUARD_DEPLOYED_SHA:-}"

if [[ -z "${GITHUB_SHA:-}" ]]; then
  echo "GITHUB_SHA is required." >&2
  exit 2
fi

git fetch --no-tags --prune "$remote" "+refs/heads/$branch:refs/remotes/$remote/$branch"

current="$(git rev-parse --verify "$GITHUB_SHA^{commit}")"

if [[ -n "$deployed" ]]; then
  deployed_commit="$(git rev-parse --verify "$deployed^{commit}" 2>/dev/null)" || deployed_commit=""
  if [[ -z "$deployed_commit" ]]; then
    echo "Deployed SHA $deployed is not a commit in this history; treating the deployment as unknown and continuing."
    should_deploy=true
  elif [[ "$current" == "$deployed_commit" ]]; then
    echo "Skipping deploy: $current is already what is deployed."
    should_deploy=false
  elif git merge-base --is-ancestor "$deployed_commit" "$current"; then
    echo "Current SHA $current is ahead of the deployed $deployed_commit; continuing with deploy."
    should_deploy=true
  else
    echo "Skipping deploy: current SHA $current is not ahead of the deployed $deployed_commit; deploying would roll it back."
    should_deploy=false
  fi
elif [[ -n "$paths" ]]; then
  read -r -a pathspecs <<< "$paths"
  latest="$(git rev-list -1 "refs/remotes/$remote/$branch" -- "${pathspecs[@]}")"
  if [[ -z "$latest" ]] || git merge-base --is-ancestor "$latest" "$current"; then
    echo "Current SHA $current carries the newest change to [$paths] on $remote/$branch; continuing with prod deploy."
    should_deploy=true
  else
    echo "Skipping prod deploy: commit $latest on $remote/$branch touches [$paths] after $current and will run its own deploy."
    should_deploy=false
  fi
else
  latest="$(git rev-parse --verify "refs/remotes/$remote/$branch^{commit}")"
  if [[ "$current" == "$latest" ]]; then
    echo "Current SHA $current is still $remote/$branch; continuing with prod deploy."
    should_deploy=true
  else
    echo "Skipping prod deploy: current SHA $current is stale; $remote/$branch is $latest."
    should_deploy=false
  fi
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "should_deploy=$should_deploy" >> "$GITHUB_OUTPUT"
fi
