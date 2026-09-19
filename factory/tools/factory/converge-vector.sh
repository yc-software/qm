#!/bin/bash
# Read the convergence vector for a factory MR and print it as KEY=value lines.
#
# This is the READ half of Phase 5: deciding whether an MR is converged needs no LLM, only
# GitLab and git. Each condition is emitted as <name>=true|false plus <name>_detail=<token>, so
# a caller can act on the verdict and a human can see why. Nothing here adjudicates: ledger_clean
# reports whether unresolved threads EXIST, never whether their contents were handled well, and
# acceptance_drift_clean is not read here at all (it needs the on-disk acceptance artifacts).
#
# Usage: converge-vector.sh <mr_iid> <branch> [head_sha]
#   head_sha defaults to `git rev-parse HEAD`.
#
# Fail-closed is the default: an unreadable condition is false, because "we could not tell" must
# never advance an MR toward ready. `mergeable` is the deliberate exception — GitLab
# computes it asynchronously and it lags after every push, so an unsettled value fails OPEN and
# only a settled conflict blocks.
#
# Auth: every captured read goes through io_glab_json_with_refresh, never a bare `glab` and never
# io_glab_with_gitlab_refresh (whose merged stderr would pollute the JSON). Convergence outlives
# the user token's 2h TTL, so rc 78 (auth still failing after one refresh) is reported as an
# infrastructure escalation rather than as any condition's verdict — a 401 must not read as
# "not ready".
set -uo pipefail

MR_IID="${1:-}"
BRANCH="${2:-}"
HEAD_SHA="${3:-}"
GLAB_TIMEOUT="${IO_CONVERGE_GLAB_TIMEOUT:-30}"
# The ship snapshot carries converge-vector.sh without publish.sh or source.sh, so `dirname "$0"` cannot find them.
IO_PUBLISH_SH="${IO_PUBLISH_SH:-${IO_FACTORY_SOURCE_DIR:-${IO_REPO_DIR:-.}}/tools/factory/publish.sh}"
IO_SOURCE_SH="${IO_SOURCE_SH:-${IO_FACTORY_SOURCE_DIR:-${IO_REPO_DIR:-.}}/tools/factory/source.sh}"
PIPELINE_FLOOR="${IO_CONVERGE_PIPELINE_FLOOR:-0}"
# Bugbot is recognised by numeric author id, never by username — a display name is spoofable and
# renameable. 0 (the default) means no Bugbot is installed on this instance: the review condition
# reads as satisfied and the other conditions still evaluate.
BUGBOT_GITLAB_USER_ID="${IO_BUGBOT_GITLAB_USER_ID:-0}"
case "$BUGBOT_GITLAB_USER_ID" in ''|*[!0-9]*) BUGBOT_GITLAB_USER_ID=0 ;; esac
# Keyed on numeric id, never on the emoji name: other bots award `eyes` on ~46% of MRs, so a name-only test would make nearly half of all runs wait. 0 disables the check.
FOREMAN_GITLAB_USER_ID="${IO_FOREMAN_GITLAB_USER_ID:-0}"
case "$FOREMAN_GITLAB_USER_ID" in ''|*[!0-9]*) FOREMAN_GITLAB_USER_ID=0 ;; esac
# 0 disables the deploy-preview note filter.
DEPLOY_PREVIEW_GITLAB_USER_ID="${IO_DEPLOY_PREVIEW_GITLAB_USER_ID:-0}"
case "$DEPLOY_PREVIEW_GITLAB_USER_ID" in ''|*[!0-9]*) DEPLOY_PREVIEW_GITLAB_USER_ID=0 ;; esac
FACTORY_GITLAB_USER_ID="${IO_FACTORY_GITLAB_USER_ID:-0}"
EXPECTED_SESSION_MARKER="${IO_CONVERGE_SESSION_MARKER:-}"
# publish.sh routes the reads on this same variable, so the selector must match its `github` test exactly or the name would contradict the forge actually read.
case "${IO_PUBLISH_FORGE:-gitlab}" in github) FORGE_NAME=github ;; *) FORGE_NAME=gitlab ;; esac
if [ -z "$MR_IID" ] || [ -z "$BRANCH" ]; then
  echo "usage: converge-vector.sh <mr_iid> <branch> [head_sha]" >&2
  exit 2
fi

if [ -n "${IO_GITLAB_HELPER_SH:-}" ] && [ -f "$IO_GITLAB_HELPER_SH" ]; then
  # shellcheck disable=SC1090
  . "$IO_GITLAB_HELPER_SH"
fi
# Without the helper there is no auth-refreshing read, and every condition would report a
# fail-closed verdict for an infrastructure reason. Say so once instead.
if ! type io_glab_json_with_refresh >/dev/null 2>&1; then
  echo "vector_readable=false"
  echo "vector_error=gitlab_helper_unavailable"
  exit 0
fi

AUTH_FAILED=0
READ_FAILED=0
REPLY_JSON=""
# Captured read, assigning into REPLY_JSON rather than printing. A `X=$(glab_json …)` form would
# run the function in a SUBSHELL, so an rc-78 auth escalation could never reach AUTH_FAILED in the
# parent — and an expired token would be reported as six ordinary fail-closed verdicts, i.e. a
# healthy MR reading as unready. rc 79 (rc 0, unparseable body) stays a real unreadable and takes
# each condition's own disposition.
read_json() {
  local rc=0
  REPLY_JSON="$(io_glab_json_with_refresh "$GLAB_TIMEOUT" "$@")" || rc=$?
  if [ "$rc" -eq 78 ]; then AUTH_FAILED=1; REPLY_JSON=""; fi
  # 77 = failed twice with no auth marker anywhere. Reporting it as expired auth is what made a
  # DNS or binary fault read as a token problem; it is still infrastructure, so it still escalates.
  if [ "$rc" -eq 77 ]; then READ_FAILED=1; REPLY_JSON=""; fi
  return 0
}

