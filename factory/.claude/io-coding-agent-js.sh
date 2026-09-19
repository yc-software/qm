#!/bin/bash
set -uo pipefail

# IO Coding Agent — the headless JS-engine wrapper. This is the orchestrated coding agent's ONLY
# engine (the legacy bash io-coding-agent.sh has been retired).
#
# Runs the JS `work-ticket-orchestrator` workflow HEADLESS via `claude -p` and emits the exact
# stdout contract CodingAgentSession#finalize_orchestrated_session! scrapes from CloudWatch:
#   BRANCH:<name>  +  MR:<iid>   (an MR was shipped)   → waiting_for_review!
#   ALREADY_FIXED:true           (fix already on master) → accepted!
#     (may be accompanied by BRANCH:/MR: when the run also carries a retained MR)
# plus exit 0 on success / non-zero so the finalizer rejects (→ Auto-Triage retry).
#
# Per-phase Slack updates are posted INSIDE the JS pipeline (slackPhase), gated on the
# slackThread arg we set below — so the run's threaded ⏳/✅ Slack UX is preserved using the
# SLACK_THREAD_TS/SLACK_CHANNEL_ID/SLACK_BOT_TOKEN env the orchestrated job already injects.
# This wrapper does NOT touch Slack itself.
#
# Usage: bash .claude/io-coding-agent-js.sh <TICKET_ID>
#   ticket:  $1 or IO_TICKET_ID
#   prompt:  IO_PROMPT (+ optional IO_PROMPT_MODE=true; orchestrated runs pass IO_PROMPT_S3_URI instead)
#   model:   optional IO_CLAUDE_MODEL (default claude-opus-5) + IO_CLAUDE_EFFORT (default high)
#   gitlab:  optional GITLAB_USER_TOKEN (+ GITLAB_USER_NAME/GITLAB_USER_EMAIL) — the responsible
#            user's credential + commit identity; absent ⇒ the entrypoint's bot token/identity
#   repo:    optional IO_REPO_DIR (default /workspace/repo, the subject repository checkout) — cloned from
#            IO_REPO_CLONE_URL when absent, then IO_REPO_SETUP_CMD is eval'd in it

# bash re-reads a script by byte offset, so a run that edits the repo copy would execute fragments of it.
if [ -z "${IO_WRAPPER_REEXEC:-}" ]; then
  io_wrapper_copy="$(mktemp "${TMPDIR:-/tmp}/io-coding-agent-js.XXXXXX")" \
    || { echo "[io-coding-agent-js] could not create the wrapper snapshot" >&2; exit 2; }
  cat "$0" > "$io_wrapper_copy" \
    || { echo "[io-coding-agent-js] could not snapshot the wrapper from $0" >&2; exit 2; }
  IO_WRAPPER_REEXEC=1 exec bash "$io_wrapper_copy" "$@"
fi
# Exported by the exec above, so every child would inherit it and a nested wrapper would skip its own snapshot.
unset IO_WRAPPER_REEXEC

# x-access-token, not oauth2:, so the bot-token scrape below cannot pick this PAT out of git config.
repoint_github_auth() {
  local token="$1"
  [ -n "$token" ] || { echo "[github-auth] no token supplied" >&2; return 1; }
  git config --global --get-regexp '^url\..*\.insteadof$' 2>/dev/null \
    | grep -E '^url\.[^ ]*github\.com' \
    | sed -E 's/^url\.(.*)\.insteadof .*/\1/' | sort -u \
    | while read -r base; do git config --global --remove-section "url.$base" 2>/dev/null; done
  git config --global url."https://x-access-token:${token}@github.com/".insteadOf "https://github.com/"
  git config --global --add url."https://x-access-token:${token}@github.com/".insteadOf "git@github.com:"
}

REPO="${IO_REPO_DIR:-/workspace/repo}"
# The default path is not pre-baked here, so the clone below is the normal path, not a fallback.
if [ ! -d "$REPO" ] && [ -n "${IO_REPO_CLONE_URL:-}" ]; then
  [ -n "${IO_GITHUB_TOKEN:-}" ] && repoint_github_auth "$IO_GITHUB_TOKEN"
  git clone --depth 50 "$IO_REPO_CLONE_URL" "$REPO" \
    || { echo "[io-coding-agent-js] clone failed: $IO_REPO_CLONE_URL" >&2; exit 2; }
fi
cd "$REPO" || { echo "[io-coding-agent-js] repo dir not found: $REPO" >&2; exit 2; }
if [ -n "${IO_REPO_SETUP_CMD:-}" ]; then
  # Subshell: a config string that ends in `exit` would otherwise become the wrapper's own status.
  ( eval "$IO_REPO_SETUP_CMD" ) \
    || { echo "[io-coding-agent-js] repo setup failed" >&2; exit 2; }
fi

# The subject branch may predate the deployed factory—or may itself edit factory tooling. Snapshot
# every control-plane file that can be loaded after a workflow checks out a retained branch.
pin_factory_control_plane() {
  local repo="${IO_REPO_DIR:-/workspace/repo}" source_repo="${IO_FACTORY_SOURCE_DIR:-${IO_REPO_DIR:-/workspace/repo}}" workflow
  IO_FACTORY_CONTROL_PLANE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/io-factory-control-plane.XXXXXX") || return 1
  cp "$source_repo/tools/factory/converge-vector.sh" \
    "$IO_FACTORY_CONTROL_PLANE_DIR/converge-vector.sh" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  for workflow in work-ticket-orchestrator.js work-ticket-understand.js \
    work-ticket-build-and-ship.js; do
    cp "$source_repo/.claude/workflows/$workflow" "$IO_FACTORY_CONTROL_PLANE_DIR/$workflow" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  done
  for workflow in .claude/workflows/prompts/contract-fidelity.md .claude/commands/review_plan.md \
    .claude/skills/add-tests/SKILL.md \
    tools/factory/verify.sh tools/factory/publish.sh tools/factory/source.sh \
    tools/factory/proof.sh; do
    cp "$source_repo/$workflow" "$IO_FACTORY_CONTROL_PLANE_DIR/${workflow##*/}" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  done
  mkdir -p "$IO_FACTORY_CONTROL_PLANE_DIR/cli/files/lib" "$IO_FACTORY_CONTROL_PLANE_DIR/rc" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  if [ -f "$source_repo/cli/files/lib/signed-webhook.sh" ]; then
    cp "$source_repo/cli/files/lib/signed-webhook.sh" "$IO_FACTORY_CONTROL_PLANE_DIR/cli/files/lib/signed-webhook.sh" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  fi
  # These files are optional repository tooling (a Bugbot ruleset, a React skill, forge helpers); the run works without them.
  if [ -f "$source_repo/.cursor/BUGBOT.md" ]; then
    cp "$source_repo/.cursor/BUGBOT.md" "$IO_FACTORY_CONTROL_PLANE_DIR/BUGBOT.md" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  fi
  if [ -f "$source_repo/.claude/skills/react-useeffect/SKILL.md" ]; then
    cp "$source_repo/.claude/skills/react-useeffect/SKILL.md" "$IO_FACTORY_CONTROL_PLANE_DIR/react-useeffect-SKILL.md" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  fi
  if [ -f "$source_repo/cli/files/fetch-gitlab-token.sh" ]; then
    cp "$source_repo/cli/files/fetch-gitlab-token.sh" "$IO_FACTORY_CONTROL_PLANE_DIR/cli/files/fetch-gitlab-token.sh" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  fi
  if [ -f "$source_repo/.claude/skills/rc/rc-start" ]; then
    cp "$source_repo/.claude/skills/rc/rc-start" "$IO_FACTORY_CONTROL_PLANE_DIR/rc/rc-start" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  fi
  if [ -f "$source_repo/.claude/skills/rc/rc-exec" ]; then
    cp "$source_repo/.claude/skills/rc/rc-exec" "$IO_FACTORY_CONTROL_PLANE_DIR/rc/rc-exec" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  fi
  if [ -f "$source_repo/.claude/skills/rc/rc-cleanup" ]; then
    cp "$source_repo/.claude/skills/rc/rc-cleanup" "$IO_FACTORY_CONTROL_PLANE_DIR/rc/rc-cleanup" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""
      return 1
    }
  fi
  IO_FACTORY_SHIP_CONTROL_PLANE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/io-factory-ship.XXXXXX") || {
    rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"
    IO_FACTORY_CONTROL_PLANE_DIR=""; IO_FACTORY_SHIP_CONTROL_PLANE_DIR=""
    return 1
  }
  cp "$source_repo/tools/factory/converge-vector.sh" "$IO_FACTORY_SHIP_CONTROL_PLANE_DIR/converge-vector.sh" \
    && cp "$source_repo/.claude/workflows/work-ticket-build-and-ship.js" \
      "$IO_FACTORY_SHIP_CONTROL_PLANE_DIR/work-ticket-build-and-ship.js" || {
      rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR" "$IO_FACTORY_SHIP_CONTROL_PLANE_DIR"
      IO_FACTORY_CONTROL_PLANE_DIR=""; IO_FACTORY_SHIP_CONTROL_PLANE_DIR=""
      return 1
    }
  IO_CONVERGE_VECTOR_SH="$IO_FACTORY_SHIP_CONTROL_PLANE_DIR/converge-vector.sh"
  IO_WORK_TICKET_ORCHESTRATOR_JS="$IO_FACTORY_CONTROL_PLANE_DIR/work-ticket-orchestrator.js"
  IO_WORK_TICKET_UNDERSTAND_JS="$IO_FACTORY_CONTROL_PLANE_DIR/work-ticket-understand.js"
  IO_WORK_TICKET_BUILD_AND_SHIP_JS="$IO_FACTORY_CONTROL_PLANE_DIR/work-ticket-build-and-ship.js"
  IO_WORK_TICKET_SHIP_JS="$IO_FACTORY_SHIP_CONTROL_PLANE_DIR/work-ticket-build-and-ship.js"
  IO_CONTRACT_FIDELITY_MD="$IO_FACTORY_CONTROL_PLANE_DIR/contract-fidelity.md"
  IO_REVIEW_PLAN_MD="$IO_FACTORY_CONTROL_PLANE_DIR/review_plan.md"
  IO_ADD_TESTS_SKILL_MD="$IO_FACTORY_CONTROL_PLANE_DIR/SKILL.md"
  IO_BUGBOT_MD="$IO_FACTORY_CONTROL_PLANE_DIR/BUGBOT.md"
  IO_VERIFY_SH="$IO_FACTORY_CONTROL_PLANE_DIR/verify.sh"
  IO_PUBLISH_SH="$IO_FACTORY_CONTROL_PLANE_DIR/publish.sh"
  IO_SOURCE_SH="$IO_FACTORY_CONTROL_PLANE_DIR/source.sh"
  IO_PROOF_SH="$IO_FACTORY_CONTROL_PLANE_DIR/proof.sh"
  IO_FETCH_GITLAB_TOKEN_SH="${IO_FETCH_GITLAB_TOKEN_SH:-$IO_FACTORY_CONTROL_PLANE_DIR/cli/files/fetch-gitlab-token.sh}"
  IO_RC_START="$IO_FACTORY_CONTROL_PLANE_DIR/rc/rc-start"
  IO_RC_EXEC="$IO_FACTORY_CONTROL_PLANE_DIR/rc/rc-exec"
  IO_RC_CLEANUP="$IO_FACTORY_CONTROL_PLANE_DIR/rc/rc-cleanup"
  IO_REACT_USEEFFECT_SKILL_MD="$IO_FACTORY_CONTROL_PLANE_DIR/react-useeffect-SKILL.md"
  export IO_FACTORY_CONTROL_PLANE_DIR IO_FACTORY_SHIP_CONTROL_PLANE_DIR IO_CONVERGE_VECTOR_SH IO_WORK_TICKET_ORCHESTRATOR_JS \
    IO_WORK_TICKET_UNDERSTAND_JS \
    IO_WORK_TICKET_BUILD_AND_SHIP_JS IO_WORK_TICKET_SHIP_JS IO_CONTRACT_FIDELITY_MD IO_REVIEW_PLAN_MD \
    IO_ADD_TESTS_SKILL_MD IO_BUGBOT_MD IO_FETCH_GITLAB_TOKEN_SH \
    IO_RC_START IO_RC_EXEC IO_RC_CLEANUP IO_REACT_USEEFFECT_SKILL_MD \
    IO_VERIFY_SH IO_PUBLISH_SH IO_SOURCE_SH IO_PROOF_SH
}
if ! pin_factory_control_plane; then
  echo "[io-coding-agent-js] FAIL: could not snapshot the deployed factory control plane" >&2
  exit 1
fi
if [ -f "$IO_FACTORY_CONTROL_PLANE_DIR/cli/files/lib/signed-webhook.sh" ]; then
  . "$IO_FACTORY_CONTROL_PLANE_DIR/cli/files/lib/signed-webhook.sh"
fi
# A wrapper death must remove the snapshot and any later background processes. Install the one
# EXIT trap before the first post-snapshot failure path; every variable is unset-safe.
trap 'kill "${TRAIL_TAILER_PID:-}" 2>/dev/null || true; kill "${HEARTBEAT_PID:-}" 2>/dev/null || true; kill "${STEERING_BRIDGE_PID:-}" 2>/dev/null || true; kill "${CLAUDE_PID:-}" 2>/dev/null || true; if command -v emit_ai_spend_usage >/dev/null 2>&1; then emit_ai_spend_usage || true; fi; exec 3>&- 2>/dev/null || true; rm -f "${IO_INBOX_PIPE:-}" "${IO_STALL_FLAG:-}" "${IO_CONVERGE_ACTIVE:-}" "${IO_CONVERGE_VECTOR_ERR:-}" "${IO_CONVERGE_FETCH_OUTPUT:-}" 2>/dev/null || true; rm -f "${IO_STEERING_DISARM_FILE:-}" "${IO_HB_DISARM_FILE:-}" 2>/dev/null || true; if [ -n "${IO_FACTORY_CONTROL_PLANE_DIR:-}" ]; then rm -rf -- "$IO_FACTORY_CONTROL_PLANE_DIR"; fi; if [ -n "${IO_FACTORY_SHIP_CONTROL_PLANE_DIR:-}" ]; then rm -rf -- "$IO_FACTORY_SHIP_CONTROL_PLANE_DIR"; fi' EXIT

# A hosted sandbox boots a stock image that has Node but not gh or claude; install what is missing before the first turn.
if [ "${IS_SANDBOX:-}" = "1" ] && ! bash "${IO_FACTORY_TOOLS_SH:-${IO_FACTORY_SOURCE_DIR:-${IO_REPO_DIR:-/workspace/repo}}/tools/factory/tools.sh}" ensure; then
  echo "[io-coding-agent-js] FAIL: the sandbox is missing a tool the factory needs (see factory-tools lines above)" >&2
  exit 1
fi

# The `claude` CLI authenticates via ANTHROPIC_API_KEY, but the coding-agent worker task
# definition provides the key as CLAUDE_API_KEY (an SSM secret) and does NOT export the former.
# Bridge them so the headless `claude -p` below is logged
# in. Fail fast and loud if neither is set, rather than letting claude exit with an opaque
# "Not logged in · Please run /login".
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${CLAUDE_API_KEY:-}}"
if [ -z "$ANTHROPIC_API_KEY" ]; then
  # A developer running /work-ticket has no key: the CLI authenticates through its own login
  # instead, and an exported EMPTY key would override that and force the very "Not logged in"
  # this guard exists to pre-empt. Only a keyless environment with no login (the worker) is fatal.
  if security find-generic-password -s 'Claude Code-credentials' >/dev/null 2>&1 \
     || [ -s "$HOME/.claude/.credentials.json" ]; then
    unset ANTHROPIC_API_KEY
    echo "[io-coding-agent-js] no API key set — using the claude CLI's own login" >&2
  else
    echo "[io-coding-agent-js] FAIL: no ANTHROPIC_API_KEY or CLAUDE_API_KEY set, and the claude CLI is not logged in" >&2
    exit 1
  fi
fi

# Run git + glab as the RESPONSIBLE USER (the Linear ticket's creator/assignee) when the
# orchestrated job supplies GITLAB_USER_TOKEN, so the MR is authored by them and not the
# claude-workers bot. The entrypoint already configured git (url.insteadOf) and the container's
# GITLAB_TOKEN from the task-definition SSM *secret* (the bot token) — and a RunTask env override
# can't supersede a same-named secret, which is why the user's token arrives under GITLAB_USER_TOKEN
# instead. Re-point BOTH git (which determines MR authorship on push) and glab to it, and set the
# git commit identity (GITLAB_USER_NAME/GITLAB_USER_EMAIL) so the COMMITS are attributed to them too
# — not just the MR. When the token is absent we leave the entrypoint's bot config in place (fallback).
GITLAB_USER_TOKEN="${GITLAB_USER_TOKEN:-}"
GITLAB_USER_NAME="${GITLAB_USER_NAME:-}"
GITLAB_USER_EMAIL="${GITLAB_USER_EMAIL:-}"

# Shared git/glab auth helper, sourced here AND by the JS pipeline's ship-time
# shells (path exported below). The user OAuth token has a fixed 2h TTL, so runs
# longer than that fetch a fresh USER token at Ship entry over the HMAC webhook
# channel and re-point to it (sessions 8971/9289/9293 died on error=push_failed at
# ~2h17m). Path is workDir-independent on purpose: workDir is a JS-side concept and
# this file is written under `set -u`.
export IO_GITLAB_HELPER_SH="${TMPDIR:-/tmp}/io-gitlab-auth.sh"
cat > "$IO_GITLAB_HELPER_SH" <<'IOGITLABEOF'
# Re-point git + glab to <token>. Called at launch with the user OAuth token and by
# the ship-time refresh with the freshly fetched one. Drops ALL existing insteadOf
# sections first: git resolves a duplicate prefix to whichever section appears first
# in the file, so the new token's section must be the only one claiming
# https://gitlab.com/. --add keeps both the https:// and git@ prefixes on that
# section. Never prints token material.
repoint_gitlab_auth() {
  local token="$1"
  [ -n "$token" ] || { echo "[gitlab-auth] no token supplied" >&2; return 1; }
  # Scoped to gitlab.com: an unfiltered sweep also removes the github.com section, so a mid-run
  # token refresh would strand every later git call on a GitHub forge with no credential.
  git config --global --get-regexp '^url\..*\.insteadof$' 2>/dev/null \
    | grep -E '^url\.[^ ]*gitlab\.com' \
    | sed -E 's/^url\.(.*)\.insteadof .*/\1/' | sort -u \
    | while read -r base; do git config --global --remove-section "url.$base" 2>/dev/null; done
  git config --global url."https://oauth2:${token}@gitlab.com/".insteadOf "https://gitlab.com/"
  git config --global --add url."https://oauth2:${token}@gitlab.com/".insteadOf "git@gitlab.com:"
  # Keep expiry future because glab 1.80.4 requires it, while the refresh token stays unavailable here.
  glab config set oauth2_expiry_date "01 Jan 68 00:00 UTC" --host gitlab.com \
    && glab config set token "$token" --host gitlab.com \
    && glab config set is_oauth2 true --host gitlab.com \
    || echo "[gitlab-auth] glab config set failed (git insteadOf still re-pointed)" >&2
  # glab reads GITLAB_TOKEN ahead of its config file, so the launch token in the environment
  # outlives its own 2h TTL and shadows every refresh. Exporting the new one only fixes THIS
  # process: the model's Bash calls are fresh children of the long-lived `claude` process and
  # keep the launch value forever, so they 401 no matter how many times they refresh. Unset it
  # and the on-disk config — written just above, and readable from any process — is the only
  # source.
  unset GITLAB_TOKEN
}

# The token glab would present right now. Reads the config rather than the environment for the
# same reason repoint unsets it: the env copy is the stale one.
current_gitlab_token() {
  glab config get token --host gitlab.com 2>/dev/null
}

# Fetch a fresh USER token over the HMAC webhook channel and re-point to it.
# Returns 1 (fetch error on stderr, which contains no token) when the fetch fails —
# callers keep going on the launch token / propagate their original failure.
# Publishes the server's expiry (epoch, 0 when it reported none) in IO_GITLAB_TOKEN_EXP,
# scoped to THIS process on purpose: it describes the token this call installed, and a caller
# in another process installed a different one.
# Call as `refresh_user_gitlab_auth rejected` ONLY from a 401 path: that names the token we
# hold so the server rotates instead of handing the same one back — a credential revoked at
# GitLab still reads as live on the server's local clock, so an unqualified re-fetch after a
# 401 returns the corpse every time (sessions 13185, 13247). Routine refreshes must NOT pass
# it: rotating a healthy token revokes it for every concurrent run of the same user.
refresh_user_gitlab_auth() {
  local out t rejected=""
  [ "${1:-}" = "rejected" ] && rejected="$(current_gitlab_token)"
  IO_GITLAB_TOKEN_EXP=0
  out="$(bash "${IO_FETCH_GITLAB_TOKEN_SH:-${IO_FACTORY_SOURCE_DIR:-${IO_REPO_DIR:-/workspace/repo}}/cli/files/fetch-gitlab-token.sh}" "$rejected")" || return 1
  { IFS= read -r t; IFS= read -r IO_GITLAB_TOKEN_EXP; } <<< "$out"
  [ -n "$t" ] || return 1
  # Digits only: a stray non-epoch would reach an arithmetic compare in the convergence loop.
  IO_GITLAB_TOKEN_EXP="$(printf '%s' "${IO_GITLAB_TOKEN_EXP:-}" | tr -cd '0-9')"
  IO_GITLAB_TOKEN_EXP="${IO_GITLAB_TOKEN_EXP:-0}"
  repoint_gitlab_auth "$t"
}

