#!/bin/bash
# The default must stay byte-identical to the proof-strategy literal in work-ticket-build-and-ship.js.
set -u

case "${1:-}" in
  modes)
    printf '%s\n' "${IO_PROOF_MODES:-browser runtime test none}"
    ;;
  *)
    echo "usage: proof.sh modes" >&2
    exit 2
    ;;
esac