# Same globals contract as read_json; the emission is eval'd in this function body, never in `$( … )`.
read_shim() {
  local cmd=""
  cmd="$(bash "$IO_PUBLISH_SH" "$@" 2>/dev/null)" || cmd=""
  if [ -z "$cmd" ]; then
    echo "[converge] publish.sh ${1:-}: no command emitted" >&2
    READ_FAILED=1
    REPLY_JSON=""
    return 0
  fi
  # Pre-set: under `set -u` a truncated emission would leave these unset and kill the whole vector.
  IO_PUBLISH_JSON=""
  IO_PUBLISH_RC=0
  eval "$cmd"
  REPLY_JSON="$IO_PUBLISH_JSON"
  if [ "$IO_PUBLISH_RC" -eq 78 ]; then AUTH_FAILED=1; REPLY_JSON=""; fi
  if [ "$IO_PUBLISH_RC" -eq 77 ]; then READ_FAILED=1; REPLY_JSON=""; fi
  return 0
}

# Memoized: two independent conditions read the award list, and one read per poll is the budget.
AWARDS_JSON=""
AWARDS_READ=0
AWARDS_READABLE=true
read_awards_once() {
  [ "$AWARDS_READ" -eq 0 ] || return 0
  AWARDS_READ=1
  read_shim mr-awards "$MR_IID"
  AWARDS_JSON="$REPLY_JSON"
  [ -n "$AWARDS_JSON" ] || AWARDS_READABLE=false
}

emit() { printf '%s=%s\n' "$1" "$2"; }

[ -n "$HEAD_SHA" ] || HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"
emit head_sha "${HEAD_SHA:-unknown}"

read_shim mr-show-captured "$MR_IID"; MR_JSON="$REPLY_JSON"
MR_STATE="$(printf '%s' "$MR_JSON" | jq -r '.state // ""' 2>/dev/null)"
MR_SHA="$(printf '%s' "$MR_JSON" | jq -r '.sha // ""' 2>/dev/null)"
MR_SOURCE_BRANCH="$(printf '%s' "$MR_JSON" | jq -r '.branch // ""' 2>/dev/null)"
MR_MERGE_STATUS="$(printf '%s' "$MR_JSON" | jq -r '.merge_status // ""' 2>/dev/null)"
MR_DESCRIPTION="$(printf '%s' "$MR_JSON" | jq -r '.description // ""' 2>/dev/null)"
emit mr_state "${MR_STATE:-unknown}"
emit source_branch "${MR_SOURCE_BRANCH:-unknown}"
DESCRIPTION_FINGERPRINT="$(printf '%s' "$MR_DESCRIPTION" | cksum | awk '{print $1 ":" $2}')"
emit description_fingerprint "${DESCRIPTION_FINGERPRINT:-unreadable}"
if [ -z "$EXPECTED_SESSION_MARKER" ]; then
  emit session_identity true; emit session_identity_detail not_required
elif [ "$MR_SOURCE_BRANCH" = "$BRANCH" ] \
  && printf '%s\n' "$MR_DESCRIPTION" | grep -Fqx -- "$EXPECTED_SESSION_MARKER"; then
  emit session_identity true; emit session_identity_detail match
else
  emit session_identity false; emit session_identity_detail mismatch
fi

# ── exact_head ────────────────────────────────────────────────────────────────────────────────
# The bracket around every other condition: they are only meaningful about ONE sha. A head that
# moved mid-round invalidates the round rather than the MR.
if [ -z "$MR_SHA" ] || [ -z "$HEAD_SHA" ]; then
  emit exact_head false; emit exact_head_detail unreadable
elif [ "$MR_SHA" = "$HEAD_SHA" ]; then
  emit exact_head true; emit exact_head_detail match
else
  emit exact_head false; emit exact_head_detail "moved:${MR_SHA:0:11}"
fi

# ── diff_exists ───────────────────────────────────────────────────────────────────────────────
# An emptied branch is ambiguous on its own, so .state disambiguates: merged is TERMINAL SUCCESS
# (the deliverable was accepted), closed blocks, and an empty diff on an open MR means the branch
# was emptied and there is nothing to review.
DIFF_BASE_READABLE=true
DIFF_LINES=0
BASE_REF="$(bash "$IO_SOURCE_SH" base-ref 2>/dev/null)" || BASE_REF=""
if [ -z "$BASE_REF" ] || [ -z "$HEAD_SHA" ] \
  || ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null 2>&1; then
  DIFF_BASE_READABLE=false
elif ! DIFF_NAMES="$(git diff --name-only "${BASE_REF}...${HEAD_SHA}" 2>/dev/null)"; then
  DIFF_BASE_READABLE=false
else
  DIFF_LINES="$(printf '%s\n' "$DIFF_NAMES" | grep -c . || true)"
fi
if [ "$MR_STATE" = "merged" ]; then
  emit diff_exists false; emit diff_exists_detail merged_terminal_success
elif [ "$MR_STATE" = "closed" ]; then
  emit diff_exists false; emit diff_exists_detail mr_closed
elif [ "$DIFF_BASE_READABLE" != true ]; then
  echo "[converge] diff base unreadable: ${BASE_REF:-<none>}...${HEAD_SHA:-<none>}" >&2
  emit diff_exists false; emit diff_exists_detail diff_base_unreadable
elif [ "${DIFF_LINES:-0}" -gt 0 ] 2>/dev/null; then
  emit diff_exists true; emit diff_exists_detail "files:${DIFF_LINES}"
else
  emit diff_exists false; emit diff_exists_detail branch_diff_empty
fi