# Retry-once wrapper: run <cmd...>; on an auth-shaped failure, refresh + retry ONCE.
# errexit-safe; always surfaces the command's output (successful pushes must emit
# the remote: lines the mr_iid gate parses — the retry's output streams uncaptured
# for the same reason); always prints the ORIGINAL error before failing. The
# auth-detection regex lives here and only here; the broad patterns can
# false-positive on non-auth stderr, which costs one wasted fetch before the true
# error propagates — cheaper than the miss, which retries a dead token forever.
# `glab` prints a bare `401 {message: 401 Unauthorized}` with no "HTTP" prefix, so an
# `HTTP 401`-only pattern never fires on the API failure this exists to catch.
io_with_gitlab_refresh() {
  local out rc=0
  out="$(mktemp "${TMPDIR:-/tmp}/io-gitlab-refresh.XXXXXX")"
  "$@" > "$out" 2>&1 || rc=$?
  cat "$out"
  if [ "$rc" -ne 0 ] && grep -qiE '401|403|unauthorized|forbidden|authentication|access denied|expired' "$out"; then
    if refresh_user_gitlab_auth rejected; then
      echo "[gitlab-refresh] fetched fresh user token; retrying"
      if "$@"; then rc=0; else echo "[gitlab-refresh] original failure was:" >&2; cat "$out" >&2; rm -f "$out"; return 1; fi
    else
      echo "[gitlab-refresh] original failure was:" >&2; cat "$out" >&2; rm -f "$out"; return 1
    fi
  fi
  rm -f "$out"
  return "$rc"
}
io_git_push_with_gitlab_refresh() { io_with_gitlab_refresh git push "$@"; }
io_glab_with_gitlab_refresh()     { io_with_gitlab_refresh glab "$@"; }

# An expired token is VALID JSON ({"message":"401 Unauthorized"}), so auth failure is
# "not the array success shape": invalid JSON, or an object whose message reads like an
# auth error. Arrays (even empty) mean the request itself was authorized.
gitlab_response_needs_auth_refresh() {
  ! printf '%s' "$1" | jq -e . >/dev/null 2>&1 && return 0
  printf '%s' "$1" | jq -e '
    type == "object" and ((.message // "" | tostring) | test("401|403|unauthorized|forbidden|expired|token"; "i"))
  ' >/dev/null 2>&1
}

# JSON-safe read wrapper. io_with_gitlab_refresh MERGES stderr into stdout and echoes its own
# retry line there, which is deliberate for a push (the mr_iid gate parses `remote:` lines) and
# fatal for a captured read: past the user token's 2h TTL, `x=$(io_glab_with_gitlab_refresh api
# … ) | jq` is handed a 401 body, then a log line, then the real JSON, so jq returns the wrong
# document and a HEALTHY MR reads as unreadable. Here stdout carries the response and ONLY the
# response; every diagnostic goes to fd 2.
#
# TWO failure codes, because one cannot carry the distinction: gitlab_response_needs_auth_refresh
# treats any non-success SHAPE as refresh-worthy (an expired token is valid JSON), so it fires on
# malformed data too. 78 = the read did not succeed even after one refresh — an infrastructure
# escalation, never a fail-closed condition verdict, which would report a healthy MR as unready.
# 79 = the read SUCCEEDED but its body will not parse — a genuine unreadable, which takes the
# condition's own fail-closed disposition. Collapsing them would escalate a garbled body as an
# expired token. The timeout is an argument so no read can wedge a caller.
io_glab_json_with_refresh() {   # usage: io_glab_json_with_refresh <timeout_s> api <path...>
  local t="$1"; shift
  local json rc=0 gerr
  # glab's own message is the only thing that says WHY a read failed, and discarding it made every
  # fault — DNS, a missing binary, a 500 — arrive at the caller as rc 78 and get reported as an
  # expired token. Keep it, on stderr, where the caller can surface it.
  gerr="$(mktemp "${TMPDIR:-/tmp}/io-glab-err.XXXXXX")"
  json="$(timeout "$t" glab "$@" 2>"$gerr")" || rc=$?
  if [ "$rc" -eq 0 ] && ! gitlab_response_needs_auth_refresh "$json"; then rm -f "$gerr"; printf '%s' "$json"; return 0; fi
  if type refresh_user_gitlab_auth >/dev/null 2>&1 && refresh_user_gitlab_auth rejected >&2; then
    echo "[gitlab-refresh] fetched fresh user token; retrying read" >&2
    rc=0; json="$(timeout "$t" glab "$@" 2>"$gerr")" || rc=$?
    if [ "$rc" -eq 0 ] && ! gitlab_response_needs_auth_refresh "$json"; then rm -f "$gerr"; printf '%s' "$json"; return 0; fi
  fi
  [ -s "$gerr" ] && sed 's/^/[glab] /' "$gerr" | tail -n 5 >&2
  printf '%s' "$json"
  if [ "$rc" -eq 0 ] && ! printf '%s' "$json" | jq -e . >/dev/null 2>&1; then rm -f "$gerr"; return 79; fi
  # 78 is the AUTH escalation. A failure with no auth marker anywhere is an infrastructure fault
  # wearing an auth label, which is what sent a whole day of debugging at the wrong subsystem.
  if grep -qiE '401|403|unauthorized|forbidden|authentication|access denied|expired' "$gerr" 2>/dev/null \
     || grep -qiE '401|403|unauthorized|forbidden' <<< "$json"; then
    rm -f "$gerr"; return 78
  fi
  rm -f "$gerr"
  return 77
}

# A linked-user ECS run must prove its credential through the same refresh-aware path every later
# phase uses; otherwise it can spend the full workflow before discovering GitLab was dead at launch.
bootstrap_user_gitlab_auth() {
  [ -n "${GITLAB_USER_TOKEN:-}" ] || return 0
  [ -n "${CODING_AGENT_TASK_ID:-}" ] && [ -n "${INTERNAL_WEBHOOK_SECRET:-}" ] || return 0
  io_glab_json_with_refresh 30 api user >/dev/null || return 1
}
IOGITLABEOF

# Sourced unconditionally: it only DEFINES functions, and the main body's recovery tier needs
# gitlab_response_needs_auth_refresh even on a bot-token run that never repoints.
. "$IO_GITLAB_HELPER_SH"
if [ -n "$GITLAB_USER_TOKEN" ]; then
  repoint_gitlab_auth "$GITLAB_USER_TOKEN"
  if ! bootstrap_user_gitlab_auth; then
    echo "[io-coding-agent] FAIL: linked-user GitLab credential could not be verified after refresh" >&2
    exit 1
  fi
  # Attribute the commits to the responsible user, not just the MR: without a git identity the
  # commits carry the container's default author. Only set it alongside the user token so auth and
  # authorship stay consistent (a bot-token fallback keeps the bot identity).
  [ -n "$GITLAB_USER_NAME" ] && git config --global user.name "$GITLAB_USER_NAME"
  [ -n "$GITLAB_USER_EMAIL" ] && git config --global user.email "$GITLAB_USER_EMAIL"
  echo "[io-coding-agent] git + glab configured to push as the linked user"
fi

# Authenticate glab separately from git for MR creation and post-Ship API calls. Linked-user runs
# were configured above; rewriting from GITLAB_USER_TOKEN here would replace a refresh with the
# stale launch token. The bot fallback stays in a shell variable and is never printed.
GITLAB_TOKEN="${GITLAB_TOKEN:-}"
if [ -z "$GITLAB_USER_TOKEN" ]; then
  if [ -z "$GITLAB_TOKEN" ]; then
    GITLAB_TOKEN=$(git config --global --get-regexp 'url.*insteadof' 2>/dev/null \
      | grep -o 'oauth2:[^@]*' | head -1 | sed 's/^oauth2://')
  fi
  if [ -n "$GITLAB_TOKEN" ]; then
    glab config set token "$GITLAB_TOKEN" --host gitlab.com 2>/dev/null
  fi
fi
# Everything below — including every model Bash call — must reach glab through the config just
# written, never through the environment. A surviving GITLAB_TOKEN is inherited by the `claude`
# process and then by each of its Bash children, where no later refresh can reach it, so it
# outlives its own TTL and 401s forever while the config sitting next to it is perfectly valid.
unset GITLAB_TOKEN

# Must run after repoint_gitlab_auth above, which first removes EVERY url.*.insteadOf section.
if [ -n "${IO_GITHUB_TOKEN:-}" ]; then
  repoint_github_auth "$IO_GITHUB_TOKEN"
  echo "[io-coding-agent] git configured to reach github.com with IO_GITHUB_TOKEN"
fi

IO_PROMPT="${IO_PROMPT:-}"
IO_PROMPT_MODE="${IO_PROMPT_MODE:-}"
IO_RUN_SLUG="${IO_RUN_SLUG:-}"
IO_PROMPT_S3_URI="${IO_PROMPT_S3_URI:-}"
TICKET_ID="${1:-${IO_TICKET_ID:-}}"
IO_FACTORY_PROTOCOL=2
# Captured before the blanking below: a loop-launched run passes its minted id in this variable.
IO_FACTORY_LAUNCH_SESSION_ID="${IO_FACTORY_SESSION_ID:-}"
IO_FACTORY_SESSION_ID=""
IO_FACTORY_BRANCH=""

# The ECS session is the only owner of a normal factory branch. Ticket-derived branch names are
# reusable across retries; the numeric session id is not, so it is the identity boundary that
# prevents one run from adopting or deleting another run's MR.
derive_factory_run_identity() {
  local url="${CODING_AGENT_SESSION_URL:-}" session_id prefix
  IO_FACTORY_LOOP_LAUNCHED=""
  if [ -z "$url" ]; then
    # A loop-launched run has no ECS session; the loop mints the numeric identity and passes it in.
    session_id="${IO_FACTORY_LAUNCH_SESSION_ID:-}"
    case "$session_id" in ''|0*|*[!0-9]*) return 1 ;; esac
    IO_FACTORY_LOOP_LAUNCHED=1
  else
    url="${url%/}"
    session_id="${url##*/}"
    case "$session_id" in ''|*[!0-9]*) return 1 ;; esac
    case "$url" in */coding_agent_sessions/"$session_id") ;; *) return 1 ;; esac
  fi
  if [ -n "$TICKET_ID" ]; then
    prefix="$(printf '%s' "$TICKET_ID" | tr '[:upper:]' '[:lower:]')"
  else
    prefix="factory"
  fi
  IO_FACTORY_SESSION_ID="$session_id"
  IO_FACTORY_BRANCH="${prefix}-s${session_id}"
  export IO_FACTORY_PROTOCOL IO_FACTORY_SESSION_ID IO_FACTORY_BRANCH IO_FACTORY_LOOP_LAUNCHED
}

# Orchestrated prompt runs pass the prompt BY REFERENCE (IO_PROMPT_MODE=true +
# IO_PROMPT_S3_URI pointing at the run's resources prompt.md) to dodge the ECS env-var
# size limit — download it when not supplied inline.
PROMPT_FILE="${TMPDIR:-/tmp}/io-agent-prompt-${IO_RUN_SLUG:-input}.txt"
S3_PROMPT_FETCHED=false
if [ "$IO_PROMPT_MODE" = "true" ] && [ -z "$IO_PROMPT" ] && [ -n "$IO_PROMPT_S3_URI" ]; then
  # Fetch straight to the prompt file (byte-for-byte; command substitution would strip trailing
  # newlines), with aws stderr flowing so a failure names its cause (AccessDenied/NoSuchKey/
  # network) in CloudWatch, and gate on BOTH the aws exit code and non-emptiness so a failed or
  # truncated download can never launch the ~30-min pipeline on a garbage prompt. aws stdout is
  # routed to stderr so its progress lines can't touch the ^BRANCH:/^MR: stdout contract.
  if ! aws s3 cp "$IO_PROMPT_S3_URI" "$PROMPT_FILE" >&2 || [ ! -s "$PROMPT_FILE" ]; then
    echo "[io-coding-agent-js] FAIL: could not fetch prompt from ${IO_PROMPT_S3_URI} (download failed or object empty)" >&2
    exit 1
  fi
  S3_PROMPT_FETCHED=true
fi

# slackThread tells the JS pipeline to post threaded per-phase updates — ONLY when an actual
# Slack thread is wired (the ECS path). Absent locally ⇒ the pipeline's slackPhase is a no-op.
if [ -n "${SLACK_THREAD_TS:-}" ]; then SLACK_THREAD=true; else SLACK_THREAD=false; fi
# Slack milestone posts are agent() calls, so a local run with no bot token would spend spawns
# producing nothing. The /work-ticket skill launches with this false.
# A feedback re-run reuses the prior run's workspace (same branch/MR) and folds the user's
# notes in; both are omitted from the args when blank so a fresh run is unaffected.
IO_NOTIFY_SLACK="${IO_NOTIFY_SLACK:-true}"
case "$IO_NOTIFY_SLACK" in true|false) ;; *) IO_NOTIFY_SLACK=true ;; esac

# A malformed field is OMITTED so the workflow refuses rather than files onto the wrong board.
case "${IO_FOLLOWUPS_ENABLED:-}" in true|false) ;; *) IO_FOLLOWUPS_ENABLED="" ;; esac
case "${IO_FOLLOWUP_PRIORITY:-}" in ''|*[!0-9]*) IO_FOLLOWUP_PRIORITY="" ;; esac
# Without the `||` default, a jq failure here would empty `--argjson fu` and kill the MAIN args build.
FOLLOWUP_ARGS=$(jq -nc --arg en "${IO_FOLLOWUPS_ENABLED:-}" --arg tm "${IO_FOLLOWUP_TEAM_ID:-}" \
  --arg st "${IO_FOLLOWUP_STATE_ID:-}" --arg pr "${IO_FOLLOWUP_PRIORITY:-}" \
  '(if $en != "" then {followupsEnabled: ($en == "true")} else {} end)
   + (if $tm != "" then {followupTeamId:$tm} else {} end)
   + (if $st != "" then {followupStateId:$st} else {} end)
   + (if $pr != "" then {followupPriority: ($pr|tonumber)} else {} end)') || FOLLOWUP_ARGS='{}'

# Build the orchestrator's args. ticket XOR prompt (the workflow rejects both).
# orchestrated:true marks this an ECS launch — the pipeline's dirty-base auto-recovery
# (git reset --hard) is gated on it and must never fire for a local run's working tree.
# It must be an ARG: the workflow sandbox has no process/env, so the pipeline can't read env itself.
# Conflict mode is checked FIRST: a conflict run passes no $1 and no prompt, only env from the sweep's dispatch path.
IO_WORKFLOW_MODE="${IO_WORKFLOW_MODE:-}"
IO_MR_IID="${IO_MR_IID:-}"
if [ -n "${IO_FACTORY_HANDOFF_ONLY_ARGS:-}" ]; then
  if [ -n "${CODING_AGENT_SESSION_URL:-}" ]; then
    echo "[handoff-only] refusing to run inside an ECS coding-agent session" >&2
    exit 2
  fi
  ARGS="$(jq -ce --arg cp "$IO_FACTORY_CONTROL_PLANE_DIR" '
    select(type == "object")
    | . + {startPhase:"ship", orchestrated:false, notifySlack:false, slackThread:false,
      factoryControlPlaneDir:$cp}' "$IO_FACTORY_HANDOFF_ONLY_ARGS" 2>/dev/null)" || {
      echo "[handoff-only] invalid args" >&2
      exit 2
    }
  RUN_LABEL="handoff-only"
elif [ -n "${IO_FACTORY_SHIP_ONLY_ENVELOPE:-}" ]; then
  ARGS='{}'
  RUN_LABEL="ship-only"
elif [ "$IO_WORKFLOW_MODE" = "conflict" ]; then
  # The conflict concierge is not part of this repository's factory; fail before any work starts.
  echo "[io-coding-agent-js] FAIL: IO_WORKFLOW_MODE=conflict is not supported by this factory" >&2
  exit 2
elif [ "$IO_PROMPT_MODE" = "true" ] || { [ -z "$TICKET_ID" ] && [ -n "$IO_PROMPT" ]; }; then
  if ! derive_factory_run_identity; then
    echo "[io-coding-agent-js] FAIL: normal factory runs require a numeric CODING_AGENT_SESSION_URL" >&2
    exit 2
  fi
  if [ "$S3_PROMPT_FETCHED" != "true" ]; then
    if [ -z "$IO_PROMPT" ]; then
      echo "[io-coding-agent-js] prompt mode but no prompt (IO_PROMPT empty and no IO_PROMPT_S3_URI)" >&2
      exit 1
    fi
    # Hand the prompt to the orchestrator BY FILE, not inline in the claude prompt below. A multi-KB
    # free-text spec embedded in the headless `claude -p` instruction was being dropped or rewritten
    # (claude sometimes synthesized a bogus ticketId or omitted the prompt entirely), so the
    # orchestrator rejected it as bad_input/invalid_ticket_id. claude now only forwards a short file
    # path; the orchestrator reads the file via a one-line shell agent (it has no direct fs access).
    printf '%s' "$IO_PROMPT" > "$PROMPT_FILE"
  fi
  ARGS=$(jq -nc --arg pf "$PROMPT_FILE" --argjson st "$SLACK_THREAD" --argjson ns "$IO_NOTIFY_SLACK" \
    --arg fb "${IO_FEEDBACK:-}" --arg wd "${IO_WORK_DIR:-}" --arg cp "$IO_FACTORY_CONTROL_PLANE_DIR" \
    --argjson protocol "$IO_FACTORY_PROTOCOL" --argjson session "$IO_FACTORY_SESSION_ID" --arg branch "$IO_FACTORY_BRANCH" \
    --argjson fu "$FOLLOWUP_ARGS" \
    '{promptFile:$pf, notifySlack:$ns, slackThread:$st, orchestrated:true, factoryControlPlaneDir:$cp,
      factoryProtocol:$protocol, factorySessionId:$session, factoryBranch:$branch}
   + $fu
   + (if $fb != "" then {feedback:$fb} else {} end)
   + (if $wd != "" then {workDir:$wd} else {} end)')
  RUN_LABEL="prompt run"
elif [ -n "$TICKET_ID" ]; then
  if ! derive_factory_run_identity; then
    echo "[io-coding-agent-js] FAIL: normal factory runs require a numeric CODING_AGENT_SESSION_URL" >&2
    exit 2
  fi
  ARGS=$(jq -nc --arg t "$TICKET_ID" --argjson st "$SLACK_THREAD" --argjson ns "$IO_NOTIFY_SLACK" \
    --arg fb "${IO_FEEDBACK:-}" --arg wd "${IO_WORK_DIR:-}" --arg cp "$IO_FACTORY_CONTROL_PLANE_DIR" \
    --argjson protocol "$IO_FACTORY_PROTOCOL" --argjson session "$IO_FACTORY_SESSION_ID" --arg branch "$IO_FACTORY_BRANCH" \
    --argjson fu "$FOLLOWUP_ARGS" \
    '{ticketId:$t, notifySlack:$ns, slackThread:$st, orchestrated:true, factoryControlPlaneDir:$cp,
      factoryProtocol:$protocol, factorySessionId:$session, factoryBranch:$branch}
   + $fu
   + (if $fb != "" then {feedback:$fb} else {} end)
   + (if $wd != "" then {workDir:$wd} else {} end)')
  RUN_LABEL="$TICKET_ID"
else
  echo "Usage: bash .claude/io-coding-agent-js.sh <TICKET_ID>  (or set IO_PROMPT / IO_PROMPT_MODE=true)" >&2
  exit 2
fi

if [ -n "${IO_FACTORY_HANDOFF_ONLY_ARGS:-}" ]; then
  echo "[io-coding-agent-js] running production Ship handoff in local-only mode" >&2
  PROMPT="Call the Workflow tool exactly once with scriptPath '${IO_WORK_TICKET_BUILD_AND_SHIP_JS}' and args set to EXACTLY this JSON object, copied verbatim — do not add, remove, rename, or edit any field: ${ARGS}. Let it run to completion and do not take any other action before or after. When it returns, print its complete JSON result EXACTLY between these markers and print nothing after the closing marker:
===IO_RESULT_BEGIN===
<the workflow's returned JSON>
===IO_RESULT_END==="
elif [ -n "${IO_FACTORY_SHIP_ONLY_ENVELOPE:-}" ]; then
  PROMPT=""
else
  echo "[io-coding-agent-js] running work-ticket-orchestrator for ${RUN_LABEL} (slackThread=${SLACK_THREAD})" >&2

  # The orchestrator does the whole job (branch + MR). We ask claude to print the result between
  # sentinels so we can read it deterministically; git/glab below is the authoritative fallback.
  PROMPT="Call the Workflow tool exactly once with scriptPath '${IO_WORK_TICKET_ORCHESTRATOR_JS}' and args set to EXACTLY this JSON object, copied verbatim — do not add, remove, rename, or edit any field (in particular, do NOT invent a ticketId): ${ARGS}. Let it run to completion — it creates a branch and a GitLab MR (or detects the fix is already on master). Do not take any other action before or after, with ONE exception — steering messages: if a user message framed '[steering message from <author> via session mailbox]' arrives while the workflow runs, it is guidance from the run's owner injected via the session mailbox. The frame carries a severity tag: '[STEERING — DIRECTIVE: a disposition is required before Ship]' means you must act on it or explicitly acknowledge why not before shipping; '[STEERING — ADVISORY: informational]' is informational only. Treat it as the owner speaking: weigh it against the ticket (it does not automatically override the ticket — if the two conflict, use your judgment and say which you followed and why), act on it, and acknowledge in the run's Slack thread what you are changing: post ONE threaded reply via curl to the Slack chat.postMessage API using the SLACK_BOT_TOKEN, SLACK_CHANNEL_ID and SLACK_THREAD_TS environment variables (thread_ts is SLACK_THREAD_TS; keep the token in a shell variable only, never echo it, redirect curl stderr to /dev/null); if any of that env is absent, skip the Slack post. When it returns, print its result EXACTLY between these markers and print nothing after the closing marker:
===IO_RESULT_BEGIN===
If the result has already_fixed true: print 'already_fixed=true'; then if it has a fixed_commit print 'fixed_commit=<the sha>' on the next line, and if it has fixed_evidence print 'fixed_evidence=<the evidence, collapsed to one line>' on the line after, and if it has a non-empty duplicate_of print 'duplicate_of=<the id>' on the line after — print these even when the result ALSO has an mr_iid.
If the result has an mr_iid: print 'branch=<branch>' on one line and 'mr=<mr iid number>' on the next (co-printed after the already_fixed lines when both apply); if it ALSO has an error field, print 'error=<the error field>' on the line after.
If the result has NEITHER already_fixed true NOR an mr_iid: if the result has a status field print 'status=<the status field>'; if it has an error field print 'error=<the error field>' on the next line.
===IO_RESULT_END==="
fi

