#!/bin/sh
set -eu
[ $# -ge 3 ] || { echo "usage: push-token.sh <ssh-command> <host> <principalId> [qm-dir] < token" >&2; exit 2; }
dir=${4:-'~/qm-test'}
timeout 90 $1 "cd $dir/plugins/web-ui && set -a && . $dir/test.env && set +a && node server/settok.ts '$2' '$3'"