# ── ci_green_on_head ──────────────────────────────────────────────────────────────────────────
# Select the newest real pipeline above the old-head floor; only this MR's merge-result ref may use a synthetic SHA.
read_shim mr-pipelines "$MR_IID"; PIPES_JSON="$REPLY_JSON"
case "$PIPELINE_FLOOR" in ''|*[!0-9]*) PIPELINE_FLOOR=0 ;; esac
PIPE_CANDIDATES="$(printf '%s' "$PIPES_JSON" | jq -c --argjson floor "$PIPELINE_FLOOR" '
  if type=="array" then
    [.[]
      | select((.source // "") != "external")
      | select((.id // 0) > $floor)
    ] | sort_by(.id) | reverse | .[]
  else empty end' 2>/dev/null)"
PIPE_JSON='{}'
while IFS= read -r PIPE_CANDIDATE; do
  [ -n "$PIPE_CANDIDATE" ] || continue
  PIPE_SHA="$(printf '%s' "$PIPE_CANDIDATE" | jq -r '.sha // ""' 2>/dev/null)"
  PIPE_SOURCE="$(printf '%s' "$PIPE_CANDIDATE" | jq -r '.source // ""' 2>/dev/null)"
  PIPE_REF="$(printf '%s' "$PIPE_CANDIDATE" | jq -r '.ref // ""' 2>/dev/null)"
  PIPE_BOUND=false
  if [ -n "$PIPE_SHA" ] && [ "$PIPE_SHA" = "$HEAD_SHA" ]; then
    PIPE_BOUND=true
  elif [ "$PIPE_SOURCE" = merge_request_event ] \
    && [ "$PIPE_REF" = "refs/merge-requests/$MR_IID/merge" ] \
    && printf '%s' "$PIPE_SHA" | grep -qE '^[0-9a-f]{40}$'; then
    read_shim commit-show "$PIPE_SHA"; PIPE_COMMIT_JSON="$REPLY_JSON"
    if printf '%s' "$PIPE_COMMIT_JSON" | jq -e --arg head "$HEAD_SHA" \
      'type=="object" and ((.parent_ids // []) | length) == 2
        and any((.parent_ids // [])[]; . == $head)' >/dev/null 2>&1; then
      PIPE_BOUND=true
    fi
  fi
  if [ "$PIPE_BOUND" = true ]; then PIPE_JSON="$PIPE_CANDIDATE"; break; fi
done <<PIPELINE_CANDIDATES
$PIPE_CANDIDATES
PIPELINE_CANDIDATES
if ! printf '%s' "$MR_JSON" | jq -e 'type=="object"' >/dev/null 2>&1; then PIPE_JSON=""; fi
PIPE_STATUS="$(printf '%s' "$PIPE_JSON" | jq -r '.status // ""' 2>/dev/null)"
PIPE_ID="$(printf '%s' "$PIPE_JSON" | jq -r '.id // ""' 2>/dev/null)"
PIPE_CREATED="$(printf '%s' "$PIPE_JSON" | jq -r '.created_at // ""' 2>/dev/null)"
emit pipeline_id "${PIPE_ID:-none}"
emit pipeline_status "${PIPE_STATUS:-unknown}"
case "$PIPE_STATUS" in
  success) emit ci_green_on_head true;  emit ci_green_on_head_detail success ;;
  failed)  emit ci_green_on_head false; emit ci_green_on_head_detail failed ;;
  canceled|skipped) emit ci_green_on_head false; emit ci_green_on_head_detail "$PIPE_STATUS" ;;
  running|pending|created|waiting_for_resource|preparing|manual|scheduled)
           emit ci_green_on_head false; emit ci_green_on_head_detail "unsettled:$PIPE_STATUS" ;;
  '')      # A readable MR with no authoritative head pipeline yields {}; this is normal just after Ship.
           # Treat it as a wait so the first tick does not dispatch a pointless repair burst.
           # A non-object body is genuinely unreadable and keeps failing closed.
           if printf '%s' "$PIPE_JSON" | jq -e 'type=="object"' >/dev/null 2>&1; then
             emit ci_green_on_head false; emit ci_green_on_head_detail "unsettled:no_pipeline_yet"
           else
             emit ci_green_on_head false; emit ci_green_on_head_detail unreadable
           fi ;;
  *)       emit ci_green_on_head false; emit ci_green_on_head_detail unreadable ;;
esac

# ── mergeable ─────────────────────────────────────────────────────────────────────────────────
# GitLab recomputes detailed_merge_status asynchronously after pushes. checking/unchecked are a
# wait, a settled conflict is repairable, and an unreadable value is an explicit read failure.
case "$MR_MERGE_STATUS" in
  conflict|broken_status|not_open|discussions_not_resolved|draft_status)
      emit mergeable false; emit mergeable_detail "$MR_MERGE_STATUS" ;;
  checking|unchecked)
      emit mergeable unknown; emit mergeable_detail "$MR_MERGE_STATUS" ;;
  "") emit mergeable false; emit mergeable_detail unreadable ;;
  *)  emit mergeable true;  emit mergeable_detail "$MR_MERGE_STATUS" ;;
esac