OUT="${TMPDIR:-/tmp}/io-coding-agent-js.out"
# Set before the heartbeat poller forks: it captures these at fork time and its byte-offset flush needs both files empty.
ERR="${ERR:-${OUT}.err}"
IO_FLUSH_MAX_BYTES="${IO_FLUSH_MAX_BYTES:-200000}"
: > "$OUT"
: > "$ERR"
# The Workflow tool runs ASYNCHRONOUSLY — it returns immediately and notifies on completion — so the
# headless run has to wait for that completion. claude -p caps how long it waits on outstanding
# background work (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, default 600s) and then exits; the orchestrator
# takes far longer (~30 min), so claude was bailing before the workflow returned its branch/MR result
# ("no MR found", claude exit 0). Wait indefinitely instead — the run is bounded by the ECS task and
# the session's 24h completion check.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
# Shared secret scrubber: ONE owner for the token shapes redacted from anything this wrapper
# prints from transcript content — the end-of-run dump below AND the heartbeat's stall dumps
# (a mid-run exfil surface, hence gloas- OAuth access tokens are covered too). Defined before
# the pollers fork: subshells capture functions at fork time.
scrub_stream() {
  sed -E 's/(xox[abp]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|arga_sk_[A-Za-z0-9_-]+|Bearer [A-Za-z0-9._-]+|lin_api_[A-Za-z0-9]+|sk-ant-[A-Za-z0-9._-]+|oauth2:[^@[:space:]]+@|x-access-token:[^@[:space:]]+@|glpat-[A-Za-z0-9_-]+|gloas-[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+)/[REDACTED]/g'
}

# Emit one content-free "[ai-spend] {json}" usage marker per completed Claude invocation, from the
# result events in a stream-json output file. The workflow keeps stream-json in private files (the
# CloudWatch mirror truncates lines to 500 chars), so without these markers the task log carries no
# parseable usage. AiSpend::CodingAgentTaskCost parses them nightly; last marker per invocation_id
# wins there, so a re-emit at EXIT can't double-count and agent output can't shadow the wrapper's
# trailing markers. Best-effort by design: jq failure or a missing file must never fail the task.
# schema_version 2 carries the per-model token/cost breakdown (result.modelUsage), the 1h/5m
# cache-write split, service tier, and fast-mode state — enough to RECOMPUTE cost from any rate
# card later instead of trusting the CLI's bundled pricing table, and to reconcile token counts
# per model against the Anthropic Admin usage report. Cost/token scalars only, never content.
emit_ai_spend_file() {
  local file="$1" prefix="$2"
  [ -f "$file" ] || return 0
  # Bound the parse: the EXIT trap must never stall task teardown on a multi-GB
  # stream file (coreutils timeout exists on the Fargate image; absent locally on macOS).
  local runner=(jq)
  command -v timeout >/dev/null 2>&1 && runner=(timeout 25 jq)
  "${runner[@]}" -Rnrc --arg prefix "$prefix" '
    def count($value):
      $value | if type == "number" and . >= 0 then floor else 0 end;
    foreach (
      inputs
      | fromjson?
      | select(type == "object" and .type == "result")
      | select((.total_cost_usd | type) == "number" and .total_cost_usd >= 0)
    ) as $event (
      0;
      . + 1;
      {
        schema_version: 2,
        invocation_id: "\($prefix):\(.)",
        cost_usd: $event.total_cost_usd,
        input_tokens: count($event.usage.input_tokens // 0),
        output_tokens: count($event.usage.output_tokens // 0),
        cache_read_tokens: count($event.usage.cache_read_input_tokens // 0),
        cache_write_tokens: count($event.usage.cache_creation_input_tokens // 0),
        cache_write_1h_tokens: count($event.usage.cache_creation.ephemeral_1h_input_tokens // 0),
        cache_write_5m_tokens: count($event.usage.cache_creation.ephemeral_5m_input_tokens // 0),
        service_tier: (if ($event.usage.service_tier | type) == "string" then $event.usage.service_tier else null end),
        fast_mode: (if ($event.fast_mode_state | type) == "string" then $event.fast_mode_state else null end),
        models: (
          ($event.modelUsage // {})
          | with_entries(.value |= {
              input_tokens: count(.inputTokens // 0),
              output_tokens: count(.outputTokens // 0),
              cache_read_tokens: count(.cacheReadInputTokens // 0),
              cache_write_tokens: count(.cacheCreationInputTokens // 0),
              cost_usd: (if (.costUSD | type) == "number" and .costUSD >= 0 then .costUSD else 0 end)
            })
        )
      }
    )
  ' "$file" 2>/dev/null | sed 's/^/[ai-spend] /'
}

# EXIT-trap sweep: re-emit the outer run plus every burst file, so a wrapper death between a
# burst's immediate emission and normal teardown still ships whatever usage reached disk.
emit_ai_spend_usage() {
  local n=1 burst_count="${BURST_N:-0}"
  [ -n "${OUT:-}" ] || return 0
  emit_ai_spend_file "$OUT" outer
  case "$burst_count" in '' | *[!0-9]*) return 0 ;; esac
  while [ "$n" -le "$burst_count" ]; do
    emit_ai_spend_file "${OUT}.burst-${n}" "burst-${n}"
    n=$(( n + 1 ))
  done
}

# Stream the workflow's verification trail into this task's CloudWatch log in (near) real time,
# DETERMINISTICALLY: poll the trail file(s) the workflow already writes and print appended bytes
# to this wrapper's own stdout — which IS the task log. Replaces the agent-side IO_TASK_LOG
# mirror, which delivered ZERO lines on a real Fargate run with no
# channel left to say why — when an agent-side mirror fails, nothing can report the failure, so
# the mirroring is owned HERE, agent-free and /proc-free. The glob is re-evaluated every poll so
# a workDir created mid-run is picked up (.io-agent-<ticket> and .io-agent-prompt-<hash> both
# match .io-agent-*). Contract safety: streamed lines are prefixed "[trail] " and the Rails
# scraper matches ALL contract markers line-anchored (^BRANCH:/^MR: regexes and /^ALREADY_
# FIXED:true$/ — that anchor ships with this change; a substring match would fire on free trail
# text quoting the marker), so no streamed line can be mistaken for the contract. Stop is
# drain-exact: the subshell traps TERM, and bash defers the trap until the in-flight tail|scrub_stream|sed
# pipeline completes (the poll sleep is backgrounded so the trap can interrupt it), so
# stop_trail_tailer's wait returns only after the last tailer byte is written — the contract
# echoes below are writer-exclusive.
start_trail_tailer() {
  (
    trap 'exit 0' TERM
    # Stream from current EOF on files that predate this run (clean-base-reset preserves
    # .io-agent-*, so a reused workspace's prior-attempt trail must not replay as this run's
    # stream); files created after start stream from byte 0 and announce themselves.
    for f in .io-agent-*/verification-trail.md; do
      [ -f "$f" ] || continue
      sz=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
      offvar="OFF_$(printf '%s' "$f" | tr -c 'a-zA-Z0-9' '_')"
      eval "$offvar=\${sz:-0}"
    done
    while true; do
      for f in .io-agent-*/verification-trail.md; do
        [ -f "$f" ] || continue
        sz=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
        offvar="OFF_$(printf '%s' "$f" | tr -c 'a-zA-Z0-9' '_')"
        off=$(eval "printf '%s' \"\${$offvar:-0}\"")
        if [ "${sz:-0}" -gt "$off" ]; then
          [ "$off" = 0 ] && echo "[trail] --- streaming $f"
          # Best-effort at chunk boundaries: this resumes by byte offset, so a token split across two polls is unmatchable.
          tail -c +"$((off + 1))" "$f" | scrub_stream | sed 's/^/[trail] /'
          eval "$offvar=\$sz"
        fi
      done
      sleep 10 & wait $! || true
    done
  ) &
  TRAIL_TAILER_PID=$!
  echo "[io-coding-agent-js] trail streaming armed (poll 10s, pid ${TRAIL_TAILER_PID})" >&2
}
# Bounded final window (deliberately NOT an offset drain — the offsets live in the poll
# subshell): after the tailer stops, re-print each trail file's last 20 lines as
# "[trail:final] ". On a healthy run this duplicates up to 20 already-streamed lines, and a
# >20-line final poll window is only partially covered — this is a safety net; the poll loop is
# the primary channel.
stop_trail_tailer() {
  kill "${TRAIL_TAILER_PID:-}" 2>/dev/null || true
  wait "${TRAIL_TAILER_PID:-}" 2>/dev/null || true
  for f in .io-agent-*/verification-trail.md; do
    [ -f "$f" ] || continue
    tail -n 20 "$f" | scrub_stream | sed 's/^/[trail:final] /'
  done
}
# Heartbeat + stall dump: trail lines above only move at workflow note() flushes, and the
# main-loop transcript ($OUT) idles while the async Workflow tool runs — so a hung agent is
# invisible for hours (observed 2026-07-08: 2h+ dark post-ship). Poll the runtime's
# per-agent transcripts (agent-*.jsonl under this run's PRIVATE config dir — they grow while an
# agent works) and print a liveness line every IO_HB_INTERVAL; when growth stalls past
# IO_STALL_AFTER, dump the newest transcript's scrubbed tail so the hung step's evidence reaches
# CloudWatch BEFORE any kill (SIGTERM delivery to this wrapper is not guaranteed under bash-as-
# PID-1). Lifecycle mirrors the steering bridge (disarm flag + bounded escalating stop) rather
# than start_trail_tailer's TERM trap, because this stop sits on the pre-contract critical path;
# the tailer keeps its trap, whose deferred-TERM drain-exactness is contract-critical.
IO_HB_INTERVAL="${IO_HB_INTERVAL:-300}"
IO_HB_DISARM_FILE="${IO_HB_DISARM_FILE:-$(mktemp -u "${TMPDIR:-/tmp}/io-heartbeat-disarmed.XXXXXXXX")}"
rm -f "$IO_HB_DISARM_FILE"
IO_STALL_AFTER="${IO_STALL_AFTER:-900}"
IO_STALL_REDUMP="${IO_STALL_REDUMP:-1800}"
# Without this $OUT/$ERR only reach CloudWatch after `wait`, so an ECS-torn-down zombie left nothing to autopsy.
flush_appended() {
  local file="$1" var="$2" prefix="$3" off sz start skipped
  # Offsets live in the heartbeat poller's subshell, so an unarmed caller would re-print $OUT's head.
  [ -n "${IO_FLUSH_ARMED:-}" ] || return 0
  [ -n "$file" ] && [ -f "$file" ] || return 0
  # A chunk cut mid-line could split a secret across two flushes, which scrub_stream cannot recognize.
  [ -z "$(tail -c 1 "$file" 2>/dev/null)" ] || return 0
  sz=$(wc -c < "$file" 2>/dev/null | tr -d ' '); sz=${sz:-0}
  off=$(eval "printf '%s' \"\${$var:-0}\"")
  [ "$sz" -gt "$off" ] || return 0
  # Cap from the NEWEST end: this channel exists to leave the run's TAIL in CloudWatch.
  start=$off
  skipped=$(( sz - off - IO_FLUSH_MAX_BYTES ))
  if [ "$skipped" -gt 0 ]; then
    start=$(( sz - IO_FLUSH_MAX_BYTES ))
    echo "${prefix}--- skipped ~${skipped} bytes (per-tick flush cap ${IO_FLUSH_MAX_BYTES})"
    tail -c "+$(( start + 1 ))" "$file" | sed '1d' | scrub_stream | cut -c1-500 | sed "s|^|$prefix|"
  else
    tail -c "+$(( start + 1 ))" "$file" | scrub_stream | cut -c1-500 | sed "s|^|$prefix|"
  fi
  eval "$var=\$sz"
}
flush_stream_tail() {
  flush_appended "${OUT:-}" STREAM_FLUSH_OFF '[claude-out] '
  flush_appended "${ERR:-}" STDERR_FLUSH_OFF '[claude-stderr] '
}
# Stall WATCHDOG (distinct from the stall DUMP above, which only prints evidence). A hung run
# holds a worker until the 3h ECS reaper; this recovers it in minutes. Killing is the
# destructive action here, so the predicate below is deliberately fail-OPEN — the inverse of
# this pipeline's usual fail-closed default — and every knob widens rather than narrows.
IO_STALL_RESTART_AFTER="${IO_STALL_RESTART_AFTER:-900}"
IO_STALL_FLAT_TICKS="${IO_STALL_FLAT_TICKS:-3}"
IO_STALL_RSS_EPSILON_MB="${IO_STALL_RSS_EPSILON_MB:-5}"
IO_STALL_MAX_RESTARTS="${IO_STALL_MAX_RESTARTS:-3}"
IO_STALL_FLAG="${IO_STALL_FLAG:-$(mktemp "${TMPDIR:-/tmp}/io-stall-verdict.XXXXXX")}"
# mktemp CREATES the file; the watchdog keys on non-empty content, not existence.
: > "$IO_STALL_FLAG" 2>/dev/null || true
# The ONLY last_tool values that mean "no tool is executing" — the signature of the upstream
# idle-connection hang (anthropics/claude-code#78966), where the transcript's last entry is an
# ordinary model turn and nothing is running. ANY other value, including a tool name added
# later that nobody classified here, counts as EXECUTING and is left alone: a long test run
# or a nested proof `claude -p` must never be mistaken for a hang. Unknown means healthy.
io_tool_is_nonexecuting() {
  case "${1:-}" in
    StructuredOutput) return 0 ;;
    *) return 1 ;;
  esac
}
# First "<comm>:<N>MB" entry of the heartbeat's top_rss string; empty when unparseable.
io_rss_mb() { printf '%s' "${1:-}" | sed -nE 's/^[^:]*:([0-9]+)MB.*/\1/p'; }
# One tick is "frozen" only when the transcript did not grow AND RSS moved less than epsilon.
# An unparseable RSS is NOT frozen — missing evidence must never advance the kill counter.
io_stall_tick_frozen() { # prev_size cur_size prev_rss cur_rss epsilon
  local ps="$1" cs="$2" pr="$3" cr="$4" eps="$5" d
  [ -n "$ps" ] && [ "$ps" = "$cs" ] || return 1
  case "$pr$cr" in ''|*[!0-9]*) return 1 ;; esac
  d=$(( pr - cr )); [ "$d" -lt 0 ] && d=$(( -d ))
  [ "$d" -le "$eps" ]
}
# Every signal must agree before the run is declared hung: the transcript is old, nothing is
# executing, and the process has been frozen for several consecutive ticks (~15 min at the
# default interval). A single flat sample is normal between two ticks; three in a row with a
# byte-identical transcript and a pinned RSS is the recorded hang signature.
io_stall_hung() { # age threshold last_tool flat_ticks need_ticks
  local age="$1" threshold="$2" last_tool="$3" flat="$4" need="$5"
  case "$age$threshold$flat$need" in ''|*[!0-9]*) return 1 ;; esac
  [ "$age" -ge "$threshold" ] || return 1
  io_tool_is_nonexecuting "$last_tool" || return 1
  [ "$flat" -ge "$need" ]
}
# ONE tick of watchdog accounting: advance or reset the consecutive-frozen streak from this
# sample, then write the verdict file the run loop consumes once every signal agrees. The
# streak state and the flag write live HERE, not inlined in the poller, so the tests drive the
# real accounting instead of a copy of it — a test that re-implements this loop would keep
# passing while the poller mis-wired the counter, and a watchdog that never fires is
# indistinguishable from a fleet with no hangs. Returns 0 only when it wrote a verdict.
io_stall_tick() { # age last_tool cur_size cur_rss_mb
  local age="$1" lt="${2:-none}" cs="$3" cr="$4"
  # DISARMED while the wrapper is converging. A converging task presents the hang signature
  # exactly: no claude process, so the transcript stops growing, RSS sits flat, and the last tool
  # recorded is an ordinary model turn. This watchdog exists to catch a hung LLM, and with no LLM
  # running there is nothing to catch — left armed it would kill every healthy converging task on
  # its first quiet interval. The streak resets too, so the next burst starts from zero instead of
  # inheriting ticks accumulated while nothing was running.
  if [ -f "${IO_CONVERGE_ACTIVE:-/nonexistent}" ]; then
    STALL_FLAT_TICKS=0; PREV_SIZE="$cs"; PREV_RSS_MB="$cr"
    return 1
  fi
  if io_stall_tick_frozen "${PREV_SIZE:-}" "$cs" "${PREV_RSS_MB:-}" "$cr" "$IO_STALL_RSS_EPSILON_MB"; then
    STALL_FLAT_TICKS=$(( ${STALL_FLAT_TICKS:-0} + 1 ))
  else
    STALL_FLAT_TICKS=0
  fi
  PREV_SIZE="$cs"; PREV_RSS_MB="$cr"
  [ ! -s "${IO_STALL_FLAG:-}" ] || return 1
  io_stall_hung "$age" "$IO_STALL_RESTART_AFTER" "$lt" "${STALL_FLAT_TICKS:-0}" "$IO_STALL_FLAT_TICKS" || return 1
  echo "[stall-watchdog] hang signature confirmed: age=${age}s last_tool=${lt} frozen_ticks=${STALL_FLAT_TICKS} size=${cs}${cr:+ rss=${cr}MB} — signalling the run loop"
  printf 'age=%s last_tool=%s frozen_ticks=%s rss_mb=%s\n' "$age" "$lt" "$STALL_FLAT_TICKS" "${cr:-unknown}" > "$IO_STALL_FLAG" 2>/dev/null || true
  return 0
}
# ── Convergence (Phase 5) ─────────────────────────────────────────────────────────────────────
# After Ship, `claude` exits and this loop owns the MR: read the vector, act on whichever
# condition is blocking, repeat every minute. There are no budgets and no per-condition retry
# counters — a run making progress should keep going, and a run that is stuck should be UNSTUCK,
# not counted. The wall clock is the only bound, because a held worker is the only resource a
# stuck run actually costs. Exhausting it is not a special path: the loop returns non-zero and
# falls through to the ONE emit_run_contract call at the bottom of this file, which already
# derives BRANCH:/MR: from burst 0's result and takes the retained-MR branch on an error.
IO_CONVERGE_POLL_SECS="${IO_CONVERGE_POLL_SECS:-60}"
IO_CONVERGE_MAX_SECONDS="${IO_CONVERGE_MAX_SECONDS:-21600}"   # 6h ceiling
IO_BUGBOT_NUDGE_AFTER_SECONDS="${IO_BUGBOT_NUDGE_AFTER_SECONDS:-3600}"
IO_FOREMAN_REVIEW_WAIT_SECONDS="${IO_FOREMAN_REVIEW_WAIT_SECONDS:-600}"
# Resolved HERE, not at loop entry: the heartbeat subshell that reads this marker is forked long
# before convergence starts, so a path assigned later would never reach it and the watchdog would
# kill the first quiet converging task.
IO_CONVERGE_ACTIVE="${IO_CONVERGE_ACTIVE:-$(mktemp -u "${TMPDIR:-/tmp}/io-converge-active.XXXXXX")}"
export IO_CONVERGE_ACTIVE
IO_CONVERGE_VECTOR_ERR="${IO_CONVERGE_VECTOR_ERR:-$(mktemp -u "${TMPDIR:-/tmp}/io-converge-vector-err.XXXXXX")}"

# Which condition is blocking, in the order a run actually clears them, so the log names a cause
# rather than the first false it happens to scan. `merged` outranks everything: an accepted MR
# and an emptied branch are indistinguishable from diff_exists alone.
converge_waiting_on() {   # usage: converge_waiting_on <vector KEY=value text>
  local v="$1" c detail bugbot_condition
  # Herestrings, not `printf | grep -q`: under `set -o pipefail` a matching `grep -q` exits before
  # printf finishes writing, and the resulting SIGPIPE (141) becomes the pipeline's status, so a
  # match reads as a miss. That silently classified a blocked MR as `clean` about 1 read in 400.
  grep -q '^mr_state=merged' <<< "$v" && { printf 'merged'; return; }
  # A human closed the MR. Nothing bash does can un-close it, so polling to the 6h ceiling just
  # holds a worker; stop and let the retained-MR contract hand it back.
  grep -q '^mr_state=closed' <<< "$v" && { printf 'closed'; return; }
  grep -q '^vector_readable=false' <<< "$v" && { printf 'vector_unreadable'; return; }
  grep -q '^mergeable=false' <<< "$v" && grep -q '^mergeable_detail=draft_status' <<< "$v" \
    && { printf 'draft'; return; }
  grep -q '^session_identity=false' <<< "$v" && { printf 'session_identity_mismatch'; return; }
  # Bugbot reviews GitLab MRs only; fail-closed, so only a literal `false` drops the condition.
  bugbot_condition=' bugbot_reviewed_exact_head'
  [ "${IO_BUGBOT_REQUIRED:-}" != false ] || bugbot_condition=''
  for c in exact_head diff_exists ci_green_on_head ledger_clean${bugbot_condition} mergeable; do
    if grep -q "^${c}=unknown" <<< "$v"; then
      printf '%s_pending' "$c"; return
    fi
    if grep -q "^${c}=false" <<< "$v"; then
      detail="$(sed -n "s/^${c}_detail=//p" <<< "$v" | head -n 1)"
      # A pipeline still RUNNING is not a fault: dispatching here wakes a burst to sit and watch
      # CI, which is the idle-LLM wait this phase removes. Only a SETTLED red is actionable.
      if [ "$c" = ci_green_on_head ] && grep -q '^unsettled' <<< "$detail"; then
        printf 'ci_unsettled'; return
      fi
      # Bugbot starts automatically for every MR head; both no review and an older-head review wait.
      if [ "$c" = bugbot_reviewed_exact_head ] && grep -Eq '^(awaiting|stale)' <<< "$detail"; then
        printf 'bugbot_pending'; return
      fi
      if [ "$c" = mergeable ] && [ "$detail" = discussions_not_resolved ]; then
        printf 'mergeable_pending'; return
      fi
      if [ "$c" = mergeable ] && [ "$detail" = not_open ]; then
        printf 'not_open'; return
      fi
      if [ "$c" = diff_exists ] && [ "$detail" = branch_diff_empty ]; then
        printf 'empty_diff'; return
      fi
      if [ "$c" = diff_exists ] && [ "$detail" = diff_base_unreadable ]; then
        printf 'diff_exists_unreadable'; return
      fi
      if [ "$detail" = unreadable ]; then
        printf '%s_unreadable' "$c"; return
      fi
      printf '%s' "$c"; return
    fi
  done
  # Strictly last, and only a literal true waits, so an absent or broken foreman costs a run nothing.
  grep -q '^foreman_review_pending=true' <<< "$v" && { printf 'foreman_review_pending'; return; }
  printf 'clean'
}

# What each blocking condition means in English. The loop posts these to Slack so a human can
# follow convergence without reading CloudWatch. Mention-free by rule: these fire unattended for
# hours and an @here at 3am is how a useful channel gets muted.
converge_status_text() {   # usage: converge_status_text <waiting_on> <mr_iid>
  # Derived inline, not in a shared helper: the run-contract test extracts this function's text and runs it standalone.
  local forge_sigil='!' forge_name='GitLab'
  case "${IO_PUBLISH_FORGE:-gitlab}" in github) forge_sigil='#'; forge_name='GitHub' ;; esac
  case "$1" in
    merged)                     printf '✅ MR %s%s merged — done' "$forge_sigil" "$2" ;;
    # Same flag test as converge_waiting_on: when the condition is dropped no review was observed,
    # so naming Bugbot here would report a review that never happened.
    clean)
      if [ "${IO_BUGBOT_REQUIRED:-}" != false ]; then
        printf '✅ MR %s%s — CI green, Bugbot done, no open comments; finalizing' "$forge_sigil" "$2"
      else
        printf '✅ MR %s%s — CI green, no open comments; finalizing' "$forge_sigil" "$2"
      fi ;;
    ci_unsettled)               printf '⏳ MR %s%s — pipeline still running' "$forge_sigil" "$2" ;;
    ci_green_on_head)           printf '🔴 MR %s%s — CI failed; rebasing or fixing' "$forge_sigil" "$2" ;;
    bugbot_pending)              printf '⏳ MR %s%s — waiting on Bugbot to review this commit' "$forge_sigil" "$2" ;;
    ledger_clean)               printf '💬 MR %s%s — unresolved review comments; adjudicating' "$forge_sigil" "$2" ;;
    mergeable_pending)          printf '⏳ MR %s%s — %s syncing merge status' "$forge_sigil" "$2" "$forge_name" ;;
    foreman_review_pending)     printf '👀 MR %s%s — foreman review in flight; holding ready briefly' "$forge_sigil" "$2" ;;
    mergeable)                  printf '⚠️ MR %s%s — merge blocked; resolving' "$forge_sigil" "$2" ;;
    exact_head|diff_exists)     printf '⏳ MR %s%s — %s catching up with the last push' "$forge_sigil" "$2" "$forge_name" ;;
    vector_unreadable)          printf '⏳ MR %s%s — %s read failed; retrying' "$forge_sigil" "$2" "$forge_name" ;;
    diff_exists_unreadable)     printf '⏳ MR %s%s — cannot read the diff base ref; retrying' "$forge_sigil" "$2" ;;
    empty_diff)                 printf '🛑 MR %s%s has no diff — stopping' "$forge_sigil" "$2" ;;
    draft)                      printf '🛑 MR %s%s is Draft — stopping' "$forge_sigil" "$2" ;;
    closed)                     printf '🛑 MR %s%s was closed — stopping' "$forge_sigil" "$2" ;;
    not_open)                   printf '🛑 MR %s%s is not open — stopping' "$forge_sigil" "$2" ;;
    *)                          printf '⏳ MR %s%s — waiting on %s' "$forge_sigil" "$2" "$1" ;;
  esac
}

