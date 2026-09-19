#!/bin/bash
# Defaults are this repository's own scope; the mutation gate's classifier list in work-ticket-build-and-ship.js is deliberately wider.
set -u

base="${IO_SOURCE_BASE_REF:-origin/main}"
remote="${IO_SOURCE_REMOTE:-origin}"
dirs="${IO_SOURCE_APP_DIRS:-src plugins scripts cli deploy skills-seed docs fly aws local factory .github .codex .claude .husky .scenarios}"

case "${1:-}" in
  base-ref)
    printf '%s\n' "$base"
    ;;
  diff-base)
    printf '%s\n' "git merge-base $base HEAD"
    ;;
  app-dirs)
    printf '%s\n' "$dirs"
    ;;
  clean-base)
    # A --depth clone is single-branch, so a plain fetch never creates the remote-tracking ref the reset needs.
    printf '%s\n' \
      "io_with_gitlab_refresh git fetch $remote +refs/heads/${base#*/}:refs/remotes/$remote/${base#*/}" \
      "git reset --hard $base" \
      "git clean -fd -- $dirs"
    ;;
  *)
    echo "usage: source.sh <base-ref|diff-base|app-dirs|clean-base>" >&2
    exit 2
    ;;
esac