# ── bugbot_reviewed_exact_head ────────────────────────────────────────────────────────────────
# Bugbot must have reviewed THIS sha, not an earlier one: a review of a superseded head says
# nothing about the code that would merge. The Cursor summary in Bugbot's immutable GitLab
# description version identifies the head; the later clean award proves completion.
read_shim mr-notes "$MR_IID"; NOTES_JSON="$REPLY_JSON"
BUGBOT_NOTE_SHA="$(printf '%s' "$NOTES_JSON" | jq -r --argjson bid "$BUGBOT_GITLAB_USER_ID" '
  if type=="array" then
    [ .[]
      | select(.author.id == $bid)
      | select(((.body // "") | contains("<!-- BUGBOT_REVIEW -->")))
    ]
    | sort_by([(.created_at // ""), (.id // 0)])
    | [ .[] | (.body // "") | capture("for commit (?<sha>[0-9a-f]{40})").sha ]
    | (last // "")
  else "" end' 2>/dev/null)"
BUGBOT_DESCRIPTION_CHANGE="$(printf '%s' "$NOTES_JSON" | jq -c --argjson bid "$BUGBOT_GITLAB_USER_ID" '
  if type=="array" then
    [ .[]
      | select(.system == true and .body == "changed the description" and .author.id == $bid)
    ]
      | sort_by([(.created_at // ""), (.id // 0)]) | (last // {})
  else {} end' 2>/dev/null)"
BUGBOT_DESCRIPTION_NOTE_ID="$(printf '%s' "$BUGBOT_DESCRIPTION_CHANGE" | jq -r '.id // 0' 2>/dev/null)"
BUGBOT_DESCRIPTION_CHANGED_AT="$(printf '%s' "$BUGBOT_DESCRIPTION_CHANGE" | jq -r '.created_at // ""' 2>/dev/null)"
BUGBOT_DESCRIPTION_VERSION_READABLE=true
BUGBOT_DESCRIPTION_AT_REVIEW=""
if [ "$BUGBOT_DESCRIPTION_NOTE_ID" -gt 0 ] 2>/dev/null; then
  read_json api graphql -f "query=query { note(id: \"gid://gitlab/Note/$BUGBOT_DESCRIPTION_NOTE_ID\") { systemNoteMetadata { descriptionVersion { description } } } }"
  BUGBOT_DESCRIPTION_VERSION_JSON="$REPLY_JSON"
  BUGBOT_DESCRIPTION_AT_REVIEW="$(printf '%s' "$BUGBOT_DESCRIPTION_VERSION_JSON" | jq -r '
    if (.data.note.systemNoteMetadata.descriptionVersion.description | type) == "string"
    then .data.note.systemNoteMetadata.descriptionVersion.description else empty end' 2>/dev/null)"
  if [ -z "$BUGBOT_DESCRIPTION_AT_REVIEW" ]; then BUGBOT_DESCRIPTION_VERSION_READABLE=false; fi
fi
BUGBOT_DESCRIPTION_SHA="$(printf '%s' "$BUGBOT_DESCRIPTION_AT_REVIEW" | jq -Rsr '
  try (
    capture("<!-- CURSOR_SUMMARY -->(?<summary>[\\s\\S]*?)<!-- /CURSOR_SUMMARY -->").summary
    | capture("Reviewed by \\[Cursor Bugbot\\][^\\n]*for commit (?<sha>[0-9a-f]{40})").sha
  ) catch ""' 2>/dev/null)"
BUGBOT_DESCRIPTION_TRUSTED=false
if [ -n "$BUGBOT_DESCRIPTION_CHANGED_AT" ] && [ -n "$BUGBOT_DESCRIPTION_SHA" ]; then
  BUGBOT_DESCRIPTION_TRUSTED=true
fi
BUGBOT_CLEAN_AWARD_AT=""
BUGBOT_AWARDS_READABLE=true
if [ "$BUGBOT_DESCRIPTION_TRUSTED" = true ] && [ "$BUGBOT_DESCRIPTION_SHA" = "$HEAD_SHA" ] \
  && [ "$BUGBOT_NOTE_SHA" != "$HEAD_SHA" ]; then
  read_awards_once
  [ "$AWARDS_READABLE" = true ] || BUGBOT_AWARDS_READABLE=false
  BUGBOT_CLEAN_AWARD_AT="$(printf '%s' "$AWARDS_JSON" | jq -r \
    --argjson bid "$BUGBOT_GITLAB_USER_ID" --arg after "$BUGBOT_DESCRIPTION_CHANGED_AT" '
      def epoch: try (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) catch 0;
      if type=="array" and $after != "" then
        [ .[]
          | select(.user.id == $bid and .name == "white_check_mark")
          # GitLab can persist the award seconds before its description note in one transaction.
          | select((.created_at // "") as $at
            | ($at | epoch) as $at_epoch | ($after | epoch) as $after_epoch
            | $at >= $after or ($at_epoch > 0 and $after_epoch > 0 and $at_epoch >= $after_epoch - 5))
          | (.created_at // "")
        ] | sort | (last // "")
      else "" end' 2>/dev/null)"
fi
BUGBOT_SHA="$BUGBOT_NOTE_SHA"
BUGBOT_SOURCE=note
if [ -n "$BUGBOT_CLEAN_AWARD_AT" ]; then
  BUGBOT_SHA="$BUGBOT_DESCRIPTION_SHA"
  BUGBOT_SOURCE=clean_award
fi
BUGBOT_WAIT_SECONDS=unknown
PIPE_EPOCH="$(date -u -d "$PIPE_CREATED" +%s 2>/dev/null || date -u -jf '%Y-%m-%dT%H:%M:%S' "${PIPE_CREATED%%.*}" +%s 2>/dev/null || echo 0)"
NOW_EPOCH="$(date -u +%s 2>/dev/null || echo 0)"
case "$PIPE_EPOCH:$NOW_EPOCH" in *[!0-9:]*) PIPE_EPOCH=0; NOW_EPOCH=0 ;; esac
if [ "$PIPE_EPOCH" -gt 0 ] 2>/dev/null && [ "$NOW_EPOCH" -ge "$PIPE_EPOCH" ] 2>/dev/null; then
  BUGBOT_WAIT_SECONDS=$(( NOW_EPOCH - PIPE_EPOCH ))
fi
if [ "$BUGBOT_GITLAB_USER_ID" -eq 0 ]; then
  BUGBOT_WAIT_SECONDS=0
  emit bugbot_reviewed_exact_head true; emit bugbot_reviewed_exact_head_detail not_required
elif [ -n "$BUGBOT_SHA" ] && [ "$BUGBOT_SHA" = "$HEAD_SHA" ]; then
  BUGBOT_WAIT_SECONDS=0
  emit bugbot_reviewed_exact_head true; emit bugbot_reviewed_exact_head_detail "reviewed:$BUGBOT_SOURCE"
elif [ -z "$NOTES_JSON" ]; then
  emit bugbot_reviewed_exact_head false; emit bugbot_reviewed_exact_head_detail unreadable
else
  emit bugbot_reviewed_exact_head false
  if [ "$BUGBOT_AWARDS_READABLE" = false ]; then
    emit bugbot_reviewed_exact_head_detail unreadable
  elif [ -n "$BUGBOT_SHA" ]; then
    emit bugbot_reviewed_exact_head_detail "stale:${BUGBOT_SHA:0:11}"
  elif [ "$BUGBOT_DESCRIPTION_VERSION_READABLE" = false ]; then
    emit bugbot_reviewed_exact_head_detail unreadable
  elif [ "$BUGBOT_DESCRIPTION_TRUSTED" = true ] && [ "$BUGBOT_DESCRIPTION_SHA" != "$HEAD_SHA" ]; then
    emit bugbot_reviewed_exact_head_detail "stale:${BUGBOT_DESCRIPTION_SHA:0:11}"
  else
    emit bugbot_reviewed_exact_head_detail "awaiting:${BUGBOT_WAIT_SECONDS}s"
  fi
fi
emit bugbot_wait_seconds "$BUGBOT_WAIT_SECONDS"
emit bugbot_note_sha "${BUGBOT_NOTE_SHA:-none}"
emit bugbot_description_sha "${BUGBOT_DESCRIPTION_SHA:-none}"
emit bugbot_description_note_id "${BUGBOT_DESCRIPTION_NOTE_ID:-0}"
emit bugbot_description_changed_at "${BUGBOT_DESCRIPTION_CHANGED_AT:-none}"
emit bugbot_description_version_readable "$BUGBOT_DESCRIPTION_VERSION_READABLE"
emit bugbot_clean_award_at "${BUGBOT_CLEAN_AWARD_AT:-none}"
emit bugbot_awards_readable "$BUGBOT_AWARDS_READABLE"

# A manual recovery request is trusted only when the same authenticated GitLab actor running Ship
# posted the exact command and full current head. The remote note makes sequential retries durable.
BUGBOT_NUDGE_BODY="$(printf 'cursor review verbose=true\n\n<!-- factory-bugbot-nudge:%s -->' "$HEAD_SHA")"
BUGBOT_NUDGE_NOTE="$(printf '%s' "$NOTES_JSON" | jq -c --argjson fid "$FACTORY_GITLAB_USER_ID" \
  --arg body "$BUGBOT_NUDGE_BODY" '
  if type=="array" and $fid > 0 then
    [ .[]
      | select((.system // false) == false)
      | select((.author.id // 0) == $fid)
      | select((.body // "") == $body)
    ] | sort_by([(.created_at // ""), (.id // 0)]) | (last // {})
  else {} end' 2>/dev/null)"
BUGBOT_NUDGE_NOTE_ID="$(printf '%s' "$BUGBOT_NUDGE_NOTE" | jq -r '.id // 0' 2>/dev/null)"
BUGBOT_NUDGE_CREATED_AT="$(printf '%s' "$BUGBOT_NUDGE_NOTE" | jq -r '.created_at // ""' 2>/dev/null)"
case "$BUGBOT_NUDGE_NOTE_ID" in ''|*[!0-9]*) BUGBOT_NUDGE_NOTE_ID=0 ;; esac
if [ "$BUGBOT_NUDGE_NOTE_ID" -gt 0 ]; then
  BUGBOT_NUDGED_EXACT_HEAD=true
else
  BUGBOT_NUDGED_EXACT_HEAD=false
fi
BUGBOT_REQUEST_ID="$(printf '%s' "$NOTES_JSON" | jq -r --argjson bid "$BUGBOT_GITLAB_USER_ID" \
  --argjson nudge_id "$BUGBOT_NUDGE_NOTE_ID" --arg nudge_at "$BUGBOT_NUDGE_CREATED_AT" '
  def request_id:
    try capture("^[[:space:]]*Bugbot request id: (?<id>serverGenReqId_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})[[:space:]]*$").id catch "";
  if type=="array" and $nudge_id > 0 and $nudge_at != "" then
    [ .[]
      | select((.author.id // 0) == $bid)
      | select([(.created_at // ""), (.id // 0)] > [$nudge_at, $nudge_id])
      | ((.body // "") | request_id)
      | select(length > 0)
    ] | first // ""
  else "" end' 2>/dev/null)"
emit bugbot_nudged_exact_head "$BUGBOT_NUDGED_EXACT_HEAD"
emit bugbot_nudge_note_id "$([ "$BUGBOT_NUDGE_NOTE_ID" -gt 0 ] && printf '%s' "$BUGBOT_NUDGE_NOTE_ID" || printf none)"
emit bugbot_nudge_created_at "${BUGBOT_NUDGE_CREATED_AT:-none}"
emit bugbot_request_id "${BUGBOT_REQUEST_ID:-none}"
BUGBOT_NUDGE_AFTER_SECONDS="${IO_BUGBOT_NUDGE_AFTER_SECONDS:-3600}"
case "$BUGBOT_NUDGE_AFTER_SECONDS" in ''|*[!0-9]*) BUGBOT_NUDGE_AFTER_SECONDS=3600 ;; esac
BUGBOT_NUDGE_ELIGIBLE=false
case "$BUGBOT_WAIT_SECONDS" in
  ''|*[!0-9]*) ;;
  *)
    if [ "$MR_STATE" = opened ] && [ "$MR_SHA" = "$HEAD_SHA" ] \
      && [ "$BUGBOT_WAIT_SECONDS" -ge "$BUGBOT_NUDGE_AFTER_SECONDS" ] \
      && [ "$BUGBOT_NUDGED_EXACT_HEAD" = false ] && [ "$FACTORY_GITLAB_USER_ID" -gt 0 ] \
      && [ "$BUGBOT_GITLAB_USER_ID" -gt 0 ] \
      && { [ -z "$BUGBOT_SHA" ] || [ "$BUGBOT_SHA" != "$HEAD_SHA" ]; } \
      && [ "$BUGBOT_AWARDS_READABLE" = true ] \
      && [ -n "$NOTES_JSON" ]; then
      BUGBOT_NUDGE_ELIGIBLE=true
    fi ;;
esac

# ── ledger_clean (mechanical half only) ───────────────────────────────────────────────────────
# This mechanical ledger lists open threads; a burst adjudicates the evidence in their replies.
# GitLab system activity, the Linear linkback, and deploy-preview status are not review findings.
# Resolution or an author strikethrough marks a thread handled.
read_shim mr-discussions "$MR_IID"; DISC_JSON="$REPLY_JSON"
if [ -z "$DISC_JSON" ]; then
  emit ledger_clean false; emit ledger_clean_detail unreadable; emit open_threads unknown; emit open_notes unknown
else
  # The discussion is bound to $d before any sub-filter runs: `[ … ] | length < ( … )` would
  # rebind `.` to the array on the right-hand side, and `.notes` on an array is a jq error that
  # silently degrades every read to "unreadable".
  OPEN_THREADS="$(printf '%s' "$DISC_JSON" | jq -r --argjson bid "$BUGBOT_GITLAB_USER_ID" --argjson preview "$DEPLOY_PREVIEW_GITLAB_USER_ID" \
    --argjson fid "$FACTORY_GITLAB_USER_ID" '
    def deploy_preview_status:
      ((.author.id // 0) == $preview)
      and ((.body // "") | startswith("🚀 Deploy preview is ready!"));
    def factory_bugbot_nudge:
      $fid > 0 and ((.author.id // 0) == $fid)
      and ((.body // "") | test("^cursor review verbose=true[\\r]?\\n[\\r]?\\n<!-- factory-bugbot-nudge:[0-9a-f]{40} -->[[:space:]]*$"));
    def bugbot_request_status:
      ((.author.id // 0) == $bid)
      and ((.body // "") | test("^[[:space:]]*Bugbot request id: serverGenReqId_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}[[:space:]]*$"));
    def trusted_factory: $fid > 0 and ((.author.id // 0) == $fid);
    def factory_operational:
      trusted_factory and ((.body // "") | test("(^|[\\r\\n])<!-- factory-operational:(conflict-audit|steering-summary|comment-disposition) -->[[:space:]]*$"));
    def factory_address_note:
      trusted_factory and ((.body // "") | test("(^|[\\r\\n])<!-- factory-addressed:[0-9]+ -->[[:space:]]*$"));
    def factory_address_discussion:
      trusted_factory and ((.body // "") | test("(^|[\\r\\n])<!-- factory-addressed-discussion:[A-Za-z0-9._:-]+ -->[[:space:]]*$"));
    def thread_feedback:
      ((.system // false) == false)
      and (((.body // "") | startswith("<!-- linear-linkback -->")) | not)
      # Cursor puts this in the MR description on GitLab and in a comment on GitHub; it is a risk blurb, never a finding.
      and (((.body // "") | contains("<!-- CURSOR_SUMMARY -->")) | not)
      and (((.body // "") | contains("factory-bugbot-request:")) | not)
      and (factory_operational | not)
      and (factory_address_note | not)
      and (factory_address_discussion | not)
      and (factory_bugbot_nudge | not)
      and (bugbot_request_status | not)
      and (deploy_preview_status | not)
      and (((((.author.id // 0) == $bid) and ((.body // "") | test("for commit [0-9a-f]{40}")))) | not);
    if type=="array" then
      [ .[]
        | select(.individual_note == false)
        | . as $d
        | ([ $d.notes[]? | select(thread_feedback) ]) as $feedback
        | select(($feedback | length) > 0)
        | ([ $feedback[] | select(.resolvable == true) ]) as $r
        | select((($d.notes[-1].body) // "") | test("^[[:space:]]*~~[\\s\\S]*~~[[:space:]]*$") | not)
        | select((
            (([ $r[] | select(.resolved == true) ] | length) == ($r | length))
            and (
              (($r | length) == ($feedback | length))
              or any($d.notes[]?; trusted_factory and ((.body // "") | test("(^|[\\r\\n])<!-- factory-addressed-discussion:\($d.id) -->[[:space:]]*$")))
            )
          ) | not)
      ] | length
    else "unknown" end' 2>/dev/null)"
  TOP_OPEN="$(printf '%s' "$NOTES_JSON" | jq -r --argjson bid "$BUGBOT_GITLAB_USER_ID" --argjson preview "$DEPLOY_PREVIEW_GITLAB_USER_ID" \
    --argjson fid "$FACTORY_GITLAB_USER_ID" '
    def deploy_preview_status:
      ((.author.id // 0) == $preview)
      and ((.body // "") | startswith("🚀 Deploy preview is ready!"));
    def factory_bugbot_nudge:
      $fid > 0 and ((.author.id // 0) == $fid)
      and ((.body // "") | test("^cursor review verbose=true[\\r]?\\n[\\r]?\\n<!-- factory-bugbot-nudge:[0-9a-f]{40} -->[[:space:]]*$"));
    def bugbot_request_status:
      ((.author.id // 0) == $bid)
      and ((.body // "") | test("^[[:space:]]*Bugbot request id: serverGenReqId_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}[[:space:]]*$"));
    def trusted_factory: $fid > 0 and ((.author.id // 0) == $fid);
    def factory_operational:
      trusted_factory and ((.body // "") | test("(^|[\\r\\n])<!-- factory-operational:(conflict-audit|steering-summary|comment-disposition) -->[[:space:]]*$"));
    def factory_address_note:
      trusted_factory and ((.body // "") | test("(^|[\\r\\n])<!-- factory-addressed:[0-9]+ -->[[:space:]]*$"));
    def factory_address_discussion:
      trusted_factory and ((.body // "") | test("(^|[\\r\\n])<!-- factory-addressed-discussion:[A-Za-z0-9._:-]+ -->[[:space:]]*$"));
    if type=="array" then
      ([ .[] | select(trusted_factory) | .body // ""
        | capture("(^|[\\r\\n])<!-- factory-addressed:(?<id>[0-9]+) -->[[:space:]]*$")? | .id ]
        | map(select(. != null))) as $handled |
      [ .[]
        | select((.system // false) == false)
        | select((((.author.id // 0) == $bid) and ((.body // "") | test("for commit [0-9a-f]{40}"))) | not)
        | select(deploy_preview_status | not)
        | select((.type // null) == null)
        | select(((.body // "") | startswith("<!-- linear-linkback -->")) | not)
        | select(((.body // "") | contains("<!-- CURSOR_SUMMARY -->")) | not)
        | select(((.body // "") | contains("factory-bugbot-request:")) | not)
        | select(factory_operational | not)
        | select(factory_address_note | not)
        | select(factory_address_discussion | not)
        | select(factory_bugbot_nudge | not)
        | select(bugbot_request_status | not)
        | select((.id | tostring) as $id | ($handled | index($id)) == null)
      ] | length
    else "unknown" end' 2>/dev/null)"
  if [ "$OPEN_THREADS" = "unknown" ] || [ -z "$OPEN_THREADS" ] || [ "$TOP_OPEN" = "unknown" ] || [ -z "$TOP_OPEN" ]; then
    emit ledger_clean false; emit ledger_clean_detail unreadable; emit open_threads unknown; emit open_notes unknown
  elif [ "$OPEN_THREADS" -eq 0 ] && [ "$TOP_OPEN" -eq 0 ]; then
    emit ledger_clean true; emit ledger_clean_detail no_open_comments; emit open_threads 0; emit open_notes 0
  else
    emit ledger_clean false; emit ledger_clean_detail needs_adjudication; emit open_threads "$OPEN_THREADS"; emit open_notes "$TOP_OPEN"
  fi
fi

# ── foreman_review_pending ────────────────────────────────────────────────────────────────────
# Every foreman condition carries the same marker, so only a thread at or after the 👀 ($1, empty = any) is this review landing.
foreman_review_landed() {
  printf '%s' "$DISC_JSON" | jq -e --argjson qid "$FOREMAN_GITLAB_USER_ID" --arg since "$1" '
    type=="array" and any(.[]?;
      (((.notes // [])[0]) // {}) as $top
      | (((($top.body) // "") | contains("<!-- FOREMAN -->")) or ((($top.author.id) // 0) == $qid))
      and ($since == "" or ((($top.created_at) // "") | . == "" or . >= $since)))' >/dev/null 2>&1
}

FOREMAN_REVIEW_PENDING=false
FOREMAN_REVIEW_DETAIL=no_marker
FOREMAN_AWARD_AT=""
# The foreman awards its 👀/✅ on GitLab merge requests only, so the marker has no GitHub counterpart.
if [ "$FOREMAN_GITLAB_USER_ID" -eq 0 ] || [ "$FORGE_NAME" = github ]; then
  FOREMAN_REVIEW_DETAIL=no_marker
elif [ -z "$DISC_JSON" ]; then
  FOREMAN_REVIEW_DETAIL=unreadable
else
  # Save/restore is load-bearing: an award-only fault must not flip vector_readable, or an absent foreman would newly send the loop to a blocking state where today there is none.
  FOREMAN_PREV_AUTH="$AUTH_FAILED"
  FOREMAN_PREV_READ="$READ_FAILED"
  read_awards_once
  AUTH_FAILED="$FOREMAN_PREV_AUTH"
  READ_FAILED="$FOREMAN_PREV_READ"
  if [ "$AWARDS_READABLE" != true ]; then
    FOREMAN_REVIEW_DETAIL=unreadable
  else
    FOREMAN_AWARD_STATE="$(printf '%s' "$AWARDS_JSON" | jq -r --argjson qid "$FOREMAN_GITLAB_USER_ID" '
      # A checkmark is permanent while eyes is re-awarded per review, so rank by time; a tied, missing or unparseable timestamp keeps the checkmark-wins bias.
      def epoch: try (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) catch 0;
      if type=="array" then
        ([ .[]? | select(((.user.id) // 0) == $qid) ]) as $mine
        | ([ $mine[] | select(((.name) // "") == "white_check_mark") ]) as $done
        | ([ $mine[] | select(((.name) // "") == "eyes") ]) as $eyes
        | ([ $eyes[] | ((.created_at) // "") ] | sort | (last // "")) as $eyes_at
        | ([ $done[] | ((.created_at) // "") ] | sort | (last // "")) as $done_at
        | if ($done | length) > 0 then
            (if ($eyes | length) > 0
                and (($eyes_at | epoch) > 0) and (($done_at | epoch) > 0)
                and (($eyes_at | epoch) > ($done_at | epoch))
             then "eyes|" + $eyes_at else "done|" end)
          elif ($eyes | length) > 0 then "eyes|" + $eyes_at
          else "none|" end
      else "none|" end' 2>/dev/null)"
    case "$FOREMAN_AWARD_STATE" in
      done*)
        FOREMAN_REVIEW_DETAIL=reviewed_clean ;;
      eyes*)
        FOREMAN_AWARD_AT="${FOREMAN_AWARD_STATE#eyes|}"
        if foreman_review_landed "$FOREMAN_AWARD_AT"; then
          FOREMAN_REVIEW_DETAIL=reviewed
        else
          FOREMAN_REVIEW_PENDING=true
          FOREMAN_REVIEW_DETAIL="composing_since:${FOREMAN_AWARD_AT:-unknown}"
        fi ;;
      *)
        if foreman_review_landed ""; then
          FOREMAN_REVIEW_DETAIL=reviewed
        else
          FOREMAN_REVIEW_DETAIL=no_marker
        fi ;;
    esac
  fi
fi
emit foreman_review_pending "$FOREMAN_REVIEW_PENDING"
emit foreman_review_pending_detail "$FOREMAN_REVIEW_DETAIL"
emit foreman_award_at "${FOREMAN_AWARD_AT:-none}"

# The time threshold is only actionable once Bugbot is the active gate.
if [ "$PIPE_STATUS" != success ] || [ "${OPEN_THREADS:-unknown}" != 0 ] \
  || [ "${TOP_OPEN:-unknown}" != 0 ]; then
  BUGBOT_NUDGE_ELIGIBLE=false
fi
emit bugbot_nudge_eligible "$BUGBOT_NUDGE_ELIGIBLE"

# Stable mechanical fingerprint used by the controller's final read. Bodies are intentionally
# excluded: IDs, update timestamps, and resolution state detect late comments without logging
# attacker-controlled text.
COMMENT_STATE="$(printf '%s\n%s\n' "$NOTES_JSON" "$DISC_JSON" | jq -cs \
  --argjson bid "$BUGBOT_GITLAB_USER_ID" --argjson preview "$DEPLOY_PREVIEW_GITLAB_USER_ID" \
  --argjson fid "$FACTORY_GITLAB_USER_ID" '
  def deploy_preview_status:
    ((.author.id // 0) == $preview)
    and ((.body // "") | startswith("🚀 Deploy preview is ready!"));
  def factory_bugbot_nudge:
    $fid > 0 and ((.author.id // 0) == $fid)
    and ((.body // "") | test("^cursor review verbose=true[\\r]?\\n[\\r]?\\n<!-- factory-bugbot-nudge:[0-9a-f]{40} -->[[:space:]]*$"));
  def bugbot_request_status:
    ((.author.id // 0) == $bid)
    and ((.body // "") | test("^[[:space:]]*Bugbot request id: serverGenReqId_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}[[:space:]]*$"));
  def trusted_factory: $fid > 0 and ((.author.id // 0) == $fid);
  def factory_operational:
    trusted_factory and ((.body // "") | test("(^|[\\r\\n])<!-- factory-operational:(conflict-audit|steering-summary|comment-disposition) -->[[:space:]]*$"));
  def factory_address_note:
    trusted_factory and ((.body // "") | test("(^|[\\r\\n])<!-- factory-addressed:[0-9]+ -->[[:space:]]*$"));
  def factory_address_discussion:
    trusted_factory and ((.body // "") | test("(^|[\\r\\n])<!-- factory-addressed-discussion:[A-Za-z0-9._:-]+ -->[[:space:]]*$"));
  def base_actionable:
    ((.system // false) == false)
    and (((.body // "") | startswith("<!-- linear-linkback -->")) | not)
    and (((.body // "") | contains("<!-- CURSOR_SUMMARY -->")) | not)
    and (((.body // "") | contains("factory-bugbot-request:")) | not)
    and (factory_operational | not)
    and (factory_address_note | not)
    and (factory_address_discussion | not)
    and (factory_bugbot_nudge | not)
    and (bugbot_request_status | not)
    and (deploy_preview_status | not)
    and (((((.author.id // 0) == $bid) and ((.body // "") | test("for commit [0-9a-f]{40}")))) | not);
  def top_actionable: base_actionable and ((.type // null) == null);
  (.[0] // [] | map(select(top_actionable) | [.id, .updated_at]) | sort_by(.[0])) as $notes |
  (.[1] // []
    | map(select(.individual_note == false)
      | (.notes // [] | map(select(base_actionable) | [.id, .updated_at, .resolved]) | sort_by(.[0])) as $feedback
      | select(($feedback | length) > 0)
      | [.id, $feedback])
    | sort_by(.[0])) as $threads |
  [$notes, $threads]' 2>/dev/null)"
COMMENT_FINGERPRINT="$(printf '%s' "$COMMENT_STATE" | cksum | awk '{print $1 ":" $2}')"
emit comment_fingerprint "${COMMENT_FINGERPRINT:-unreadable}"
STATE_FINGERPRINT="$(printf '%s|%s|%s|%s|%s|%s' "$HEAD_SHA" "$PIPE_ID" "$PIPE_STATUS" "$BUGBOT_SHA" "$COMMENT_FINGERPRINT" "$DESCRIPTION_FINGERPRINT" | cksum | awk '{print $1 ":" $2}')"
emit state_fingerprint "${STATE_FINGERPRINT:-unreadable}"

# ── acceptance_drift_clean ────────────────────────────────────────────────────────────────────
# Deliberately not read here: it compares the diff against the on-disk acceptance artifacts and
# is a judgment call, so it belongs to a burst. Emitted as unknown so a caller that forgets to
# ask for it cannot mistake silence for a pass.
emit acceptance_drift_clean unknown
emit acceptance_drift_clean_detail burst_owned

# An auth failure that survived a refresh is an INFRASTRUCTURE problem, not a verdict about the
# MR. The caller escalates on this rather than reporting a healthy MR as unready.
if [ "$AUTH_FAILED" -eq 1 ]; then
  emit vector_readable false
  emit vector_error "${FORGE_NAME}_auth_expired"
elif [ "$READ_FAILED" -eq 1 ]; then
  emit vector_readable false
  emit vector_error "${FORGE_NAME}_read_failed"
else
  emit vector_readable true
fi
exit 0