# Posted only when the blocking condition CHANGES: one line per 60s poll would be ~360 messages
# over the 6h window, which is how a channel becomes noise nobody reads.
converge_slack() {   # usage: converge_slack <text>
  local tok="${SLACK_BOT_TOKEN:-}" ch="${SLACK_CHANNEL_ID:-}" th="${SLACK_THREAD_TS:-}" pl
  [ -n "$tok" ] && [ -n "$ch" ] && [ -n "$th" ] || return 0
  pl=$(jq -nc --arg c "$ch" --arg t "$1" --arg th "$th" '{channel:$c,text:$t,thread_ts:$th}' 2>/dev/null) || return 0
  curl -s --max-time 10 -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $tok" -H 'Content-type: application/json' --data "$pl" >/dev/null 2>&1 || true
  # Mirror into the initiator's DM thread when one is wired, same as the per-phase posts.
  local dch="${SLACK_DM_CHANNEL_ID:-}" dth="${SLACK_DM_THREAD_TS:-}"
  [ -n "$dch" ] && [ -n "$dth" ] || return 0
  pl=$(jq -nc --arg c "$dch" --arg t "$1" --arg th "$dth" '{channel:$c,text:$t,thread_ts:$th}' 2>/dev/null) || return 0
  curl -s --max-time 10 -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $tok" -H 'Content-type: application/json' --data "$pl" >/dev/null 2>&1 || true
}

# The user token dies before this loop does, so the loop OWNS the credential instead of
# discovering it is dead through a failed read: refresh on arm, then whenever the token is
# within the margin of the expiry the SERVER reported, and on a fixed interval regardless.
# The interval is the floor: a server that reports no expiry, or a token issued without one,
# must not leave a 6h loop running on a 2h credential. Reactive refresh still exists one layer
# down, but it lands in the read's subshell and cannot outlive it — only a refresh from here
# updates the loop's own environment, which every later `glab` in every later poll inherits.
IO_CONVERGE_TOKEN_REFRESH_SECS="${IO_CONVERGE_TOKEN_REFRESH_SECS:-4800}"
IO_TOKEN_REFRESH_MARGIN_SECS="${IO_TOKEN_REFRESH_MARGIN_SECS:-600}"
converge_refresh_token() {   # usage: converge_refresh_token <reason>
  type refresh_user_gitlab_auth >/dev/null 2>&1 || return 1
  if refresh_user_gitlab_auth >/dev/null 2>&1; then
    echo "[converge] gitlab token refreshed ($1)"
    return 0
  fi
  echo "[converge] gitlab token refresh FAILED ($1) — reads will fail until it recovers" >&2
  return 1
}

