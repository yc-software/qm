#!/bin/bash
# Defaults are this repository's full-suite test and lint commands; IO_VERIFY_* overrides them per team.
set -u

case "${1:-}" in
  tests)
    printf '%s\n' "${IO_VERIFY_TESTS_CMD:-npm run test:all}"
    ;;
  lint)
    printf '%s\n' "${IO_VERIFY_LINT_CMD:-npm run typecheck && npm run lint}"
    ;;
  *)
    echo "usage: verify.sh <tests|lint>" >&2
    exit 2
    ;;
esac