converge_args_from_result() {   # usage: converge_args_from_result <workflow_result_json>
  local cp="${IO_FACTORY_CONTROL_PLANE_DIR:-${IO_FACTORY_SHIP_CONTROL_PLANE_DIR:-}}" repo="${REPO%/}"
  printf '%s' "$1" | jq -ce --arg cp "$cp" --arg repo "$repo" '
    . as $result
    | select(($result.mr_iid | type) == "number" and $result.mr_iid > 0)
    | select($result.project == "io-factory" and $result.protocol == 2)
    | select(($result.session_id | type) == "number" and $result.session_id > 0)
    | select(($result.source_branch | type) == "string" and $result.source_branch == $result.branch)
    | select(($result.nonce | type) == "string" and ($result.nonce | test("^[0-9a-f]{32}$")))
    | $result.args
    | select(type == "object" and (.workDir | type) == "string")
    | .workDir as $work_dir
    | if ($work_dir | startswith("/")) then
        select($work_dir | startswith($repo + "/"))
        | select(($work_dir | ltrimstr($repo + "/")) | test("^[.]io-agent-[A-Za-z0-9._-]+$"))
      else
        select($work_dir | test("^[.]io-agent-[A-Za-z0-9._-]+$"))
        | .workDir = ($repo + "/" + $work_dir)
      end
    | . + {sessionMrIid: $result.mr_iid, sessionMrBranch: $result.source_branch,
      sessionMrNonce: $result.nonce, shipSlack: ($result.slack // {}),
      factoryControlPlaneDir: $cp}' 2>/dev/null
}

converge_claim_bugbot_nudge() {   # usage: converge_claim_bugbot_nudge <mr_iid> <head_sha>
  return 0
}

converge_link_session_mr() {   # usage: converge_link_session_mr <mr_iid> <branch>
  return 0
}

# The loop. One vector read, one log line, one action, sleep, repeat.
converge_loop() {   # usage: converge_loop <mr_iid> <branch> <burst_args_json>
  local mr="$1" branch="$2" args="$3"
  local now deadline polls=0 head remote_head vector vector_branch waiting last_waiting="" detail fingerprint state_fingerprint local_fingerprint artifact fetch_mr_state fetch_output fetch_detail fetch_extra
  local description_fingerprint trail_fingerprint finalizer_output_fingerprint expected_finalizer_output
  local token_exp=0 token_due read_failures=0 fetch_failures=0 actor_failures=0 semantic_fingerprint="" finalized_fingerprint="" finalized_output_fingerprint=""
  local work_dir state_file events_file watched_head="" initial_head="" pipeline_floor=0 last_pipeline_id=0 selected_pipeline=0
  local ticket_id log_started log_seq=0 state_mr state_branch last_repair_key="" repair_key=""
  local factory_session_id factory_nonce foreman_wait_started=0 foreman_wait_expired=0 foreman_award_at=""
  local forge_sigil='!'
  case "${IO_PUBLISH_FORGE:-gitlab}" in github) forge_sigil='#' ;; esac
  # Self-sufficient under `set -u`: the loop is extracted and run standalone by the contract tests,
  # so every knob it reads needs a default here as well as at module scope.
  : "${IO_CONVERGE_VECTOR_ERR:=$(mktemp "${TMPDIR:-/tmp}/io-converge-vector-err.XXXXXX")}"
  : "${IO_CONVERGE_TOKEN_REFRESH_SECS:=4800}"
  : "${IO_TOKEN_REFRESH_MARGIN_SECS:=600}"
  : "${IO_BUGBOT_NUDGE_AFTER_SECONDS:=3600}"
  : "${IO_FOREMAN_REVIEW_WAIT_SECONDS:=600}"
  : "${IO_CONVERGE_FETCH_FAILURE_LIMIT:=10}"
  : "${IO_CONVERGE_VECTOR_SH:=${IO_FACTORY_SOURCE_DIR:-${IO_REPO_DIR:-.}}/tools/factory/converge-vector.sh}"
  : "${IO_PUBLISH_SH:=${IO_FACTORY_SOURCE_DIR:-${IO_REPO_DIR:-.}}/tools/factory/publish.sh}"
  case "$IO_BUGBOT_NUDGE_AFTER_SECONDS" in ''|*[!0-9]*) IO_BUGBOT_NUDGE_AFTER_SECONDS=3600 ;; esac
  # 0 is legal here (it means "never hold"), so only empty or non-numeric is rejected.
  case "$IO_FOREMAN_REVIEW_WAIT_SECONDS" in ''|*[!0-9]*) IO_FOREMAN_REVIEW_WAIT_SECONDS=600 ;; esac
  case "$IO_CONVERGE_FETCH_FAILURE_LIMIT" in ''|*[!0-9]*|0) IO_CONVERGE_FETCH_FAILURE_LIMIT=10 ;; esac
  work_dir="$(printf '%s' "$args" | jq -r '.workDir // empty' 2>/dev/null)"
  ticket_id="$(printf '%s' "$args" | jq -r '.ticketId // "UNKNOWN"' 2>/dev/null)"
  initial_head="$(printf '%s' "$args" | jq -r '.initialHead // empty' 2>/dev/null)"
  factory_session_id="$(printf '%s' "$args" | jq -r '.factorySessionId // empty' 2>/dev/null)"
  factory_nonce="$(printf '%s' "$args" | jq -r '.sessionMrNonce // empty' 2>/dev/null)"
  if ! printf '%s' "$factory_session_id" | grep -qE '^[1-9][0-9]*$' \
    || ! printf '%s' "$factory_nonce" | grep -qE '^[0-9a-f]{32}$'; then
    CONVERGE_ERROR="session_mr_identity_missing"; return 1
  fi
  export IO_CONVERGE_SESSION_MARKER="<!-- factory-session:2:${factory_session_id}:${factory_nonce} -->"
  pipeline_floor="$(printf '%s' "$args" | jq -r '.initialPipelineFloor // 0' 2>/dev/null)"
  case "$work_dir" in
    /*) ;;
    *) CONVERGE_ERROR="invalid_converge_envelope"; return 1 ;;
  esac
  state_file="${IO_CONVERGE_STATE_FILE:-${work_dir}/ship-watch-state.json}"
  events_file="${IO_CONVERGE_EVENTS_FILE:-${work_dir}/ship-events.jsonl}"
  : "${IO_CONVERGE_FETCH_OUTPUT:=${state_file}.fetch-output.tmp}"
  : > "$IO_CONVERGE_FETCH_OUTPUT"
  chmod 600 "$IO_CONVERGE_FETCH_OUTPUT" 2>/dev/null || true
  log_started="$(date -u +%s)"
  if printf '%s' "$initial_head" | grep -qE '^[0-9a-f]{40}$'; then watched_head="$initial_head"; fi

  ship_log() {
    local event="$1" decision="$2" reason="$3" extra="${4-}" line sink_line log_now
    [ -n "$extra" ] || extra='{}'
    log_seq=$(( log_seq + 1 )); log_now="$(date -u +%s)"
    printf '%s' "$extra" | jq -e 'type == "object"' >/dev/null 2>&1 || extra='{}'
    line="$(jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg event "$event" \
      --arg decision "$decision" --arg reason "$reason" --arg ticket "$ticket_id" \
      --argjson sequence "$log_seq" --argjson elapsed "$(( log_now - log_started ))" \
      --argjson mr "$mr" --arg branch "$branch" --arg head "${head:-}" \
      --argjson pipeline "${selected_pipeline:-0}" --arg fingerprint "${fingerprint:-}" \
      --argjson extra "$extra" \
      '{schema_version:1,sequence:$sequence,timestamp:$ts,elapsed_seconds:$elapsed,event:$event,
        decision:$decision,reason:$reason,ticket:$ticket,mr_iid:$mr,branch:$branch,head:$head,
        pipeline_id:$pipeline,fingerprint:$fingerprint} + $extra')" || return 0
    printf '[ship-event] %s\n' "$line"
    if ! mkdir -p "$(dirname "$events_file")" 2>/dev/null \
      || ! printf '%s\n' "$line" >> "$events_file" 2>/dev/null; then
      log_seq=$(( log_seq + 1 ))
      sink_line="$(jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg ticket "$ticket_id" \
        --argjson sequence "$log_seq" --argjson elapsed "$(( $(date -u +%s) - log_started ))" \
        --argjson mr "$mr" --arg branch "$branch" --arg head "${head:-}" \
        '{schema_version:1,sequence:$sequence,timestamp:$ts,elapsed_seconds:$elapsed,
          event:"log_sink_failed",decision:"continue",reason:"ship_events_file_unwritable",
          ticket:$ticket,mr_iid:$mr,branch:$branch,head:$head}')" || return 0
      printf '[ship-event] %s\n' "$sink_line"
    fi
  }
  snapshot_json() {
    printf '%s' "$vector" | jq -Rn '
      [inputs | capture("^(?<key>[^=]+)=(?<value>.*)$")]
      | from_entries
      | {
          mr_state, exact_head, exact_head_detail, diff_exists, diff_exists_detail,
          ci_green_on_head, ci_green_on_head_detail, pipeline_status,
          bugbot_reviewed_exact_head, bugbot_reviewed_exact_head_detail, bugbot_wait_seconds,
          bugbot_note_sha, bugbot_description_sha, bugbot_description_note_id,
          bugbot_description_changed_at, bugbot_description_version_readable,
          bugbot_clean_award_at, bugbot_awards_readable,
          bugbot_nudged_exact_head, bugbot_nudge_note_id, bugbot_nudge_created_at,
          bugbot_nudge_eligible, bugbot_request_id,
          ledger_clean, ledger_clean_detail, open_threads, open_notes,
          foreman_review_pending, foreman_review_pending_detail, foreman_award_at,
          mergeable, mergeable_detail, comment_fingerprint, description_fingerprint,
          vector_readable, vector_error
        } | with_entries(select(.value != null))' 2>/dev/null
  }
  log_burst_findings() {
    local stage="$1" action_reason="$2" finding_row
    while IFS= read -r finding_row; do
      [ -n "$finding_row" ] || continue
      ship_log finding repair "$action_reason" \
        "$(printf '%s' "$finding_row" | jq -c --arg stage "$stage" \
          '{stage:$stage,id:(.finding_id // .id),source,author,body_hash,verdict,action,result}')"
    done < <(printf '%s' "$BURST_RESULT_JSON" | jq -c '.repair_report.findings[]?' 2>/dev/null)
  }
  resolve_gitlab_actor() {
    local actor_file
    actor_file="$(mktemp "${TMPDIR:-/tmp}/io-factory-actor.XXXXXX" 2>/dev/null || true)"
    actor_id=0
    # The ledger recognises the factory's own notes by author id, so it must be the id on the forge
    # being published to; a GitLab id would make every GitHub disposition unreadable to its own re-read.
    if [ "${IO_PUBLISH_FORGE:-gitlab}" = github ]; then
      # The token rides curl's stdin config, never argv, so `ps` on a shared runner cannot read it.
      if [ -n "$actor_file" ] && [ -n "${IO_GITHUB_TOKEN:-}" ] \
        && curl -sS --max-time 30 --config - -o "$actor_file" \
          -H "Accept: application/vnd.github+json" \
          https://api.github.com/user \
          <<< "header = \"Authorization: Bearer ${IO_GITHUB_TOKEN}\"" >/dev/null 2>&1; then
        actor_id="$(jq -r '.id // 0' "$actor_file" 2>/dev/null)"
      fi
    elif [ -n "$actor_file" ] && type io_glab_json_with_refresh >/dev/null 2>&1 \
      && io_glab_json_with_refresh 30 api user > "$actor_file"; then
      actor_id="$(jq -r '.id // 0' "$actor_file" 2>/dev/null)"
    fi
    [ -z "$actor_file" ] || rm -f "$actor_file"
    case "$actor_id" in ''|*[!0-9]*) actor_id=0 ;; esac
    IO_FACTORY_GITLAB_USER_ID="$actor_id"
    export IO_FACTORY_GITLAB_USER_ID
    ship_log gitlab_actor read "$([ "$actor_id" -gt 0 ] && printf authenticated || printf unreadable)"
    [ "$actor_id" -gt 0 ]
  }
  persist_state() {
    local tmp="${state_file}.tmp.$$"
    mkdir -p "$(dirname "$state_file")" 2>/dev/null || return 1
    jq -nc --argjson mr "$mr" --arg branch "$branch" --arg head "$watched_head" --argjson floor "$pipeline_floor" \
      --argjson last "$last_pipeline_id" --arg repair "$last_repair_key" \
      '{version:1,mr_iid:$mr,branch:$branch,head:$head,pipeline_floor:$floor,
        last_pipeline_id:$last,last_repair_key:$repair}' > "$tmp" \
      && mv "$tmp" "$state_file"
  }
  finish_slack() {
    local enabled tok ts name ch payload response dm_ts dm_ch
    enabled="$(printf '%s' "$args" | jq -r '.slackThread // false' 2>/dev/null)"
    [ "$enabled" = true ] || return 0
    tok="${SLACK_BOT_TOKEN:-}"; ch="${SLACK_CHANNEL_ID:-}"
    ts="$(printf '%s' "$args" | jq -r '.shipSlack.last_phase_ts // empty' 2>/dev/null)"
    name="$(printf '%s' "$args" | jq -r '.shipSlack.last_phase_name // "Ship"' 2>/dev/null)"
    [ -n "$tok" ] && [ -n "$ch" ] && [ -n "$ts" ] || return 1
    payload="$(jq -nc --arg c "$ch" --arg t "✅ $name" --arg ts "$ts" '{channel:$c,text:$t,ts:$ts}')" || return 1
    response="$(curl -s --max-time 10 -X POST https://slack.com/api/chat.update \
      -H "Authorization: Bearer $tok" -H 'Content-type: application/json' --data "$payload")" || return 1
    printf '%s' "$response" | jq -e '.ok == true' >/dev/null 2>&1 || return 1
    dm_ts="$(printf '%s' "$args" | jq -r '.shipSlack.last_phase_dm_ts // empty' 2>/dev/null)"
    dm_ch="${SLACK_DM_CHANNEL_ID:-}"
    if [ -n "$dm_ts" ] && [ -n "$dm_ch" ]; then
      payload="$(jq -nc --arg c "$dm_ch" --arg t "✅ $name" --arg ts "$dm_ts" '{channel:$c,text:$t,ts:$ts}')" || return 1
      response="$(curl -s --max-time 10 -X POST https://slack.com/api/chat.update \
        -H "Authorization: Bearer $tok" -H 'Content-type: application/json' --data "$payload")" || return 1
      printf '%s' "$response" | jq -e '.ok == true' >/dev/null 2>&1 || return 1
    fi
  }
  complete_ship() {
    local reason="$1" started completion_error
    started="$(date -u +%s)"
    ship_log completion_start finish "$reason"
    if ! run_claude_burst complete "$args"; then
      CONVERGE_ERROR="completion_effects_error"
      ship_log completion_complete stop "$CONVERGE_ERROR" \
        "$(jq -nc --argjson duration "$(( $(date -u +%s) - started ))" '{duration_seconds:$duration}')"
      return 1
    fi
    if ! printf '%s' "$BURST_RESULT_JSON" | jq -e '.completion_status == "complete" and (has("error") | not)' >/dev/null 2>&1; then
      completion_error="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.error // empty' 2>/dev/null)"
      CONVERGE_ERROR="${completion_error:-completion_effects_error}"
      ship_log completion_complete stop "$CONVERGE_ERROR" \
        "$(jq -nc --argjson duration "$(( $(date -u +%s) - started ))" '{duration_seconds:$duration}')"
      return 1
    fi
    ship_log completion_complete finish ready_effects_published \
      "$(printf '%s' "$BURST_RESULT_JSON" | jq -c --argjson duration "$(( $(date -u +%s) - started ))" \
        '{duration_seconds:$duration,completion_state:(.completion_state // "unknown"),
          ready_effects:(.ready_effects // {})}')"
    ship_log slack_start finish final_ship_update
    if finish_slack; then
      ship_log slack_complete finish final_ship_update_succeeded
    else
      ship_log slack_complete finish final_ship_update_failed_nonfatal
    fi
    ship_log success finish "$reason" \
      "$(jq -nc --argjson polls "$polls" --argjson duration "$(( $(date -u +%s) - log_started ))" \
        '{polls:$polls,duration_seconds:$duration}')"
    return 0
  }
  if [ -s "$state_file" ]; then
    state_mr="$(jq -r '.mr_iid // 0' "$state_file" 2>/dev/null)"
    state_branch="$(jq -r '.branch // empty' "$state_file" 2>/dev/null)"
    if [ "$state_mr" = "$mr" ] && [ "$state_branch" = "$branch" ]; then
      watched_head="$(jq -r '.head // empty' "$state_file" 2>/dev/null)"
      pipeline_floor="$(jq -r '.pipeline_floor // 0' "$state_file" 2>/dev/null)"
      last_pipeline_id="$(jq -r '.last_pipeline_id // 0' "$state_file" 2>/dev/null)"
      last_repair_key="$(jq -r '.last_repair_key // empty' "$state_file" 2>/dev/null)"
    fi
  fi
  case "$pipeline_floor:$last_pipeline_id" in *[!0-9:]*) pipeline_floor=0; last_pipeline_id=0 ;; esac
  now="$(date -u +%s)"; deadline=$(( now + IO_CONVERGE_MAX_SECONDS ))
  : > "$IO_CONVERGE_ACTIVE"   # disarms the stall watchdog: no claude running is the normal state here
  echo "[converge] loop armed (mr=!${mr} branch=${branch} poll=${IO_CONVERGE_POLL_SECS}s ceiling=${IO_CONVERGE_MAX_SECONDS}s)" >&2
  ship_log startup read controller_armed
  # Burst 0 shipped at ~2h, so the token handed to this loop is already at or past its TTL.
  converge_refresh_token "loop arm" && token_exp="${IO_GITLAB_TOKEN_EXP:-0}"
  # Nudge markers are trusted only when authored by the GitLab identity this loop authenticated.
  # Capture it in this shell so a token refresh in the JSON helper is not lost to a subshell.
  local actor_id=0
  export IO_BUGBOT_NUDGE_AFTER_SECONDS
  resolve_gitlab_actor || true
  token_due=$(( now + IO_CONVERGE_TOKEN_REFRESH_SECS ))
  while now="$(date -u +%s)"; [ "$now" -lt "$deadline" ]; do
    polls=$(( polls + 1 ))
    # token_exp is latched from THIS loop's own refresh only: the vector refreshes in its own
    # process, so adopting its expiry would mark a token we never received as ours.
    # 10# because a leading zero makes bash read the epoch as octal, which is fatal, not wrong.
    if [ "$now" -ge "$token_due" ] \
       || { [ "$token_exp" -gt 0 ] \
            && [ "$now" -ge $(( 10#$token_exp - IO_TOKEN_REFRESH_MARGIN_SECS )) ]; }; then
      # 0 on failure, so the margin arm cannot refire every poll; token_due alone paces the retry.
      converge_refresh_token "expiring" && token_exp="${IO_GITLAB_TOKEN_EXP:-0}" || token_exp=0
      token_due=$(( now + IO_CONVERGE_TOKEN_REFRESH_SECS ))
    fi
    if [ "$actor_id" -le 0 ]; then
      if resolve_gitlab_actor; then
        actor_failures=0
      else
        actor_failures=$(( actor_failures + 1 ))
        if [ "$actor_failures" -ge 3 ]; then
          CONVERGE_ERROR="gitlab_actor_unreadable"
          ship_log decision stop "$CONVERGE_ERROR"
          return 1
        fi
        ship_log decision wait gitlab_actor_unreadable
        sleep "$IO_CONVERGE_POLL_SECS" & wait $! || true
        continue
      fi
    fi
    head="$(git rev-parse HEAD 2>/dev/null)"
    if ! printf '%s' "$head" | grep -qE '^[0-9a-f]{40}$'; then
      CONVERGE_ERROR="head_unreadable"
      ship_log stop stop "$CONVERGE_ERROR"
      return 1
    fi

    # A human/agent push is safe only when it is a clean fast-forward of the local branch.
    : > "$IO_CONVERGE_FETCH_OUTPUT"
    if io_with_gitlab_refresh git fetch origin "$branch" >"$IO_CONVERGE_FETCH_OUTPUT" 2>&1; then
      : > "$IO_CONVERGE_FETCH_OUTPUT"
    else
      fetch_output="$(< "$IO_CONVERGE_FETCH_OUTPUT")"
      : > "$IO_CONVERGE_FETCH_OUTPUT"
      # GitLab normally deletes a merged MR's source branch; the MR read is still authoritative.
      vector="$(bash "$IO_CONVERGE_VECTOR_SH" "$mr" "$branch" "$head" 2>"$IO_CONVERGE_VECTOR_ERR")"
      fetch_mr_state="$(printf '%s' "$vector" | sed -n 's/^mr_state=//p' | head -n 1)"
      if [ "$fetch_mr_state" = merged ]; then
        ship_log snapshot read merged_after_source_branch_removal
        complete_ship merged
        return $?
      fi
      if [ "$fetch_mr_state" = closed ]; then
        CONVERGE_ERROR="mr_closed"; ship_log stop stop "$CONVERGE_ERROR"; return 1
      fi
      fetch_failures=$(( fetch_failures + 1 ))
      fetch_detail="$(printf '%s' "$fetch_output" | tail -n 3 | tr '\r\n\t' '   ' \
        | sed -E 's#(https?://)[^/@[:space:]]+@#\1[redacted]@#g' | cut -c1-500)"
      [ -n "$fetch_detail" ] || fetch_detail="no stderr"
      fetch_extra="$(jq -nc --arg detail "$fetch_detail" --argjson failures "$fetch_failures" \
        --argjson limit "$IO_CONVERGE_FETCH_FAILURE_LIMIT" \
        '{consecutive_failures:$failures,failure_limit:$limit,detail:$detail}')"
      if [ "$fetch_failures" -ge "$IO_CONVERGE_FETCH_FAILURE_LIMIT" ]; then
        CONVERGE_ERROR="head_fetch_error"; ship_log fetch_complete stop "$CONVERGE_ERROR" "$fetch_extra"; return 1
      fi
      ship_log fetch_complete wait head_fetch_error "$fetch_extra"
      sleep "$IO_CONVERGE_POLL_SECS" & wait $! || true
      continue
    fi
    fetch_failures=0
    remote_head="$(git rev-parse "origin/$branch" 2>/dev/null || true)"
    if printf '%s' "$remote_head" | grep -qE '^[0-9a-f]{40}$' && [ "$remote_head" != "$head" ]; then
      if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] \
        || ! git merge-base --is-ancestor "$head" "$remote_head" >/dev/null 2>&1 \
        || ! git merge --ff-only "$remote_head" >/dev/null 2>&1; then
        CONVERGE_ERROR="head_reconciliation_error"
        ship_log head_transition stop "$CONVERGE_ERROR"
        return 1
      fi
      head="$remote_head"
      semantic_fingerprint=""
      finalized_fingerprint=""
      finalized_output_fingerprint=""
      ship_log head_transition wait "fast_forwarded_external_push"
    fi

    if [ "$watched_head" != "$head" ]; then
      if [ -n "$watched_head" ] && [ "$last_pipeline_id" -gt "$pipeline_floor" ]; then
        pipeline_floor="$last_pipeline_id"
      fi
      watched_head="$head"
      persist_state || { CONVERGE_ERROR="watch_state_write_error"; ship_log stop stop "$CONVERGE_ERROR"; return 1; }
      semantic_fingerprint=""
      finalized_fingerprint=""
      finalized_output_fingerprint=""
      ship_log head_transition wait "new_head_invalidated_old_pipeline"
    fi
    export IO_CONVERGE_PIPELINE_FLOOR="$pipeline_floor"
    # The vector's own diagnosis rides stderr and vector_error. Discarding both turned one
    # readable fault (gitlab_auth_expired at poll 1) into 181 identical unreadable lines.
    vector="$(bash "$IO_CONVERGE_VECTOR_SH" "$mr" "$branch" "$head" 2>"$IO_CONVERGE_VECTOR_ERR")"
    vector_branch="$(printf '%s' "$vector" | sed -n 's/^source_branch=//p' | head -n 1)"
    if [ -n "$vector_branch" ] && [ "$vector_branch" != unknown ] && [ "$vector_branch" != "$branch" ]; then
      CONVERGE_ERROR="session_mr_identity_mismatch"
      ship_log decision stop "$CONVERGE_ERROR"
      return 1
    fi
    waiting="$(converge_waiting_on "$vector")"
    # Latched once per RUN, not per head, so a stale 👀 costs the bound once and never wedges a ship.
    if [ "$waiting" = foreman_review_pending ]; then
      foreman_award_at="$(printf '%s' "$vector" | sed -n 's/^foreman_award_at=//p' | head -n 1)"
      if [ "$foreman_wait_started" -eq 0 ]; then
        foreman_wait_started="$now"
        ship_log foreman_review_wait wait marker_observed \
          "$(jq -nc --arg award "$foreman_award_at" \
            --argjson bound "$IO_FOREMAN_REVIEW_WAIT_SECONDS" \
            '{award_created_at:$award,bound_seconds:$bound}')"
      fi
      if [ $(( now - foreman_wait_started )) -ge "$IO_FOREMAN_REVIEW_WAIT_SECONDS" ]; then
        waiting=clean
        if [ "$foreman_wait_expired" -eq 0 ]; then
          foreman_wait_expired=1
          ship_log foreman_review_wait finish bound_reached \
            "$(jq -nc --argjson waited "$(( now - foreman_wait_started ))" \
              --argjson bound "$IO_FOREMAN_REVIEW_WAIT_SECONDS" --arg award "$foreman_award_at" \
              '{waited_seconds:$waited,bound_seconds:$bound,award_created_at:$award}')"
        fi
      fi
    fi
    detail="$(printf '%s' "$vector" | sed -n 's/^vector_error=//p' | head -n 1)"
    state_fingerprint="$(printf '%s' "$vector" | sed -n 's/^state_fingerprint=//p' | head -n 1)"
    description_fingerprint="$(printf '%s' "$vector" | sed -n 's/^description_fingerprint=//p' | head -n 1)"
    local_fingerprint="$({
      for artifact in "$work_dir/acceptance-test-report.md" "$work_dir/user-stories.txt" \
        "$work_dir/ledger.jsonl" "$work_dir/manifest.json" "$work_dir/plan.md" \
        "${IO_STEERING_RECEIVED_FILE:-${IO_REPO_DIR:-/workspace/repo}/steering-received.jsonl}"; do
        [ -f "$artifact" ] && { printf '%s\0' "$artifact"; cksum "$artifact"; }
      done
      if [ -d "$work_dir/screenshots" ]; then
        for artifact in "$work_dir/screenshots"/*; do [ -f "$artifact" ] && cksum "$artifact"; done
      fi
    } | cksum | awk '{print $1 ":" $2}')"
    fingerprint="${state_fingerprint}:${local_fingerprint}"
    if [ -f "$work_dir/verification-trail.md" ]; then
      trail_fingerprint="$(cksum "$work_dir/verification-trail.md" | awk '{print $1 ":" $2}')"
    else
      trail_fingerprint="missing"
    fi
    finalizer_output_fingerprint="${description_fingerprint}:${trail_fingerprint}"
    selected_pipeline="$(printf '%s' "$vector" | sed -n 's/^pipeline_id=//p' | head -n 1)"
    case "$selected_pipeline" in ''|none|*[!0-9]*) selected_pipeline=0 ;; esac
    if [ "$selected_pipeline" -gt "$last_pipeline_id" ]; then
      last_pipeline_id="$selected_pipeline"
      persist_state || { CONVERGE_ERROR="watch_state_write_error"; ship_log stop stop "$CONVERGE_ERROR"; return 1; }
    fi
    echo "[converge] poll=${polls} waiting_on=${waiting}${detail:+ vector_error=${detail}} head=$(printf '%.8s' "${head:-unknown}") deadline_in=$(( deadline - now ))s"
    ship_log snapshot read "$waiting" "$(snapshot_json)"
    if [ "$waiting" != "${last_waiting:-}" ]; then
      converge_slack "$(converge_status_text "$waiting" "$mr")"
      # Dumped on the state CHANGE only: a permanently broken read would otherwise reprint the
      # same diagnosis every 60s for the whole ceiling.
      [ -s "$IO_CONVERGE_VECTOR_ERR" ] && sed 's/^/[converge:stderr] /' "$IO_CONVERGE_VECTOR_ERR" | tail -n 20
      last_waiting="$waiting"
    fi
    case "$waiting" in
      merged)
        ship_log decision finish merged
        complete_ship merged; return $? ;;
      closed)                     CONVERGE_ERROR="mr_closed"; ship_log decision stop "$CONVERGE_ERROR"; return 1 ;;
      session_identity_mismatch) CONVERGE_ERROR="session_mr_identity_mismatch"; ship_log decision stop "$CONVERGE_ERROR"; return 1 ;;
      not_open)                   CONVERGE_ERROR="mr_not_open"; ship_log decision stop "$CONVERGE_ERROR"; return 1 ;;
      draft)                      CONVERGE_ERROR="mr_draft"; ship_log decision stop "$CONVERGE_ERROR"; return 1 ;;
      clean)
        read_failures=0
        if [ "$semantic_fingerprint" != "$fingerprint" ]; then
          local semantic_status semantic_evaluated semantic_ending semantic_pushed semantic_actual_end
          ship_log semantic_start finish current_inputs
          if ! run_claude_burst semantic "$args"; then
            CONVERGE_ERROR="semantic_check_crash"; ship_log semantic_complete stop "$CONVERGE_ERROR"; return 1
          fi
          semantic_status="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.repair_status // empty' 2>/dev/null)"
          case "$semantic_status" in
            clean|changed)
              semantic_evaluated="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.repair_report.evaluated_head // empty' 2>/dev/null)"
              semantic_ending="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.repair_report.ending_head // empty' 2>/dev/null)"
              semantic_pushed="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.repair_report.pushed | if type == "boolean" then tostring else empty end' 2>/dev/null)"
              semantic_actual_end="$(git rev-parse HEAD 2>/dev/null || true)"
              if ! printf '%s' "$semantic_evaluated" | grep -qE '^[0-9a-f]{40}$' \
                || ! printf '%s' "$semantic_ending" | grep -qE '^[0-9a-f]{40}$' \
                || [ "$semantic_evaluated" != "$head" ] \
                || [ "$semantic_ending" != "$semantic_actual_end" ] \
                || { [ "$semantic_pushed" = true ] && [ "$semantic_ending" = "$semantic_evaluated" ]; } \
                || { [ "$semantic_pushed" = false ] && [ "$semantic_ending" != "$semantic_evaluated" ]; } \
                || { [ "$semantic_pushed" != true ] && [ "$semantic_pushed" != false ]; }; then
                CONVERGE_ERROR="semantic_report_unreadable"
                ship_log semantic_complete stop "$CONVERGE_ERROR"
                return 1
              fi ;;
            *) CONVERGE_ERROR="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.error // "semantic_check_error"' 2>/dev/null)"
               ship_log semantic_complete stop "$CONVERGE_ERROR"; return 1 ;;
          esac
          log_burst_findings semantic semantic
          semantic_fingerprint="$fingerprint"
          if [ "$semantic_status" = changed ]; then
            finalized_fingerprint=""; finalized_output_fingerprint=""
            ship_log semantic_complete repair changed
            last_waiting=""
            continue
          fi
          ship_log semantic_complete finish clean
        fi
        if [ -n "$fingerprint" ] && [ "$finalized_fingerprint" = "$fingerprint" ] \
          && [ "$finalized_output_fingerprint" = "$finalizer_output_fingerprint" ]; then
          ship_log decision finish stable_final_read
          complete_ship stable_final_read; return $?
        fi
        ship_log decision finish run_idempotent_finalizers
        local finalize_started
        finalize_started="$(date -u +%s)"
        ship_log finalizer_start finish current_inputs
        if run_claude_burst finalize "$args" \
          && printf '%s' "$BURST_RESULT_JSON" | jq -e '.finalize_status == "clean"' >/dev/null 2>&1; then
          expected_finalizer_output="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '
            select((.description_fingerprint | type) == "string" and (.trail_fingerprint | type) == "string")
            | "\(.description_fingerprint):\(.trail_fingerprint)"' 2>/dev/null)"
          if ! printf '%s' "$expected_finalizer_output" | grep -qE '^[0-9]+:[0-9]+:([0-9]+:[0-9]+|missing)$'; then
            CONVERGE_ERROR="finalizer_receipt_unreadable"
            ship_log finalizer_complete stop "$CONVERGE_ERROR"
            return 1
          fi
          ship_log finalizer_complete finish clean \
            "$(jq -nc --argjson duration "$(( $(date -u +%s) - finalize_started ))" '{duration_seconds:$duration}')"
          finalized_fingerprint="$fingerprint"
          finalized_output_fingerprint="$expected_finalizer_output"
          last_waiting=""
          continue
        fi
        CONVERGE_ERROR="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.error // "finalizer_error"' 2>/dev/null)"
        ship_log finalizer_complete stop "$CONVERGE_ERROR" \
          "$(jq -nc --argjson duration "$(( $(date -u +%s) - finalize_started ))" '{duration_seconds:$duration}')"
        return 1
        ;;
      # GitLab/auth reads can blip, but bounded retries keep a bad credential from holding a worker.
      vector_unreadable|exact_head_unreadable|diff_exists_unreadable|ci_green_on_head_unreadable|bugbot_reviewed_exact_head_unreadable|ledger_clean_unreadable|mergeable_unreadable)
        read_failures=$(( read_failures + 1 ))
        if [ "$read_failures" -ge 3 ]; then
          CONVERGE_ERROR="${detail:-$waiting}"; ship_log decision stop "$CONVERGE_ERROR"; return 1
        fi
        ship_log decision wait "$waiting" ;;
      empty_diff)                 CONVERGE_ERROR="empty_diff"; ship_log decision stop "$CONVERGE_ERROR"; return 1 ;;
      bugbot_pending)
        read_failures=0
        local nudge_eligible pre_vector pre_waiting pre_head pre_wait pre_eligible claim_rc
        local nudge_body nudge_cmd IO_PUBLISH_NOTE_BODY nudge_note_id=0 nudge_rc=0 confirm_vector confirm_marked
        nudge_eligible="$(printf '%s' "$vector" | sed -n 's/^bugbot_nudge_eligible=//p' | head -n 1)"
        if [ "$nudge_eligible" = true ]; then
          # Re-prove the whole guard immediately before the irreversible POST. A completion, push,
          # closure, new comment, or trusted marker arriving here cancels stale work.
          pre_vector="$(bash "$IO_CONVERGE_VECTOR_SH" "$mr" "$branch" "$head" 2>"$IO_CONVERGE_VECTOR_ERR")"
          pre_waiting="$(converge_waiting_on "$pre_vector")"
          pre_head="$(printf '%s' "$pre_vector" | sed -n 's/^head_sha=//p' | head -n 1)"
          pre_wait="$(printf '%s' "$pre_vector" | sed -n 's/^bugbot_wait_seconds=//p' | head -n 1)"
          pre_eligible="$(printf '%s' "$pre_vector" | sed -n 's/^bugbot_nudge_eligible=//p' | head -n 1)"
          case "$pre_wait" in ''|*[!0-9]*) pre_wait=0 ;; esac
          if [ "$pre_waiting" != bugbot_pending ] || [ "$pre_head" != "$head" ] \
            || [ "$pre_eligible" != true ]; then
            ship_log bugbot_nudge_complete wait precondition_changed \
              "$(jq -nc --arg state "$pre_waiting" --argjson waited "$pre_wait" \
                --arg eligible "$pre_eligible" '{outcome:"cancelled",waiting_on:$state,
                  bugbot_wait_seconds:$waited,bugbot_nudge_eligible:($eligible == "true")}')"
            last_waiting=""
            continue
          fi
          claim_rc=0
          converge_claim_bugbot_nudge "$mr" "$head" || claim_rc=$?
          if [ "$claim_rc" -eq 1 ]; then
            ship_log bugbot_nudge_complete wait claim_held_elsewhere '{"outcome":"not_owner"}'
            last_waiting=""
            sleep "$IO_CONVERGE_POLL_SECS" & wait $! || true
            continue
          elif [ "$claim_rc" -ne 0 ]; then
            CONVERGE_ERROR="bugbot_nudge_claim_failed"
            ship_log bugbot_nudge_complete stop "$CONVERGE_ERROR"
            return 1
          fi
          nudge_body="$(printf 'cursor review verbose=true\n\n<!-- factory-bugbot-nudge:%s -->' "$head")"
          ship_log bugbot_nudge_start wait threshold_reached \
            "$(jq -nc --argjson waited "$pre_wait" --argjson threshold "$IO_BUGBOT_NUDGE_AFTER_SECONDS" \
              '{bugbot_wait_seconds:$waited,threshold_seconds:$threshold}')"
          nudge_rc=0
          # The shim emits the body unexpanded, so it must be set here or the nudge posts empty.
          IO_PUBLISH_NOTE_BODY="$nudge_body"
          nudge_cmd="$(bash "$IO_PUBLISH_SH" note-create "$mr" 2>/dev/null)" || nudge_cmd=""
          if [ -z "$nudge_cmd" ]; then
            nudge_rc=77
          else
            IO_PUBLISH_JSON=""; IO_PUBLISH_RC=0
            eval "$nudge_cmd"
            nudge_rc="$IO_PUBLISH_RC"
            nudge_note_id="$(printf '%s' "$IO_PUBLISH_JSON" | jq -r '.id // 0' 2>/dev/null)"
          fi
          case "$nudge_note_id" in ''|*[!0-9]*) nudge_note_id=0 ;; esac
          if [ "$nudge_rc" -ne 0 ] || [ "$nudge_note_id" -le 0 ]; then
            confirm_vector="$(bash "$IO_CONVERGE_VECTOR_SH" "$mr" "$branch" "$head" 2>"$IO_CONVERGE_VECTOR_ERR")"
            confirm_marked="$(printf '%s' "$confirm_vector" | sed -n 's/^bugbot_nudged_exact_head=//p' | head -n 1)"
            if [ "$confirm_marked" != true ]; then
              CONVERGE_ERROR="bugbot_nudge_post_failed"
              ship_log bugbot_nudge_complete stop "$CONVERGE_ERROR" \
                "$(jq -nc --argjson post_rc "$nudge_rc" '{outcome:"absent_after_reread",post_rc:$post_rc}')"
              return 1
            fi
            nudge_note_id="$(printf '%s' "$confirm_vector" | sed -n 's/^bugbot_nudge_note_id=//p' | head -n 1)"
            case "$nudge_note_id" in ''|none|*[!0-9]*) nudge_note_id=0 ;; esac
            ship_log bugbot_nudge_complete wait marker_confirmed_after_post_error \
              "$(jq -nc --argjson note "$nudge_note_id" --argjson post_rc "$nudge_rc" \
                '{outcome:"confirmed_after_error",note_id:$note,post_rc:$post_rc}')"
          else
            ship_log bugbot_nudge_complete wait posted \
              "$(jq -nc --argjson note "$nudge_note_id" '{outcome:"posted",note_id:$note}')"
          fi
          converge_slack "⏳ MR ${forge_sigil}${mr} — Bugbot still pending after one hour; sent one verbose recovery request"
        fi
        ship_log decision wait "$waiting" ;;
      exact_head|ci_unsettled|mergeable_pending|foreman_review_pending)
        read_failures=0; ship_log decision wait "$waiting" ;;
      *)
        local repair_started repair_head repair_end repair_files repair_status report_evaluated report_ending report_pushed
        read_failures=0
        repair_key="${waiting}:${head}:${selected_pipeline}:${state_fingerprint}"
        if [ -n "$last_repair_key" ] && [ "$last_repair_key" = "$repair_key" ]; then
          CONVERGE_ERROR="repair_no_progress"
          ship_log decision stop "$CONVERGE_ERROR"
          return 1
        fi
        ship_log decision repair "$waiting"
        repair_started="$(date -u +%s)"; repair_head="$head"
        ship_log repair_start repair "$waiting"
        if ! run_claude_burst repair "$args" "$waiting"; then
          CONVERGE_ERROR="repair_crash"
          ship_log repair_complete stop "$CONVERGE_ERROR" \
            "$(jq -nc --argjson duration "$(( $(date -u +%s) - repair_started ))" '{duration_seconds:$duration}')"
          return 1
        fi
        repair_status="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.repair_status // empty' 2>/dev/null)"
        if [ "$repair_status" != changed ] && [ "$repair_status" != clean ]; then
          CONVERGE_ERROR="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.error // "repair_error"')"
          ship_log repair_complete stop "$CONVERGE_ERROR" \
            "$(jq -nc --argjson duration "$(( $(date -u +%s) - repair_started ))" '{duration_seconds:$duration}')"
          return 1
        fi
        if [ "$waiting" = ledger_clean ] && [ "$repair_status" = clean ]; then
          CONVERGE_ERROR="ledger_disposition_missing"
          ship_log repair_complete stop "$CONVERGE_ERROR"
          return 1
        fi
        report_evaluated="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.repair_report.evaluated_head // empty' 2>/dev/null)"
        report_ending="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.repair_report.ending_head // empty' 2>/dev/null)"
        report_pushed="$(printf '%s' "$BURST_RESULT_JSON" | jq -r '.repair_report.pushed | if type == "boolean" then tostring else empty end' 2>/dev/null)"
        repair_end="$(git rev-parse HEAD 2>/dev/null || true)"
        if ! printf '%s' "$report_evaluated" | grep -qE '^[0-9a-f]{40}$' \
          || ! printf '%s' "$report_ending" | grep -qE '^[0-9a-f]{40}$' \
          || [ "$report_evaluated" != "$repair_head" ] \
          || [ "$report_ending" != "$repair_end" ] \
          || { [ "$report_pushed" = true ] && [ "$repair_end" = "$repair_head" ]; } \
          || { [ "$report_pushed" != true ] && [ "$repair_end" != "$repair_head" ]; } \
          || { [ "$report_pushed" != true ] && [ "$report_pushed" != false ]; }; then
          CONVERGE_ERROR="repair_report_unreadable"
          ship_log repair_complete stop "$CONVERGE_ERROR"
          return 1
        fi
        last_repair_key="$repair_key"
        log_burst_findings repair "$waiting"
        repair_files="$(git diff --name-only "$repair_head" 2>/dev/null | jq -Rsc 'split("\n") | map(select(length > 0))')"
        [ -n "$repair_files" ] || repair_files='[]'
        if [ "$repair_end" != "$repair_head" ]; then
          if [ "$last_pipeline_id" -gt "$pipeline_floor" ]; then
            pipeline_floor="$last_pipeline_id"
          fi
          watched_head="$repair_end"
          head="$repair_end"
          persist_state || {
            CONVERGE_ERROR="watch_state_write_error"
            ship_log repair_complete stop "$CONVERGE_ERROR"
            return 1
          }
          semantic_fingerprint=""
          finalized_fingerprint=""
          finalized_output_fingerprint=""
          ship_log head_transition wait repair_pushed_new_head
        else
          persist_state || {
            CONVERGE_ERROR="watch_state_write_error"
            ship_log repair_complete stop "$CONVERGE_ERROR"
            return 1
          }
        fi
        ship_log repair_complete repair action_complete_reread \
          "$(printf '%s' "$BURST_RESULT_JSON" | jq -c --arg status "$repair_status" --arg ending_head "$repair_end" \
            --argjson duration "$(( $(date -u +%s) - repair_started ))" --argjson files "$repair_files" \
            --argjson pushed "$([ "$repair_end" != "$repair_head" ] && echo true || echo false)" \
            '{status:$status,duration_seconds:$duration,ending_head:$ending_head,changed_files:$files,pushed:$pushed,
              evaluated_head:(.repair_report.evaluated_head // ""),reported_ending_head:(.repair_report.ending_head // ""),
              reported_pushed:(.repair_report.pushed // false),finding_count:((.repair_report.findings // []) | length)}')" ;;
    esac
    sleep "$IO_CONVERGE_POLL_SECS" & wait $! || true
  done
  if [ "${waiting:-}" = bugbot_pending ]; then
    CONVERGE_ERROR="bugbot_timeout"
  else
    CONVERGE_ERROR="converge_ceiling"
  fi
  ship_log decision stop "$CONVERGE_ERROR"
  echo "[converge] wall clock reached after ${polls} polls, still waiting on ${waiting:-unknown} — exiting with the MR retained" >&2
  return 1
}

# Each burst is its own `claude` invocation with its own FIFO, steering bridge, and output file.
# The open/close discipline is per-burst and never shared: a surviving write fd on fd 3 denies
# claude its EOF and hangs the run. The output file is per-burst because
# extract_workflow_result_json takes the LAST match in a file — N bursts appending to one $OUT
# would have burst 3 read burst 1's result.
IO_BURST_MAX_SECONDS="${IO_BURST_MAX_SECONDS:-3600}"
IO_ORCHESTRATOR_BURST_MAX_SECONDS="${IO_ORCHESTRATOR_BURST_MAX_SECONDS:-10800}"
BURST_N=0
BURST_RESULT_JSON=""
run_claude_burst() {   # usage: run_claude_burst <kind> <envelope_json> [repair_reason]
  local kind="$1" args="$2" repair_reason="${3:-}" pipe out prompt deadline now script_path burst_max_seconds
  BURST_N=$(( BURST_N + 1 ))
  out="${OUT}.burst-${BURST_N}"
  pipe="$(mktemp -u /tmp/io-agent-burst.XXXXXXXX).pipe"
  rm -f "$pipe"
  mkfifo -m 600 "$pipe" || { echo "[burst ${BURST_N}/${kind}] mkfifo failed — skipping this burst" >&2; return 1; }
  IO_INBOX_PIPE="$pipe"
  local burst_args
  if [ "$kind" = "finalize" ] || [ "$kind" = "complete" ] || [ "$kind" = "semantic" ]; then
    burst_args="$(printf '%s' "$args" | jq -c --arg b "$kind" '. + {burst: $b}')"
  else
    burst_args="$(printf '%s' "$args" | jq -c --arg b "$kind" --arg r "$repair_reason" '. + {burst: $b, repairReason: $r}')"
  fi
  script_path="$IO_WORK_TICKET_SHIP_JS"
  burst_max_seconds="$IO_BURST_MAX_SECONDS"
  prompt="Call the Workflow tool exactly once with scriptPath '${script_path}' and args set to EXACTLY this JSON object, copied verbatim: ${burst_args}. Do not take any other action before or after."
  # An LLM is running again, so a hang is catchable — re-arm the watchdog for the burst's duration.
  rm -f "$IO_CONVERGE_ACTIVE"
  start_steering_bridge
  exec 3<>"$pipe"
  jq -nc --arg text "$prompt" '{type:"user", message:{role:"user", content:[{type:"text", text:$text}]}}' >&3
  claude -p --input-format stream-json --output-format stream-json --verbose \
    --dangerously-skip-permissions --model "$IO_CLAUDE_MODEL" --effort "$IO_CLAUDE_EFFORT" \
    ${IO_CLAUDE_SETTINGS_ARGS[@]+"${IO_CLAUDE_SETTINGS_ARGS[@]}"} \
    < "$pipe" 3>&- > "$out" 2>> "$ERR" &
  CLAUDE_PID=$!
  deadline=$(( $(date -u +%s) + burst_max_seconds ))
  while kill -0 "$CLAUDE_PID" 2>/dev/null; do
    stream_has_result_event "$out" && [ -n "$(extract_workflow_result_json "$out")" ] && break
    if stream_has_failed_task "$out"; then
      echo "[burst ${BURST_N}/${kind}] Workflow task failed — stopping without waiting for the burst ceiling" >&2
      break
    fi
    now="$(date -u +%s)"
    [ "$now" -lt "$deadline" ] || { echo "[burst ${BURST_N}/${kind}] ceiling of ${burst_max_seconds}s reached — reaping" >&2; break; }
    sleep 5 & wait $! || true
  done
  stop_steering_bridge
  exec 3>&-
  wait_for_claude_exit; CLAUDE_EXIT=$?
  emit_ai_spend_file "$out" "burst-${BURST_N}" || true
  rm -f "$pipe"
  : > "$IO_CONVERGE_ACTIVE"   # back to waiting on bash — disarm again
  scrub_stream < "$out" > "${out}.scrubbed"
  BURST_RESULT_JSON="$(extract_workflow_result_json "${out}.scrubbed")"
  echo "[burst ${BURST_N}/${kind}] exit=${CLAUDE_EXIT} result=$([ -n "$BURST_RESULT_JSON" ] && echo yes || echo none)" >&2
  [ -n "$BURST_RESULT_JSON" ]
}

# A self-heal must never be silent. Both are best-effort: a failed post never blocks recovery.
io_stall_slack() {
  local tok="${SLACK_BOT_TOKEN:-}" ch="${SLACK_CHANNEL_ID:-}" th="${SLACK_THREAD_TS:-}" pl
  [ -n "$tok" ] && [ -n "$ch" ] && [ -n "$th" ] || return 0
  pl=$(jq -nc --arg c "$ch" --arg t "$1" --arg th "$th" '{channel:$c,text:$t,thread_ts:$th}' 2>/dev/null) || return 0
  curl -s --max-time 10 -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $tok" -H 'Content-type: application/json' --data "$pl" >/dev/null 2>&1 || true
}
# Appended to the run's own trail so the restart is visible in the MR's verification trail.
io_stall_trail() {
  local f
  for f in .io-agent-*/verification-trail.md; do
    [ -f "$f" ] && printf '%s\n' "$1" >> "$f" 2>/dev/null || true
  done
  return 0
}
heartbeat_tick() {
  local f live sz mtime age now last_tool key top_rss rss_mb
  flush_stream_tail
  # Newest agent transcript = the active step; before the workflow spawns agents, fall back to
  # the newest session transcript. (-exec ls -t is per-batch newest — fine at this private
  # dir's file counts.) Covers the nested proof claude's project dir too — do not narrow.
  f=$(find "${IO_TRANSCRIPT_ROOT:-}" -name 'agent-*.jsonl' -exec ls -t {} + 2>/dev/null | head -1)
  [ -n "$f" ] || f=$(find "${IO_TRANSCRIPT_ROOT:-}" -name '*.jsonl' -exec ls -t {} + 2>/dev/null | head -1)
  if [ -z "$f" ]; then echo "[heartbeat] no transcript yet"; return 0; fi
  # age must answer "is ANY part of this run still writing", not "is this one file writing".
  # A nested proof `claude -p` writes its own session transcript under the same private config
  # dir while the parent's agent-*.jsonl sits untouched for an hour — measuring only the latter
  # reports a dead run that is working fine, and every consumer of this age= line (including
  # the ECS reaper) inherits that blind spot. Take the newest mtime across ALL transcripts;
  # keep $f — the agent transcript — as the subject of last_tool and the stall dump.
  live=$(find "${IO_TRANSCRIPT_ROOT:-}" -name '*.jsonl' -exec ls -t {} + 2>/dev/null | head -1)
  [ -n "$live" ] || live="$f"
  mtime=$(stat -c %Y "$live" 2>/dev/null || stat -f %m "$live" 2>/dev/null || echo 0)
  [ "$mtime" -gt 0 ] || return 0
  sz=$(( $(wc -c < "$live" 2>/dev/null || echo 0) ))
  now=$(date +%s); age=$(( now - mtime ))
  last_tool=$(tail -c 65536 "$f" 2>/dev/null | grep -oE '"name":"[A-Za-z_]+"' | tail -1 | sed -E 's/"name":"([A-Za-z_]+)"/\1/')
  # comm= only, never args= — command lines can carry secrets; process names cannot.
  top_rss=$(ps -eo rss=,comm= --sort=-rss 2>/dev/null | head -3 \
    | awk '$1 ~ /^[0-9]+$/ { rss=$1; $1=""; sub(/^ +/,""); printf "%s%s:%dMB", sep, $0, rss/1024; sep="," }' \
    || true)
  echo "[heartbeat] file=$(basename "$f") age=${age}s size=${sz} last_tool=${last_tool:-none}${top_rss:+ top_rss=$top_rss}"
  io_stall_tick "$age" "${last_tool:-none}" "$sz" "$(io_rss_mb "$top_rss")"
  if [ "$age" -ge "$IO_STALL_AFTER" ]; then
    key="$f:$sz"
    if [ "$key" != "${LAST_DUMP_KEY:-}" ] || [ $(( now - ${LAST_DUMP_AT:-0} )) -ge "$IO_STALL_REDUMP" ]; then
      LAST_DUMP_KEY="$key"; LAST_DUMP_AT=$now
      echo "[stall] no transcript growth for ${age}s — last 100 lines of $(basename "$f"):${top_rss:+ top_rss=$top_rss}"
      # On a windowed read, drop the partial first line: a mid-token cut would leave a suffix
      # scrub_stream's prefix-anchored patterns can't recognize. cut bounds per-line size
      # (stream-json lines can be MBs); prefixing keeps the Rails contract scrape unmatchable.
      if [ "${sz:-0}" -gt 200000 ]; then
        tail -c 200000 "$f" | sed '1d' | tail -n 100 | scrub_stream | cut -c1-500 | sed 's/^/[stall] /'
      else
        tail -n 100 "$f" | scrub_stream | cut -c1-500 | sed 's/^/[stall] /'
      fi
    fi
  fi
  return 0
}
io_bounded_reap() {
  local pid="${1:-}" grace="${2:-15}" label="${3:-poller}" slice=0 limit
  [ -n "$pid" ] || return 0
  # `$(( grace * 5 ))` on a non-integer is fatal under this script's `set -u`.
  case "$grace" in ''|*[!0-9]*) grace=15 ;; esac
  # 0.2s slices, not 1s: a just-forked final tick is never dead at the first `kill -0`, so a 1s slice floors every healthy teardown at 2.00s.
  limit=$(( grace * 5 ))
  while kill -0 "$pid" 2>/dev/null && [ "$slice" -lt "$limit" ]; do
    sleep 0.2 & wait $! || true; slice=$((slice + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "[heartbeat] $label still running $((slice / 5))s after disarm — sending TERM" >&2
    kill "$pid" 2>/dev/null || true
    slice=0
    while kill -0 "$pid" 2>/dev/null && [ "$slice" -lt 25 ]; do
      sleep 0.2 & wait $! || true; slice=$((slice + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "[heartbeat] $label ignored TERM — sending KILL" >&2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  wait "$pid" 2>/dev/null || true
}
start_heartbeat() {
  case "$IO_HB_INTERVAL" in ''|*[!0-9]*) IO_HB_INTERVAL=300 ;; esac
  [ "$IO_HB_INTERVAL" -gt 0 ] 2>/dev/null || IO_HB_INTERVAL=300
  # A flag latched by a previous stop, or a pre-created path, would kill this poller at its first check.
  rm -f "$IO_HB_DISARM_FILE"
  (
    LAST_DUMP_KEY=""; LAST_DUMP_AT=0; IO_FLUSH_ARMED=1
    while [ ! -e "$IO_HB_DISARM_FILE" ]; do
      heartbeat_tick || true
      slept=0
      while [ "$slept" -lt "$IO_HB_INTERVAL" ] && [ ! -e "$IO_HB_DISARM_FILE" ]; do
        sleep 1 & wait $! || true
        slept=$((slept + 1))
      done
    done
  ) &
  HEARTBEAT_PID=$!
  echo "[io-coding-agent-js] heartbeat armed (interval ${IO_HB_INTERVAL}s, stall dump after ${IO_STALL_AFTER}s, pid ${HEARTBEAT_PID})" >&2
}
# Mirrors stop_steering_bridge: disarm flag → bounded escalating reap, still synchronous so nothing
# interleaves with the contract echoes below. The final tick reuses heartbeat_tick with a relabeled prefix.
stop_heartbeat() {
  [ -n "${HEARTBEAT_PID:-}" ] || return 0
  : > "${IO_HB_DISARM_FILE:-/dev/null}" 2>/dev/null || true
  io_bounded_reap "$HEARTBEAT_PID" "${IO_HB_STOP_GRACE_SECS:-15}" poller
  # The reap must stay on the very next line: io_bounded_reap's own `sleep 0.2 &` reassigns `$!` in this shell.
  { heartbeat_tick 2>/dev/null | sed 's/^\[heartbeat\]/[heartbeat:final]/'; } &
  io_bounded_reap "$!" "${IO_HB_STOP_GRACE_SECS:-15}" 'final tick'
}
# Steering bridge: polls the merged session mailbox and injects steering frames into the
# stream-json stdin pipe. Contract mirrors Api::CodingAgentSessionMessagesController#pending —
# POST {"session_id":...}, HMAC over "payload:timestamp" (the signed-webhook.sh recipe),
# response messages carry author_type/author_id/message_kind per CodingAgentSessionMessageSerializer.
IO_STEERING_INTERVAL="${IO_STEERING_INTERVAL:-15}"
# Per-run path like IO_INBOX_PIPE: containers share a node's /tmp, so a fixed path would cross runs.
IO_STEERING_DISARM_FILE="${IO_STEERING_DISARM_FILE:-$(mktemp -u "${TMPDIR:-/tmp}/io-steering-disarmed.XXXXXXXX")}"
rm -f "$IO_STEERING_DISARM_FILE"
steering_frame() {
  jq -cn --arg author "$1" --arg body "$2" --arg kind "$3" \
    '(if $kind == "advisory" then "[STEERING — ADVISORY: informational] " else "[STEERING — DIRECTIVE: a disposition is required before Ship] " end) as $tag
     | {type:"user",message:{role:"user",content:[{type:"text",text:("[steering message from \($author) via session mailbox] " + $tag + $body)}]}}' \
    2>/dev/null
}
# Every fallible step is guarded so a bridge error can never kill or stall the main run.
steering_tick() {
  local endpoint="$1" req_payload="$2" pipe="$3"
  local ts sig resp http_code payload count i idx id author_type author_id author msg_body kind frame received_file
  ts=$(date +%s)
  sig=$(printf '%s' "${req_payload}:${ts}" | openssl dgst -sha256 -hmac "${INTERNAL_WEBHOOK_SECRET:-}" 2>/dev/null | awk '{print $NF}') || return 0
  resp=$(curl -s --max-time 10 -w '\n%{http_code}' -X POST \
    -H "Content-Type: application/json" \
    -H "x-event-timestamp: ${ts}" -H "x-hmac-signature: ${sig}" \
    -d "$req_payload" \
    "$endpoint" 2>/dev/null) \
    || { echo "[steering] fetch failed (network error/timeout)"; return 0; }
  http_code=$(printf '%s\n' "$resp" | tail -1)
  payload=$(printf '%s\n' "$resp" | sed '$d')
  if [ "$http_code" != "200" ]; then
    echo "[steering] fetch failed (HTTP ${http_code})"
    return 0
  fi
  count=$(printf '%s' "$payload" | jq -er '.messages | if type == "array" then length else error("not an array") end' 2>/dev/null) \
    || { echo "[steering] dropped malformed response (.messages missing or not an array)"; return 0; }
  i=0
  while [ "$i" -lt "${count:-0}" ]; do
    idx=$i
    i=$((i + 1))
    id=$(printf '%s' "$payload" | jq -r ".messages[$idx].id // empty" 2>/dev/null | tr -d '\n\r' | head -c 40)
    author_type=$(printf '%s' "$payload" | jq -er ".messages[$idx].author_type | select(type == \"string\" and length > 0)" 2>/dev/null) \
      || { echo "[steering] dropped message ${id:-#$idx} (author_type missing/empty)"; continue; }
    author_id=$(printf '%s' "$payload" | jq -r ".messages[$idx].author_id // empty" 2>/dev/null | tr -d '\n\r' | head -c 60)
    author="${author_type}${author_id:+ ${author_id}}"
    author=$(printf '%s' "$author" | tr '\n\r' '  ' | head -c 200)
    msg_body=$(printf '%s' "$payload" | jq -er ".messages[$idx].body | select(type == \"string\" and length > 0)" 2>/dev/null) \
      || { echo "[steering] dropped message ${id:-#$idx} (body missing/empty)"; continue; }
    # Deploy skew can leave .message_kind absent — fall back to the strict kind, never drop.
    kind=$(printf '%s' "$payload" | jq -r ".messages[$idx].message_kind // empty" 2>/dev/null)
    case "$kind" in advisory|directive) ;; *) kind="directive" ;; esac
    # Pipe writes are atomic only up to PIPE_BUF (4096), so cap the frame or a torn write could corrupt the stream-json channel.
    if [ "$(printf '%s' "$msg_body" | wc -c | tr -d ' ')" -gt 3000 ]; then
      msg_body="$(printf '%s' "$msg_body" | head -c 3000) … [truncated]"
    fi
    frame=$(steering_frame "$author" "$msg_body" "$kind") \
      || { echo "[steering] dropped message ${id:-#$idx} (framing failed)"; continue; }
    if [ "$(printf '%s' "$frame" | wc -c | tr -d ' ')" -gt 4000 ]; then
      msg_body="$(printf '%s' "$msg_body" | head -c 400) … [truncated]"
      frame=$(steering_frame "$author" "$msg_body" "$kind") \
        || { echo "[steering] dropped message ${id:-#$idx} (framing failed)"; continue; }
    fi
    # Re-checked per message: stop writes the flag mid-tick, and bounding a closing tick to one more injection is what makes stop's grace a finite wait.
    if [ -n "${IO_STEERING_DISARM_FILE:-}" ] && [ -e "$IO_STEERING_DISARM_FILE" ]; then
      echo "[steering] disarmed mid-tick — dropping message ${id:-#$idx} (run is closing)"
      return 0
    fi
    # Bounded single open/write/close so a full pipe or dead reader can never hang the poller.
    if timeout 5 sh -c 'printf "%s\n" "$1" > "$2"' _ "$frame" "$pipe" 2>/dev/null; then
      echo "[steering] injected message ${id:-#$idx} from ${author}"
      # Durable delivery record for the Ship gate: injected messages only, best-effort; id keeps the payload's numeric type (null when absent).
      received_file="${IO_STEERING_RECEIVED_FILE:-${IO_REPO_DIR:-/workspace/repo}/steering-received.jsonl}"
      { jq -cn --arg id "${id:-}" --arg kind "$kind" --arg body "$msg_body" \
          '{id: (if $id == "" then null else ($id | tonumber? // $id) end), kind: $kind, body: $body}' >> "$received_file"; } 2>/dev/null \
        || echo "[steering] delivery record append failed for message ${id:-#$idx}"
    else
      echo "[steering] DROPPED message ${id:-#$idx} from ${author} (pipe write failed/timed out; this and the rest of this tick's messages are lost — the mailbox already marked them delivered)"
      return 0
    fi
  done
  return 0
}
start_steering_bridge() {
  echo "[steering] disarmed (no session endpoint in this deployment)" >&2
  return 0
}
# Synchronous like the other stops, so no [steering] line can interleave with the contract echoes below.
stop_steering_bridge() {
  local waited=0
  : > "${IO_STEERING_DISARM_FILE:-/dev/null}" 2>/dev/null || true
  # Grace before TERM: an in-flight injection is a foreground child, and default-disposition TERM would orphan it to write into the FIFO past `exec 3>&-`.
  while kill -0 "${STEERING_BRIDGE_PID:-}" 2>/dev/null \
    && [ "$waited" -lt "${IO_STEERING_STOP_GRACE_SECS:-15}" ]; do
    sleep 1 & wait $! || true; waited=$((waited + 1))
  done
  if kill -0 "${STEERING_BRIDGE_PID:-}" 2>/dev/null; then
    echo "[steering] poller still running ${waited}s after disarm — sending TERM" >&2
    kill "${STEERING_BRIDGE_PID:-}" 2>/dev/null || true
    waited=0
    while kill -0 "${STEERING_BRIDGE_PID:-}" 2>/dev/null && [ "$waited" -lt 5 ]; do
      sleep 1 & wait $! || true; waited=$((waited + 1))
    done
    if kill -0 "${STEERING_BRIDGE_PID:-}" 2>/dev/null; then
      echo "[steering] poller ignored TERM — sending KILL" >&2
      kill -KILL "${STEERING_BRIDGE_PID:-}" 2>/dev/null || true
    fi
  fi
  wait "${STEERING_BRIDGE_PID:-}" 2>/dev/null || true
}
# Pin the model so the orchestrator AND every nested workflow agent (Workflow-tool agents inherit
# the main-loop model) run on a known model instead of drifting to the harness default, which keeps
# the JS engine deterministic. Override via IO_CLAUDE_MODEL / IO_CLAUDE_EFFORT.
IO_CLAUDE_MODEL="${IO_CLAUDE_MODEL:-claude-opus-5}"
IO_CLAUDE_EFFORT="${IO_CLAUDE_EFFORT:-high}"
# Fast mode is Opus-only and has no CLI flag — it only arrives via settings. See
# CodingAgentTaskRunner#fast_mode_eligible? in cli/lib/coding_agent_task_runner.rb.
IO_CLAUDE_SETTINGS_ARGS=()
set_claude_settings_args() {
  IO_CLAUDE_SETTINGS_ARGS=()
  case "${1:-}" in
    *opus*) IO_CLAUDE_SETTINGS_ARGS=(--settings '{"fastMode":true}') ;;
  esac
}
set_claude_settings_args "$IO_CLAUDE_MODEL"
# PRIVATE per-run config dir: the heartbeat's transcript glob can never select a sibling
# worker's session (sandbox containers can share $HOME on a node), and stale sibling
# ~/.claude.json mcpServers / ~/.claude/CLAUDE.md memory stop leaking into this engine's
# claude. The repo .claude/ dir (workflows/skills) is cwd-scoped and unaffected.
# ONLY when auth is env-keyed: setting CLAUDE_CONFIG_DIR at all disables the CLI's own login
# (verified — even pointed at the real ~/.claude it yields "Not logged in"), so a keyless local
# run must share the developer's default dir or every `claude -p` fails.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  export CLAUDE_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/io-claude-run.XXXXXX")"
fi
# Cap vitest fan-out so it can't OOM this memory-capped container; MIN vars required or tinypool raises RangeError when min > max.
export VITEST_MAX_THREADS=2
export VITEST_MAX_FORKS=2
export VITEST_MIN_THREADS=1
export VITEST_MIN_FORKS=1
IO_TRANSCRIPT_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
# Pre-run trail sizes must live in the MAIN shell (the tailer's offsets die with its subshell) so adoption can skip prior-attempt bytes.
IO_TRAIL_OFFSETS_FILE=$(mktemp "${TMPDIR:-/tmp}/io-trail-offsets.XXXXXX")
capture_trail_offsets() {
  : > "$IO_TRAIL_OFFSETS_FILE"
  local f sz
  for f in .io-agent-*/verification-trail.md; do
    [ -f "$f" ] || continue
    sz=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
    printf '%s\t%s\n' "$f" "${sz:-0}" >> "$IO_TRAIL_OFFSETS_FILE"
  done
}
IO_RUN_START_EPOCH=$(date +%s)
capture_trail_offsets
if [ -z "${IO_FACTORY_SHIP_ONLY_ENVELOPE:-}" ] && [ -z "${IO_FACTORY_HANDOFF_ONLY_ARGS:-}" ]; then
  start_trail_tailer
  start_heartbeat
else
  TRAIL_TAILER_PID=""
  HEARTBEAT_PID=""
fi
# Defined above the launch block because the fallback close calls extract_workflow_result_json from the poll loop.
# Last result event's .result; -R + fromjson? + the object guard tolerate a half-written trailing line at teardown.
extract_stream_result_text() {
  jq -Rc '(fromjson? // empty) | select(type=="object" and .type=="result")' "$1" \
    | tail -n 1 | jq -r '.result // empty'
}
# Machine truth: current Claude writes a completed dynamic workflow's return to the system
# task_notification output_file; the retired CLI embedded it in user-message XML.
extract_workflow_result_json() {
  local result
  result="$(
    jq -Rr '
      (fromjson? // empty)
      | select(type == "object"
          and .type == "system"
          and .subtype == "task_notification"
          and .status == "completed"
          and ((.summary // "") | startswith("Dynamic workflow "))
          and (.output_file | type) == "string")
      | .output_file
    ' "$1" 2>/dev/null \
      | while IFS= read -r output_file; do
          [ -r "$output_file" ] || continue
          jq -c '.result | select(type == "object")' "$output_file" 2>/dev/null
        done \
      | tail -n 1
  )"
  if [ -n "$result" ]; then
    printf '%s\n' "$result"
    return 0
  fi

  # Only legacy user-message top-level text is scanned — tool_result payloads can carry the same
  # markers (e.g. an agent reading a fixture that quotes them) and must not spoof the contract.
  jq -Rc '
    (fromjson? // empty)
    | select(type == "object" and .type == "user")
    | [ (.message.content | strings),
        (.message.content[]? | objects | select(.type == "text") | .text | strings) ]
    | map(select(contains("<task-notification>") and contains("<result>") and contains("</result>")))
    | (last // empty)
    | split("<result>") | last | split("</result>") | first
    | (fromjson? // empty)
    | select(type == "object")
  ' "$1" | tail -n 1
}
IO_RESULT_QUIET_SECS="${IO_RESULT_QUIET_SECS:-900}"
IO_EXIT_GRACE_SECS="${IO_EXIT_GRACE_SECS:-15}"
IO_KILL_GRACE_SECS="${IO_KILL_GRACE_SECS:-30}"
# The result event's key order is version-dependent (`type` is 19th on CLI 2.1.219), so only a JSON parse is a legal test.
stream_has_result_event() {
  grep -a '"type":"result"' "$1" 2>/dev/null | tail -n 5 \
    | jq -e -R 'select((fromjson? // empty) | type == "object" and .type == "result")' >/dev/null 2>&1
}
stream_has_failed_task() {
  tail -n 100 "$1" 2>/dev/null \
    | jq -e -R 'select((fromjson? // empty) | type == "object" and .type == "system" and .subtype == "task_notification" and .status == "failed" and ((.summary // "") | startswith("Dynamic workflow ")))' >/dev/null 2>&1
}
# Secondary exit path, gated on the exact payload emit_run_contract prefers so it can never degrade the contract.
workflow_complete_and_quiet() {
  local mtime now
  mtime=$(stat -c %Y "$OUT" 2>/dev/null || stat -f %m "$OUT" 2>/dev/null || echo 0)
  [ "${mtime:-0}" -gt 0 ] || return 1
  now=$(date +%s)
  [ $(( now - mtime )) -ge "$IO_RESULT_QUIET_SECS" ] || return 1
  [ -n "$(extract_workflow_result_json "$OUT")" ]
}
# A fallback that fires BECAUSE something is already wrong must not hand back to an unbounded `wait`.
wait_for_claude_exit() {
  local waited=0
  while kill -0 "$CLAUDE_PID" 2>/dev/null && [ "$waited" -lt "$IO_EXIT_GRACE_SECS" ]; do
    sleep 1 & wait $! || true; waited=$((waited + 1))
  done
  if kill -0 "$CLAUDE_PID" 2>/dev/null; then
    echo "[claude-exit] claude still running ${waited}s after EOF — sending TERM" >&2
    kill -TERM "$CLAUDE_PID" 2>/dev/null || true
    waited=0
    while kill -0 "$CLAUDE_PID" 2>/dev/null && [ "$waited" -lt "$IO_KILL_GRACE_SECS" ]; do
      sleep 1 & wait $! || true; waited=$((waited + 1))
    done
    if kill -0 "$CLAUDE_PID" 2>/dev/null; then
      echo "[claude-exit] claude ignored TERM — sending KILL" >&2
      kill -KILL "$CLAUDE_PID" 2>/dev/null || true
    fi
  fi
  wait "$CLAUDE_PID"
}

# This proof-only entrypoint must not emit the production BRANCH:/MR: success contract.
if [ -n "${IO_FACTORY_SHIP_ONLY_ENVELOPE:-}" ]; then
  if [ -n "${CODING_AGENT_SESSION_URL:-}" ]; then
    echo "[ship-only] refusing to run inside an ECS coding-agent session" >&2
    exit 2
  fi
  SHIP_ONLY_RESULT="$(jq -ce 'select(type == "object"
    and ((.mr_iid | type) == "number") and .mr_iid > 0
    and ((.branch | type) == "string") and (.branch | length) > 0
    and ((.args | type) == "object") and (.args.workDir | type) == "string")' "$IO_FACTORY_SHIP_ONLY_ENVELOPE" 2>/dev/null)" || {
      echo "[ship-only] invalid envelope" >&2
      exit 2
    }
  SHIP_ONLY_MR="$(printf '%s' "$SHIP_ONLY_RESULT" | jq -r .mr_iid)"
  SHIP_ONLY_BRANCH="$(printf '%s' "$SHIP_ONLY_RESULT" | jq -r .branch)"
  SHIP_ONLY_ARGS="$(converge_args_from_result "$SHIP_ONLY_RESULT")" || SHIP_ONLY_ARGS=""
  [ -n "$SHIP_ONLY_ARGS" ] || { echo "[ship-only] incomplete burst args" >&2; exit 2; }
  CONVERGE_ERROR=""
  if converge_loop "$SHIP_ONLY_MR" "$SHIP_ONLY_BRANCH" "$SHIP_ONLY_ARGS"; then
    echo "[ship-only] success mr=!${SHIP_ONLY_MR}"
    stop_trail_tailer; stop_heartbeat
    exit 0
  fi
  echo "[ship-only] failed error=${CONVERGE_ERROR:-converge_error} mr=!${SHIP_ONLY_MR}" >&2
  stop_trail_tailer; stop_heartbeat
  exit 1
fi

# Steering seam: JSON user messages echoed into this pipe mid-run are injected at the next
# tool-call boundary. The path is randomized and owner-only; a pre-created node can only fail
# the run, never inject into a permissionless agent.
IO_INBOX_PIPE="${IO_INBOX_PIPE:-$(mktemp -u /tmp/io-agent-inbox.XXXXXXXX).pipe}"
rm -f "$IO_INBOX_PIPE"
mkfifo -m 600 "$IO_INBOX_PIPE" || { echo "[io-coding-agent-js] mkfifo failed for $IO_INBOX_PIPE — refusing to run with an unverified stdin pipe" >&2; exit 1; }
echo "[io-coding-agent-js] steering inbox pipe: $IO_INBOX_PIPE" >&2
start_steering_bridge
exec 3<>"$IO_INBOX_PIPE"
jq -nc --arg text "$PROMPT" \
  '{type:"user", message:{role:"user", content:[{type:"text", text:$text}]}}' >&3
ERR="${ERR:-${OUT}.err}"
: > "$ERR"
# stdin must be a fresh read-only open with fd 3 closed (never `<&3`) — any surviving write fd denies claude its EOF and hangs the run.
# stderr gets its own file: sharing $OUT's file description lets a newline-less write glue itself onto a JSON line.
claude -p --input-format stream-json --output-format stream-json --verbose \
  --dangerously-skip-permissions --model "$IO_CLAUDE_MODEL" --effort "$IO_CLAUDE_EFFORT" \
  ${IO_CLAUDE_SETTINGS_ARGS[@]+"${IO_CLAUDE_SETTINGS_ARGS[@]}"} \
  < "$IO_INBOX_PIPE" 3>&- > "$OUT" 2> "$ERR" &
CLAUDE_PID=$!

# A run that has reached Ship owns an MR, and resuming it would replay the incomplete child
# workflow from scratch — re-implementing over shipped code. So this answers "can I PROVE this
# run is still pre-Ship?", never "did I fail to find a Ship line?": phase.log must exist, be
# readable and non-empty, and contain no Ship. A missing, unreadable, or empty log (it is
# written by a best-effort agent, so all three happen) is NO proof, and no proof means treat
# the run as shipped. Fail-open on the kill decision; fail-CLOSED on the replay decision,
# because replaying over shipped code is the more destructive of the two mistakes.
io_run_has_shipped() {
  local f proof=0
  for f in .io-agent-*/phase.log; do
    [ -f "$f" ] && [ -r "$f" ] && [ -s "$f" ] || continue
    grep -q '^Ship' "$f" 2>/dev/null && return 0
    proof=1
  done
  [ "$proof" -eq 1 ] || return 0
  return 1
}
# A partial disk handoff must not arm a burst that lies.
io_read_converge_envelope() {
  local f env
  for f in .io-agent-*/converge-envelope.json; do
    [ -f "$f" ] && [ -r "$f" ] || continue
    env=$(jq -ce 'select(type == "object"
      and .project == "io-factory"
      and .protocol == 2
      and ((.session_id | type) == "number") and .session_id > 0
      and ((.mr_iid | type) == "number")
      and ((.source_branch | type) == "string") and .source_branch == .branch
      and ((.nonce | type) == "string") and (.nonce | test("^[0-9a-f]{32}$"))
      and ((.args | type) == "object")
      and (.args | has("workDir"))
      and .args.factoryProtocol == .protocol
      and .args.factorySessionId == .session_id
      and .args.factoryBranch == .source_branch
      and (((.ship_trail // []) | type) == "array")
      and all((.ship_trail // [])[];
        (type == "string") and (length <= 2000) and ((contains("\n") or contains("\r")) | not)))' "$f" 2>/dev/null) || continue
    [ -n "$env" ] || continue
    printf '%s' "$env"
    return 0
  done
  return 1
}
io_recover_converge_envelope_from_journal() {
  local f journal branch nonce marker encoded response matches count mr head envelope lookup_cmd
  local publish_sh="${IO_PUBLISH_SH:-${IO_FACTORY_SOURCE_DIR:-${IO_REPO_DIR:-.}}/tools/factory/publish.sh}"
  for f in .io-agent-*/mr-create-journal.json; do
    [ -f "$f" ] && [ -r "$f" ] || continue
    journal="$(jq -ce --argjson session "${IO_FACTORY_SESSION_ID:-0}" --arg branch "${IO_FACTORY_BRANCH:-}" '
      select(.project == "io-factory" and .protocol == 2
        and .session_id == $session and .unique_branch == $branch
        and (.nonce | type) == "string" and (.nonce | test("^[0-9a-f]{32}$"))
        and (.args | type) == "object"
        and .args.factoryProtocol == 2 and .args.factorySessionId == $session
        and .args.factoryBranch == $branch)' "$f" 2>/dev/null)" || continue
    branch="$(printf '%s' "$journal" | jq -r .unique_branch)"
    nonce="$(printf '%s' "$journal" | jq -r .nonce)"
    marker="<!-- factory-session:2:${IO_FACTORY_SESSION_ID}:$nonce -->"
    encoded="$(jq -rn --arg v "$branch" '$v|@uri')"
    lookup_cmd="$(bash "$publish_sh" lookup-captured "$encoded" 2>/dev/null)" || lookup_cmd=""
    [ -n "$lookup_cmd" ] || return 1
    IO_PUBLISH_JSON=""; IO_PUBLISH_RC=0
    eval "$lookup_cmd"
    [ "$IO_PUBLISH_RC" -eq 0 ] || return 1
    response="$IO_PUBLISH_JSON"
    # An unmapped body would otherwise reach `[ "" -le 1 ]` and read as "matched multiple MRs".
    [ -n "$response" ] || return 1
    matches="$(printf '%s' "$response" | jq -c --arg marker "$marker" --arg branch "$branch" '
      [.[] | select((.id | type) == "number" and .id > 0 and .branch == $branch
        and (.sha | type) == "string" and (.sha | test("^[0-9a-f]{40}$"))
        and ((.description // "") | split("\n") | any(. == $marker)))]')" || return 1
    count="$(printf '%s' "$matches" | jq -r length)"
    [ "$count" -le 1 ] || { echo "[converge] session journal matched multiple MRs" >&2; return 2; }
    [ "$count" -eq 1 ] || continue
    mr="$(printf '%s' "$matches" | jq -r '.[0].id')"
    head="$(printf '%s' "$matches" | jq -r '.[0].sha')"
    envelope="${f%/mr-create-journal.json}/converge-envelope.json"
    printf '%s\n%s\n' "$journal" "$matches" | jq -cs --argjson mr "$mr" --arg head "$head" '
      .[0] as $j | .[1][0] as $mr
      | {project:$j.project,protocol:$j.protocol,session_id:$j.session_id,mr_iid:$mr.id,
          source_branch:$mr.branch,nonce:$j.nonce,branch:$mr.branch,ticket_id:($j.args.ticketId // ""),
          slack:{},ship_trail:[],args:($j.args+{initialHead:$head,initialPipelineFloor:0})}' > "$envelope" || return 1
    echo "[converge] recovered session-owned MR !$mr from exact branch+nonce journal" >&2
    return 0
  done
  return 1
}
io_trail_line_seen_this_run() { # usage: io_trail_line_seen_this_run <trail_file> <exact_line>
  local trail="$1" exact="$2" offset_key="$1" repo="${REPO%/}" offset=0 recorded=""
  case "$offset_key" in "$repo"/*) offset_key="${offset_key#"$repo"/}" ;; esac
  if [ -r "${IO_TRAIL_OFFSETS_FILE:-}" ]; then
    recorded="$(awk -F'\t' -v f="$offset_key" '$1 == f { print $2 }' "$IO_TRAIL_OFFSETS_FILE" 2>/dev/null | tail -1)"
    [ -z "$recorded" ] || offset="$recorded"
  fi
  case "$offset" in *[!0-9]*) return 1 ;; esac
  tail -c +"$(( offset + 1 ))" "$trail" 2>/dev/null | grep -Fqx -- "$exact"
}
io_persist_ship_handoff_trail() { # usage: io_persist_ship_handoff_trail <handoff_json>
  local handoff="$1" mr branch work_dir repo="${REPO%/}" relative trail marker line
  handoff="$(printf '%s' "$handoff" | jq -ce 'select(type == "object"
    and ((.mr_iid | type) == "number") and (.mr_iid > 0)
    and ((.branch | type) == "string") and ((.branch | length) > 0)
    and ((.args.workDir | type) == "string") and ((.args.workDir | length) > 0)
    and (((.ship_trail // []) | type) == "array")
    and all((.ship_trail // [])[];
      (type == "string") and (length <= 2000) and ((contains("\n") or contains("\r")) | not)))' 2>/dev/null)" || return 1
  mr="$(printf '%s' "$handoff" | jq -r '.mr_iid')"
  branch="$(printf '%s' "$handoff" | jq -r '.branch')"
  work_dir="$(printf '%s' "$handoff" | jq -r '.args.workDir')"
  case "$work_dir" in
    "$repo"/*) relative="${work_dir#"$repo"/}" ;;
    /*) return 1 ;;
    *) relative="$work_dir"; work_dir="$repo/$work_dir" ;;
  esac
  case "$relative" in .io-agent-*) ;; *) return 1 ;; esac
  case "$relative" in *[!A-Za-z0-9._-]*) return 1 ;; esac
  [ -d "$work_dir" ] || return 1
  trail="$work_dir/verification-trail.md"
  touch "$trail" || return 1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    io_trail_line_seen_this_run "$trail" "$line" || printf '%s\n' "$line" >> "$trail" || return 1
  done < <(printf '%s' "$handoff" | jq -r '.ship_trail[]?')
  marker="[Ship] MR !${mr} handed to convergence on branch ${branch}"
  io_trail_line_seen_this_run "$trail" "$marker" || printf '%s\n' "$marker" >> "$trail" || return 1
}
io_merge_converge_handoff() { # usage: io_merge_converge_handoff <returned_json> <disk_json>
  jq -cne --argjson returned "$1" --argjson disk "$2" '
    select(($returned.mr_iid // 0) == ($disk.mr_iid // -1))
    | $returned * $disk
    | .args = $disk.args
    | if (($returned.slack // null) | type) == "object"
      then .slack = $returned.slack else . end'
}
# The ORCHESTRATOR's own run id, positively attributed: the first wf_ id on a line that also
# names the parent script. $OUT accumulates the nested Understand/Build workflows' ids too, and
# pairing a CHILD id with the parent scriptPath is a guaranteed cache MISS — a full replay from
# scratch, the exact outcome resume exists to prevent. Empty means "refuse to resume".
io_parent_run_id() {
  grep -a 'work-ticket-orchestrator' "$1" 2>/dev/null | grep -aoE 'wf_[a-z0-9-]{6,}' | head -1
}
# With stdin held open claude does not exit after its result event; close the last write fd so it sees EOF.
IO_CLOSE_REASON=""
STALL_RESTARTS=0
while kill -0 "$CLAUDE_PID" 2>/dev/null; do
  # A result event alone is NOT completion: when the Workflow tool runs in the background the
  # model can end its turn early ("it's running, I'll wait"), and closing stdin there EOFs a
  # healthy run mid-pipeline — the wrapper then TERMs its own workflow. Require the workflow's
  # own result before believing it; if claude exits by itself the `while kill -0` ends the loop.
  if stream_has_result_event "$OUT" && [ -n "$(extract_workflow_result_json "$OUT")" ]; then IO_CLOSE_REASON="result-event"; break; fi
  if workflow_complete_and_quiet; then IO_CLOSE_REASON="completion-quiet"; break; fi
  if [ -s "${IO_STALL_FLAG:-}" ]; then
    STALL_INFO=$(cat "$IO_STALL_FLAG" 2>/dev/null); rm -f "$IO_STALL_FLAG" 2>/dev/null || true
    STALL_RUN_ID=$(io_parent_run_id "$OUT")
    # resumeFromRunId only hits cache while the run's journal survives, and that journal lives
    # under this run's private config dir. If a refactor ever moved the mktemp, "resume" would
    # silently degrade into "replay from scratch" — so a missing dir revokes the resume.
    [ -d "${CLAUDE_CONFIG_DIR:-}" ] || STALL_RUN_ID=""
    # A shipped run cannot be REPLAYED, but it no longer needs to be: the MR exists and the ship
    # agent left the envelope, so bash can finish it exactly as if burst 0 had returned. Kill the
    # stuck model and drop out to convergence — only the run with no envelope is unrecoverable.
    if io_run_has_shipped && [ -n "$(io_read_converge_envelope || true)" ]; then
      echo "[stall-watchdog] $STALL_INFO — hung after Ship, but the envelope is on disk; killing the model and handing the MR to bash" >&2
      io_stall_slack "🔁 Stall watchdog: the model hung after Ship — bash is taking the MR through convergence ($STALL_INFO)"
      io_stall_trail "[Setup] Stall watchdog: hang signature confirmed ($STALL_INFO) after Ship — model killed, convergence adopted the MR from the on-disk envelope."
      IO_CLOSE_REASON="stall-adopted"
      break
    fi
    if io_run_has_shipped || [ -z "$STALL_RUN_ID" ] || [ "$STALL_RESTARTS" -ge "${IO_STALL_MAX_RESTARTS:-3}" ]; then
      # No provably safe replay: kill and exit non-zero so the Ruby finalizer rejects this run
      # within minutes instead of the worker idling to the 3h reaper. The MR is retained
      # (never disown) and the run falls through to the normal reject/Auto-Triage path.
      echo "[stall-watchdog] $STALL_INFO — unrecoverable (shipped=$(io_run_has_shipped && echo yes || echo no) parent_run=${STALL_RUN_ID:-none} restarts=${STALL_RESTARTS}/${IO_STALL_MAX_RESTARTS:-3}); killing and failing the run" >&2
      io_stall_slack "🧟 Stall watchdog: killing a hung run and failing it for re-triage ($STALL_INFO)"
      io_stall_trail "[Setup] Stall watchdog: hang signature confirmed ($STALL_INFO) after Ship, or with no positively-attributed parent run id — killed and failed; the MR is retained for re-triage."
      stop_steering_bridge
      exec 3>&-
      wait_for_claude_exit || true
      stop_trail_tailer; stop_heartbeat
      exit 75
    fi
    STALL_RESTARTS=$(( STALL_RESTARTS + 1 ))
    echo "[stall-watchdog] $STALL_INFO — restarting parent run ${STALL_RUN_ID} (attempt ${STALL_RESTARTS}/${IO_STALL_MAX_RESTARTS:-3}, journal ${CLAUDE_CONFIG_DIR}); completed agent calls replay from cache" >&2
    io_stall_slack "♻️ Stall watchdog: restart ${STALL_RESTARTS}/${IO_STALL_MAX_RESTARTS} of a hung pre-Ship run, resuming ${STALL_RUN_ID} ($STALL_INFO)"
    io_stall_trail "[Setup] Stall watchdog: hang signature confirmed ($STALL_INFO) before Ship — killed and resumed ${STALL_RUN_ID} (attempt ${STALL_RESTARTS}/${IO_STALL_MAX_RESTARTS:-3}); unchanged agent calls replay from cache."
    exec 3>&-
    wait_for_claude_exit || true
    rm -f "$IO_INBOX_PIPE"
    mkfifo -m 600 "$IO_INBOX_PIPE" || { echo "[stall-watchdog] mkfifo failed on restart — failing the run" >&2; exit 75; }
    exec 3<>"$IO_INBOX_PIPE"
    jq -nc --arg text "Call the Workflow tool exactly once with scriptPath '${IO_WORK_TICKET_ORCHESTRATOR_JS}', resumeFromRunId '${STALL_RUN_ID}', and args set to EXACTLY this JSON object, copied verbatim: ${ARGS}. The previous attempt of this same run hung on an idle connection and was killed; agent calls that already completed replay from cache, so continue from the first incomplete step. Do not take any other action before or after. When it returns, print its result EXACTLY between these markers and print nothing after the closing marker:
===IO_RESULT_BEGIN===
<the workflow's returned JSON>
===IO_RESULT_END===" \
      '{type:"user", message:{role:"user", content:[{type:"text", text:$text}]}}' >&3
    claude -p --input-format stream-json --output-format stream-json --verbose \
      --dangerously-skip-permissions --model "$IO_CLAUDE_MODEL" --effort "$IO_CLAUDE_EFFORT" \
      ${IO_CLAUDE_SETTINGS_ARGS[@]+"${IO_CLAUDE_SETTINGS_ARGS[@]}"} \
      < "$IO_INBOX_PIPE" 3>&- >> "$OUT" 2>&1 &
    CLAUDE_PID=$!
  fi
  sleep 5 & wait $! || true
done
echo "[claude-exit] closing steering inbox (reason: ${IO_CLOSE_REASON:-claude-exited}, quiet window ${IO_RESULT_QUIET_SECS}s)"
# Stopped as part of the close: past `exec 3>&-` the bridge would still re-open the FIFO for write and re-arm the reader.
stop_steering_bridge
exec 3>&-
wait_for_claude_exit
CLAUDE_EXIT=$?
stop_trail_tailer
stop_heartbeat
# Surface the full headless run to CloudWatch for debugging, but scrub secret-shaped tokens
# (Slack xox*/Bearer, Linear lin_api_) at this single chokepoint — so even if a sub-agent ever
# violated its "never echo the token" instruction, it can't leak into the durable log sink.
# Everything downstream (the transcript print AND the sentinel parse the contract lines echo
# from) reads the SCRUBBED artifact, so no parsed field can reintroduce an unscrubbed token.
SCRUBBED="${OUT}.scrubbed"
scrub_stream < "$OUT" > "$SCRUBBED"

RESULT_TEXT=$(extract_stream_result_text "$SCRUBBED")
WORKFLOW_RESULT_JSON=$(extract_workflow_result_json "$SCRUBBED")
# The returned object carries Slack state; the disk copy carries the authoritative initial head,
# pipeline floor, and head-start time. Merge them whenever they name the same MR. Falling back to
# disk also adopts an MR whose model produced no final result event.
DISK_ENVELOPE_JSON="$(io_read_converge_envelope || true)"
if [ -z "$DISK_ENVELOPE_JSON" ] && io_run_has_shipped; then
  io_recover_converge_envelope_from_journal || true
  DISK_ENVELOPE_JSON="$(io_read_converge_envelope || true)"
fi
HANDOFF_TRAIL_JSON=""
RETURNED_TERMINAL_ERROR="$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.error // empty' 2>/dev/null)"
if [ -n "$DISK_ENVELOPE_JSON" ]; then
  # A prior Ship envelope must never revive a later phase's terminal failure for the same MR.
  if [ -n "$RETURNED_TERMINAL_ERROR" ]; then
    echo "[converge] ignoring on-disk envelope because the workflow returned terminal error: $RETURNED_TERMINAL_ERROR" >&2
  elif [ -z "$WORKFLOW_RESULT_JSON" ]; then
    WORKFLOW_RESULT_JSON="$DISK_ENVELOPE_JSON"
    HANDOFF_TRAIL_JSON="$WORKFLOW_RESULT_JSON"
    echo "[converge] adopting the on-disk envelope — burst 0 shipped MR !$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.mr_iid') but never returned" >&2
  elif MERGED_HANDOFF_JSON="$(io_merge_converge_handoff "$WORKFLOW_RESULT_JSON" "$DISK_ENVELOPE_JSON")"; then
    WORKFLOW_RESULT_JSON="$MERGED_HANDOFF_JSON"
    HANDOFF_TRAIL_JSON="$WORKFLOW_RESULT_JSON"
    echo "[converge] loaded durable head and pipeline floor from the on-disk handoff" >&2
  else
    echo "[converge] ignoring on-disk envelope for a different MR" >&2
  fi
fi
if [ -n "$HANDOFF_TRAIL_JSON" ] && ! io_persist_ship_handoff_trail "$HANDOFF_TRAIL_JSON"; then
  echo "[converge] failed to persist the durable Ship trail from the handoff envelope" >&2
fi
if [ -n "${IO_FACTORY_HANDOFF_ONLY_ARGS:-}" ]; then
  HANDOFF_MR="$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.mr_iid // empty' 2>/dev/null | tr -dc '0-9')"
  HANDOFF_BRANCH="$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.branch // empty' 2>/dev/null | head -n 1)"
  HANDOFF_ARGS="$(converge_args_from_result "$WORKFLOW_RESULT_JSON")" || HANDOFF_ARGS=""
  if [ -z "$HANDOFF_MR" ] || [ -z "$HANDOFF_BRANCH" ] || [ -z "$HANDOFF_ARGS" ]; then
    echo "[handoff-only] production handoff did not produce a complete convergence envelope" >&2
    exit 1
  fi
  echo "[handoff-only] ready mr=!${HANDOFF_MR} branch=${HANDOFF_BRANCH}"
  exit 0
fi
# CloudWatch volume parity with the old final-text-only $OUT; the capped tail keeps failure evidence when no result event exists.
printf '%s\n' "$RESULT_TEXT"
if [ -z "$RESULT_TEXT" ]; then
  # Restores the stderr this dump implicitly carried before the 2> "$ERR" split.
  if [ -s "$ERR" ]; then
    tail -n 50 "$ERR" | scrub_stream | cut -c1-500 | sed 's/^/[claude-stderr] /'
  fi
  tail -n 100 "$SCRUBBED" | cut -c1-500
fi

# Convergence. Burst 0 has shipped and exited; from here bash owns the MR. The loop's own exit is
# never a separate contract emission — a clean vector replaces the result with the terminal
# burst's, and an exhausted wall clock stamps an `error` onto burst 0's result so the single
# emit_run_contract below takes its retained-MR branch.
WORKFLOW_TERMINAL_ERROR="$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.error // empty' 2>/dev/null)"
if [ -n "$WORKFLOW_RESULT_JSON" ] && [ -z "$WORKFLOW_TERMINAL_ERROR" ]; then
  CONVERGE_ERROR=""
  CONVERGE_MR=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.mr_iid // empty' | tr -dc '0-9')
  CONVERGE_BRANCH=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.branch // empty' | head -n 1)
  # Refuse to converge without the complete envelope rather than dispatch a burst against an
  # unknown work directory or MR.
  CONVERGE_ARGS=$(converge_args_from_result "$WORKFLOW_RESULT_JSON")
  if [ -z "$CONVERGE_MR" ] || [ -z "$CONVERGE_ARGS" ]; then
    echo "[converge] not arming: burst 0 reported no MR or an incomplete argument envelope — leaving the result as-is" >&2
  elif [ "${IO_FACTORY_LOOP_LAUNCHED:-}" = "1" ]; then
    # The loop evaluates the PR itself and re-fires with guidance; this GitLab-shaped repair loop would only crash.
    echo "[converge] not arming: loop-launched run — the loop owns convergence of MR !${CONVERGE_MR}" >&2
  elif ! converge_link_session_mr "$CONVERGE_MR" "$CONVERGE_BRANCH"; then
    CONVERGE_ERROR="ship_mr_link_failed"
    echo "[converge] not arming: live session could not register MR !${CONVERGE_MR}" >&2
    WORKFLOW_RESULT_JSON=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -c --arg e "$CONVERGE_ERROR" '. + {error: $e}')
  elif converge_loop "$CONVERGE_MR" "$CONVERGE_BRANCH" "$CONVERGE_ARGS"; then
    [ -n "$BURST_RESULT_JSON" ] && WORKFLOW_RESULT_JSON="$BURST_RESULT_JSON"
  else
    WORKFLOW_RESULT_JSON=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -c --arg e "${CONVERGE_ERROR:-converge_error}" '. + {error: $e}')
  fi
elif [ -n "$WORKFLOW_TERMINAL_ERROR" ]; then
  echo "[converge] not arming: workflow returned terminal error: $WORKFLOW_TERMINAL_ERROR" >&2
fi

# One named function so the spec harness can extract and pin the scraper-matched contract lines.
emit_run_contract() {
  local RESULT_TEXT="$1"
  local WORKFLOW_RESULT_JSON="${2:-}"
  BRANCH=""; MR_IID=""; ALREADY_FIXED=""; FIXED_COMMIT=""; FIXED_EVIDENCE=""; DUPLICATE_OF=""; STATUS=""; ERROR_DETAIL=""
  if [ -n "$WORKFLOW_RESULT_JSON" ]; then
    echo "[io-coding-agent-js] result source: workflow-json" >&2
    BRANCH=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.branch // empty' | head -n 1)
    MR_IID=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.mr_iid // empty' | tr -dc '0-9')
    ALREADY_FIXED=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r 'if .already_fixed == true then "true" else empty end')
    FIXED_COMMIT=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.fixed_commit // empty' | tr 'A-F' 'a-f' | tr -dc 'a-f0-9' | cut -c1-40)
    # JSON evidence can be multi-line; the contract lines are line-anchored, so collapse first.
    FIXED_EVIDENCE=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.fixed_evidence // empty | gsub("[\r\n]+"; " ")' | cut -c1-300)
    DUPLICATE_OF=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.duplicate_of // empty' | tr 'a-z' 'A-Z' | tr -dc 'A-Z0-9-' | cut -c1-40)
    printf '%s\n' "$DUPLICATE_OF" | grep -qE '^[A-Z]+-[0-9]+$' || DUPLICATE_OF=""
    STATUS=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.status // empty' | head -n 1)
    ERROR_DETAIL=$(printf '%s' "$WORKFLOW_RESULT_JSON" | jq -r '.error // empty' | tr -cd 'a-zA-Z0-9_.-' | cut -c1-80)
  else
    echo "[io-coding-agent-js] result source: sentinel" >&2
    # Parse the sentinel block (best-effort).
    RESULT=$(printf '%s\n' "$RESULT_TEXT" | awk '/===IO_RESULT_BEGIN===/{f=1;next}/===IO_RESULT_END===/{f=0}f')
    BRANCH=$(printf '%s\n' "$RESULT" | sed -n 's/^branch=//p' | tail -1)
    MR_IID=$(printf '%s\n' "$RESULT" | sed -n 's/^mr=//p' | tail -1 | tr -dc '0-9')
    ALREADY_FIXED=$(printf '%s\n' "$RESULT" | sed -n 's/^already_fixed=//p' | tail -1)
    FIXED_COMMIT=$(printf '%s\n' "$RESULT" | sed -n 's/^fixed_commit=//p' | tail -1 | tr 'A-F' 'a-f' | tr -dc 'a-f0-9' | cut -c1-40)
    FIXED_EVIDENCE=$(printf '%s\n' "$RESULT" | sed -n 's/^fixed_evidence=//p' | tail -1 | cut -c1-300)
    DUPLICATE_OF=$(printf '%s\n' "$RESULT" | sed -n 's/^duplicate_of=//p' | tail -1 | tr 'a-z' 'A-Z' | tr -dc 'A-Z0-9-' | cut -c1-40)
    printf '%s\n' "$DUPLICATE_OF" | grep -qE '^[A-Z]+-[0-9]+$' || DUPLICATE_OF=""
    STATUS=$(printf '%s\n' "$RESULT" | sed -n 's/^status=//p' | tail -1)
    ERROR_DETAIL=$(printf '%s\n' "$RESULT" | sed -n 's/^error=//p' | tail -1 | tr -cd 'a-zA-Z0-9_.-' | cut -c1-80)
  fi

  MR_ADOPTED_VIA=""

  # Branch fallback: recover the branch from git when neither the sentinel's branch= nor an
  # adopted trail marker carried one (used only alongside an MR).
  if [ -z "$BRANCH" ]; then BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""); fi

  # Emit the contract finalize_orchestrated_session! scrapes, and set the exit code. Check
  # already-fixed FIRST so it can never be misclassified as an MR. The ALREADY_FIXED_COMMIT /
  # ALREADY_FIXED_EVIDENCE / ALREADY_FIXED_DUPLICATE_OF, MR_ADOPTED_VIA, and MR_OPEN_FINDINGS
  # lines are observability-only (durable in CloudWatch + the session logs page); the Rails
  # scraper's line-anchored BRANCH:/MR: regexes and exact 'ALREADY_FIXED:true' match ignore them.
  if [ "$ALREADY_FIXED" = "true" ]; then
    echo "ALREADY_FIXED:true"
    [ -n "$FIXED_COMMIT" ] && echo "ALREADY_FIXED_COMMIT:$FIXED_COMMIT"
    [ -n "$FIXED_EVIDENCE" ] && echo "ALREADY_FIXED_EVIDENCE:$FIXED_EVIDENCE"
    [ -n "$DUPLICATE_OF" ] && echo "ALREADY_FIXED_DUPLICATE_OF:$DUPLICATE_OF"
    # Co-emit a kickback re-run's retained MR so it stays linked on the session for human cleanup; Rails takes ALREADY_FIXED for the terminal state.
    if [ -n "$MR_IID" ]; then
      echo "BRANCH:$BRANCH"
      echo "MR:$MR_IID"
      [ -n "$ERROR_DETAIL" ] && echo "MR_OPEN_FINDINGS:$ERROR_DETAIL"
    fi
    exit 0
  elif [ -n "$MR_IID" ] && [ -n "$ERROR_DETAIL" ]; then
    echo "BRANCH:$BRANCH"
    echo "MR:$MR_IID"
    echo "MR_OPEN_FINDINGS:$ERROR_DETAIL"
    echo "[io-coding-agent-js] run FAILED with retained MR !${MR_IID} (error: ${ERROR_DETAIL}) — session will be rejected for the Auto-Triage retry" >&2
    exit 1
  elif [ -n "$MR_IID" ]; then
    echo "BRANCH:$BRANCH"
    echo "MR:$MR_IID"
    [ -n "$MR_ADOPTED_VIA" ] && echo "MR_ADOPTED_VIA:$MR_ADOPTED_VIA"
    exit 0
  else
    echo "[io-coding-agent-js] no MR found and not already-fixed (claude exit ${CLAUDE_EXIT}${STATUS:+, workflow status: ${STATUS}}${ERROR_DETAIL:+, detail: ${ERROR_DETAIL}})" >&2
    exit 1
  fi
}
emit_run_contract "$RESULT_TEXT" "$WORKFLOW_RESULT_JSON"
