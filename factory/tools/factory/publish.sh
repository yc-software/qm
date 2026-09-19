#!/bin/bash
# Defaults must stay byte-identical to the forge literals in work-ticket-build-and-ship.js.
set -u

usage() {
  echo "usage: publish.sh <push-options <title> [label...]|assets-push <branch> <dir>|lookup <uri-encoded-branch>|lookup-captured <uri-encoded-branch>|mr-show <id>|mr-show-captured <id>|commit-show <sha>|note-create <id>|mr-diffs <id>|mr-awards <id>|mr-pipelines <id>|mr-notes <id>|mr-discussions <id>>; every subcommand emits a command to run; IO_PUBLISH_FORGE=gitlab|github selects the forge" >&2
  exit 2
}

# Emitted text is eval'd by the caller, so every interpolated value is single-quoted.
sq() { local v=${1//\'/\'\\\'\'}; printf "'%s'" "$v"; }
emit_api() { printf '%s\n' "io_glab_with_gitlab_refresh api $(sq "$1") | jq -c $(sq "$2")"; }

# Emits STATEMENTS, never a value: an `X=$(eval …)` capture would lose the read's rc-78 escalation.
emit_json_api() { # usage: <pre-argv> <endpoint> <post-argv> <jq map>; sets IO_PUBLISH_JSON/IO_PUBLISH_RC
  local pre="${1:+ $1}" post="${3:+ $3}"
  printf '%s\n' 'IO_PUBLISH_RC=0'
  printf '%s\n' 'IO_PUBLISH_JSON="$(io_glab_json_with_refresh "${IO_CONVERGE_GLAB_TIMEOUT:-30}" api'"$pre"' '"$(sq "$2")$post"')" || IO_PUBLISH_RC=$?'
  # The wrapper prints the forge's 401 body too: unblanked, a failed read would map to a real object.
  printf '%s\n' '[ "$IO_PUBLISH_RC" -eq 0 ] || IO_PUBLISH_JSON=""'
  # jq exits 2 on a garbled body; without the `||` an errexit caller dies before reading the rc.
  printf '%s\n' "IO_PUBLISH_JSON=\"\$(printf '%s' \"\$IO_PUBLISH_JSON\" | jq -c $(sq "$4") 2>/dev/null)\" || IO_PUBLISH_JSON=\"\""
}

# GitLab's --paginate prints one JSON array per page, which is not one parseable JSON document.
# Merge pages explicitly so callers can keep using the same fail-closed JSON checks.
emit_json_pages() { # usage: <endpoint ending in "page="> <jq map> [github url ending in "page="]; sets IO_PUBLISH_JSON/IO_PUBLISH_RC
  # No GitHub url means the read has no GitHub equivalent yet; exit 2 so read_shim escalates
  # rather than pointing a GitLab endpoint at a repo that does not serve it.
  [ "$forge" != github ] || [ -n "${3:-}" ] || usage
  # Quoted heredoc: unquoted, $IO_PUBLISH_JSON would expand here and `set -u` would abort the shim.
  cat <<'IO_PUB_PAGES_HEAD'
IO_PUBLISH_RC=0
IO_PUBLISH_JSON=''
io_pub_acc='[]'
io_pub_page=1
io_pub_rc=0
io_pub_body=''
io_pub_entries=''
io_pub_count=''
while [ "$io_pub_page" -le 100 ]; do
  io_pub_rc=0
IO_PUB_PAGES_HEAD
  if [ "$forge" = github ]; then
    emit_gh_read "$3" io_pub_body io_pub_rc '"$io_pub_page"' '  ' '' '"$io_pub_page"'
    printf '%s\n' '  [ "$io_pub_rc" -eq 0 ] || io_pub_body=""'
  else
    printf '%s\n' '  io_pub_body="$(io_glab_json_with_refresh "${IO_CONVERGE_GLAB_TIMEOUT:-30}" api '"$(sq "$1")"'"$io_pub_page")" || io_pub_rc=$?'
  fi
  printf '%s\n' '  if [ "$io_pub_rc" -ne 0 ]; then IO_PUBLISH_RC="$io_pub_rc"; break; fi'
  printf '%s\n' "  io_pub_entries=\"\$(printf '%s' \"\$io_pub_body\" | jq -c $(sq "$2") 2>/dev/null)\" || io_pub_entries=''"
  cat <<'IO_PUB_PAGES_TAIL'
  if [ -z "$io_pub_entries" ]; then IO_PUBLISH_RC=79; break; fi
  io_pub_count="$(printf '%s' "$io_pub_entries" | jq -r 'length' 2>/dev/null)" || io_pub_count=''
  case "$io_pub_count" in ''|*[!0-9]*) io_pub_count='' ;; esac
  if [ -z "$io_pub_count" ]; then IO_PUBLISH_RC=79; break; fi
  io_pub_acc="$(printf '%s\n%s\n' "$io_pub_acc" "$io_pub_entries" | jq -cs 'add' 2>/dev/null)" || io_pub_acc=''
  if [ -z "$io_pub_acc" ]; then IO_PUBLISH_RC=79; break; fi
  if [ "$io_pub_count" -lt 100 ]; then IO_PUBLISH_JSON="$io_pub_acc"; break; fi
  io_pub_page=$((io_pub_page + 1))
done
[ "$io_pub_page" -le 100 ] || IO_PUBLISH_RC=77
IO_PUB_PAGES_TAIL
}

# GraphQL alone exposes a thread's resolved flag, and it pages by cursor, not by page number.
emit_gh_graphql_pages() { # usage: <pr number> <graphql query> <jq map>; sets IO_PUBLISH_JSON/IO_PUBLISH_RC
  # The whole document re-runs per thread page, so a selection that must not fold twice is gated to the first one.
  local envelope='{query: $q, variables: {owner: $owner, name: $name, number: $number, cursor: (if $cursor == "" then null else $cursor end), firstPage: ($cursor == "")}}'
  cat <<'IO_PUB_GQL_HEAD'
IO_PUBLISH_RC=0
IO_PUBLISH_JSON=''
io_pub_acc='[]'
io_pub_page=1
io_pub_rc=0
io_pub_body=''
io_pub_entries=''
io_pub_cursor=''
io_pub_next=''
io_pub_gql_body=''
while [ "$io_pub_page" -le 100 ]; do
  io_pub_rc=0
IO_PUB_GQL_HEAD
  printf '%s\n' "  io_pub_gql_body=\"\$(jq -n --arg q $(sq "$2") --arg owner $(sq "$gh_owner") --arg name $(sq "$gh_repo") --argjson number $(sq "$1") --arg cursor \"\$io_pub_cursor\" $(sq "$envelope") 2>/dev/null)\" || io_pub_gql_body=''"
  printf '%s\n' '  if [ -z "$io_pub_gql_body" ]; then IO_PUBLISH_RC=79; break; fi'
  emit_gh_read 'https://api.github.com/graphql' io_pub_body io_pub_rc ' --data "$io_pub_gql_body"' '  '
  cat <<'IO_PUB_GQL_MID'
  [ "$io_pub_rc" -eq 0 ] || io_pub_body=""
  if [ "$io_pub_rc" -ne 0 ]; then IO_PUBLISH_RC="$io_pub_rc"; break; fi
IO_PUB_GQL_MID
  # A failed GraphQL query answers 200; unchecked, it would read as an empty, clean thread list.
  printf '%s\n' '  if printf '"'"'%s'"'"' "$io_pub_body" | jq -e '"'"'type=="object" and has("errors")'"'"' >/dev/null 2>&1; then IO_PUBLISH_RC=79; break; fi'
  printf '%s\n' '  if printf '"'"'%s'"'"' "$io_pub_body" | jq -e '"'"'.data.repository.pullRequest.latestOpinionatedReviews.pageInfo.hasNextPage == true'"'"' >/dev/null 2>&1; then IO_PUBLISH_RC=79; break; fi'
  printf '%s\n' '  if printf '"'"'%s'"'"' "$io_pub_body" | jq -e '"'"'any((.data.repository.pullRequest.reviewThreads.nodes // [])[]; .comments.pageInfo.hasNextPage == true)'"'"' >/dev/null 2>&1; then IO_PUBLISH_RC=79; break; fi'
  printf '%s\n' "  io_pub_entries=\"\$(printf '%s' \"\$io_pub_body\" | jq -c $(sq "$3") 2>/dev/null)\" || io_pub_entries=''"
  cat <<'IO_PUB_GQL_TAIL'
  if [ -z "$io_pub_entries" ]; then IO_PUBLISH_RC=79; break; fi
  io_pub_acc="$(printf '%s\n%s\n' "$io_pub_acc" "$io_pub_entries" | jq -cs 'add' 2>/dev/null)" || io_pub_acc=''
  if [ -z "$io_pub_acc" ]; then IO_PUBLISH_RC=79; break; fi
  io_pub_next="$(printf '%s' "$io_pub_body" | jq -r 'if (.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage|type) != "boolean" then "" elif .data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage == true then "more" else "done" end' 2>/dev/null)" || io_pub_next=''
  if [ -z "$io_pub_next" ]; then IO_PUBLISH_RC=79; break; fi
  if [ "$io_pub_next" != more ]; then IO_PUBLISH_JSON="$io_pub_acc"; break; fi
  io_pub_cursor="$(printf '%s' "$io_pub_body" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // ""' 2>/dev/null)" || io_pub_cursor=''
  if [ -z "$io_pub_cursor" ]; then IO_PUBLISH_RC=79; break; fi
  io_pub_page=$((io_pub_page + 1))
done
[ "$io_pub_page" -le 100 ] || IO_PUBLISH_RC=77
IO_PUB_GQL_TAIL
}

if [ -z "${IO_PUBLISH_PROJECT:-}" ]; then
  echo "publish.sh: IO_PUBLISH_PROJECT is not set; refusing to guess the publish project" >&2
  exit 1
fi
project="$IO_PUBLISH_PROJECT"
lookup_map='[.[] | {id: .iid, branch: .source_branch, sha: .sha, description: (.description // "")}]'
# Shared by both forges: io-coding-agent-js.sh reads `.id` back off this shape.
note_map='if type=="object" then {id: (.id // 0)} else empty end'

forge="${IO_PUBLISH_FORGE:-gitlab}"
gh_project="${IO_PUBLISH_PROJECT:-}"
gh_owner="${gh_project%%/*}"
gh_repo="${gh_project#*/}"
gh_base="https://api.github.com/repos/$gh_project"
# `${IO_GITHUB_TOKEN:-}`, not `$IO_GITHUB_TOKEN`: read_shim evals this text under `set -u`.
gh_curl='curl -sS --max-time "${IO_CONVERGE_GLAB_TIMEOUT:-30}" --config - -H "Accept: application/vnd.github+json"'
# The token rides curl's stdin config, never argv, so `ps` on a shared runner cannot read it.
gh_auth='<<< "header = \"Authorization: Bearer ${IO_GITHUB_TOKEN:-}\""'
gh_post_argv=' -X POST -H "Content-Type: application/json"'
# stdin already carries the token, so the body rides the same config to stay off argv too.
gh_post_cfg='<<IO_PUB_CFG
header = "Authorization: Bearer ${IO_GITHUB_TOKEN:-}"
data = "@$io_pub_body_file"
IO_PUB_CFG
'
gh_lookup_map='[.[] | {id: .number, branch: .head.ref, sha: .head.sha, description: (.body // "")}]'
# A merged PR reports state "closed", so the raw value would report every landed MR as human-closed.
gh_state='if (.merged == true) or (.merged_at != null) then "merged" elif .state == "open" then "opened" else "closed" end'
# GitHub computes mergeability asynchronously, so null/unknown takes converge-vector's wait arm.
# `blocked` also covers a failing required check and an unmet protection rule; passing it through
# would reach converge-vector's mergeable-true arm and go green on a PR GitHub refuses to merge.
gh_merge_status='if .draft == true then "draft_status" elif (.mergeable == null) or ((.mergeable_state // "unknown") == "unknown") then "checking" elif .mergeable == false then "conflict" elif (.mergeable_state // "") == "blocked" then "discussions_not_resolved" else (.mergeable_state // "") end'
gh_awards_map='if type=="array" then [.[] | {name: .content, created_at, user: {id: .user.id}}] else empty end'
# Only top-level comments live here, so `type: null` is accurate for the ledger filter, not a default.
gh_notes_map='if type=="array" then [.[] | {id, body, system: false, type: null, created_at, updated_at, author: {id: .user.id}}] else empty end'
# Projecting .check_runs out of the wrapper object keeps the short-page terminator counting entries.
gh_check_runs_map='if type=="object" and (.check_runs|type)=="array" then [.check_runs[] | {id, status, conclusion, started_at, head_sha}] else empty end'
# GitLab hands the consumer one pipeline to read a status off, so every check-run folds into one entry.
# `startup_failure` is absent from REST's check-run enum but real in the check_run webhook schema, like `stale`.
# The pull ref re-resolves per page request, so a push landing mid-walk would fold two commits' runs onto the older sha.
gh_check_runs_agg='if length == 0 then [] elif ([.[].head_sha] | unique | length) > 1 then empty else [{id: ([.[].id] | max), status: (if any(.[]; .conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "action_required" or .conclusion == "stale" or .conclusion == "startup_failure") then "failed" elif any(.[]; .conclusion == "cancelled") then "canceled" elif any(.[]; .status != "completed") then "running" elif all(.[]; .conclusion == "success" or .conclusion == "skipped" or .conclusion == "neutral") then "success" else "failed" end), source: "github_check_runs", ref: "", sha: (.[0].head_sha), created_at: ([.[].started_at | select(. != null)] | min)}] end'
# `author` is the Actor interface, so a bare databaseId is a schema error served as 200 + .errors.
# latestOpinionatedReviews, not reviews: reviews keeps superseded CHANGES_REQUESTED nodes no write arm here can ever clear.
gh_threads_query='query($owner:String!,$name:String!,$number:Int!,$cursor:String,$firstPage:Boolean!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:100){pageInfo{hasNextPage} nodes{databaseId body createdAt updatedAt author{__typename ... on User{databaseId} ... on Bot{databaseId}}}}}} latestOpinionatedReviews(first:100)@include(if:$firstPage){pageInfo{hasNextPage} nodes{databaseId body state createdAt updatedAt author{__typename ... on User{databaseId} ... on Bot{databaseId}}}}}}}'
# GitHub resolves a whole thread where GitLab resolves each note, so isResolved flattens onto every comment.
# The lint spec forbids a // default on any consumer field, so the empty-body skip tests the type instead.
gh_threads_map='if type=="object" and (.data.repository.pullRequest.reviewThreads.nodes|type)=="array" then [.data.repository.pullRequest.reviewThreads.nodes[] | . as $t | {id, individual_note: false, notes: [(.comments.nodes // [])[] | {id: .databaseId, body, system: false, created_at: .createdAt, updated_at: .updatedAt, resolvable: true, resolved: $t.isResolved, author: {id: .author.databaseId}}]}] + [(.data.repository.pullRequest.latestOpinionatedReviews.nodes // [])[] | select((.body|type)=="string" and .body != "") | {id: "review:\(.databaseId)", individual_note: false, notes: [{id: .databaseId, body, system: false, created_at: .createdAt, updated_at: .updatedAt, resolvable: true, resolved: (.state != "CHANGES_REQUESTED"), author: {id: .author.databaseId}}]}] else empty end'

emit_gh_api() { # usage: <url> <jq flags> <jq map>
  printf '%s\n' "$gh_curl $(sq "$1") $gh_auth | jq $2 $(sq "$3")"
}

emit_gh_read() { # usage: <url> <json-var> <rc-var> [trailing-unquoted-expr] [indent] [stdin-config] [diag-url-suffix]
  local pad="${5:-}" auth="${6:-$gh_auth}"
  # A --max-time abort exits 28 with a partial body and no write-out line, so the capture must blank.
  printf '%s\n' "${pad}io_pub_raw=\"\$($gh_curl -w '\\n%{http_code} %header{x-ratelimit-remaining}' $(sq "$1")${4:-} $auth)\" || io_pub_raw=\"\""
  printf '%s\n' "${pad}io_pub_stat=\"\${io_pub_raw##*\$'\\n'}\""
  printf '%s\n' "${pad}io_pub_http=\"\${io_pub_stat%% *}\""
  printf '%s\n' "${pad}case \"\$io_pub_stat\" in *' '*) io_pub_rl=\"\${io_pub_stat#* }\" ;; *) io_pub_rl='' ;; esac"
  printf '%s\n' "${pad}$2=\"\${io_pub_raw%\$'\\n'*}\""
  # An exhausted primary rate limit answers 403 too, so escalating it as expired auth would send a human to rotate a healthy token.
  printf '%s\n' "${pad}case \"\$io_pub_http\" in 2??) $3=0 ;; 429) $3=77 ;; 403) if [ \"\$io_pub_rl\" = 0 ]; then $3=77; else $3=78; fi ;; 401) $3=78 ;; *) $3=79 ;; esac"
  # Absent, rejected and throttled tokens arrive as the same rc and the caller keeps only the rc, so the status has to ride fd 2.
  printf '%s\n' "${pad}if [ \"\$$3\" -ne 0 ]; then case \"\${IO_GITHUB_TOKEN:-}\" in '') io_pub_tok=absent ;; *) io_pub_tok=present ;; esac ; printf '[publish] github read failed http=%s rc=%s token=%s ratelimit=%s url=%s\\n' \"\${io_pub_http:-none}\" \"\$$3\" \"\$io_pub_tok\" \"\$io_pub_rl\" $(sq "$1")${7:-} >&2 ; fi"
}

emit_gh_json_tail() { # usage: <jq map>; maps the captured body in place, fail-closed
  printf '%s\n' '[ "$IO_PUBLISH_RC" -eq 0 ] || IO_PUBLISH_JSON=""'
  printf '%s\n' "IO_PUBLISH_JSON=\"\$(printf '%s' \"\$IO_PUBLISH_JSON\" | jq -c $(sq "$1") 2>/dev/null)\" || IO_PUBLISH_JSON=\"\""
  # A 2xx body that parses but maps to nothing is still a failed read; rc 0 with "" reads as success.
  printf '%s\n' '[ -n "$IO_PUBLISH_JSON" ] || [ "$IO_PUBLISH_RC" -ne 0 ] || IO_PUBLISH_RC=79'
}

emit_gh_json_api() { # usage: <url> <jq map>; sets IO_PUBLISH_JSON/IO_PUBLISH_RC
  printf '%s\n' 'IO_PUBLISH_RC=0'
  emit_gh_read "$1" IO_PUBLISH_JSON IO_PUBLISH_RC
  emit_gh_json_tail "$2"
}

if [ "$forge" = github ]; then
  case "$gh_project" in
    */*/* | /* | */) usage ;;
    */*) : ;;
    *) usage ;;
  esac
fi

case "${1:-}" in
  push-options)
    title="${2:-}"
    [ -n "$title" ] || usage
    shift 2
    if [ "$forge" = github ]; then
      # work-ticket-build-and-ship.js hands MR_DESCRIPTION over in GitLab push-option escaping.
      pr_body_map='{title: $title, head: $head, base: $base, body: ($body | gsub("\\\\(?<c>.)"; if .c=="n" then "\n" else .c end))}'
      labels_argv=''
      for label in "$@"; do
        labels_argv="$labels_argv $(sq "$label")"
      done
      cat <<'IO_PUB_PUSH_HEAD'
io_pub_rc=0
io_pub_pr=''
io_pub_head=''
io_pub_http=''
io_pub_body=''
io_pub_label_rc=0
io_pub_desc="$MR_DESCRIPTION"
io_pub_body_file="$(mktemp)" || io_pub_body_file=''
[ -n "$io_pub_body_file" ] || io_pub_rc=79
io_pub_head="$(git rev-parse --abbrev-ref HEAD)" || io_pub_head=''
[ -n "$io_pub_head" ] || io_pub_rc=79
if [ "$io_pub_rc" -eq 0 ]; then
IO_PUB_PUSH_HEAD
      printf '%s\n' "  jq -n --arg title $(sq "$title") --arg head \"\$io_pub_head\" --arg base $(sq "${IO_PUBLISH_TARGET:-master}") --arg body \"\$io_pub_desc\" $(sq "$pr_body_map") > \"\$io_pub_body_file\" || io_pub_rc=79"
      printf '%s\n' 'fi'
      printf '%s\n' 'if [ "$io_pub_rc" -eq 0 ]; then'
      # io_git_push_with_gitlab_refresh refreshes a GitLab token; GitHub auth rides the url.insteadOf rewrite.
      printf '%s\n' "  git push -u $(sq "${IO_PUBLISH_REMOTE:-origin}") HEAD || io_pub_rc=\$?"
      printf '%s\n' 'fi'
      printf '%s\n' 'if [ "$io_pub_rc" -eq 0 ]; then'
      emit_gh_read "$gh_base/pulls" io_pub_body io_pub_rc "$gh_post_argv" '  ' "$gh_post_cfg"
      # A re-push into an open PR is a normal retry, so its 422 is the success the caller expects.
      cat <<'IO_PUB_PUSH_CREATE'
  if [ "$io_pub_rc" -ne 0 ] && [ "$io_pub_http" = 422 ]; then
    case "$io_pub_body" in *'A pull request already exists'*)
      io_pub_rc=0 ; io_pub_body=''
      printf '[publish] github pr already exists for this branch; continuing\n' >&2 ;;
    esac
  fi
fi
[ -z "$io_pub_body_file" ] || rm -f "$io_pub_body_file"
if [ "$io_pub_rc" -eq 0 ]; then
  io_pub_pr="$(printf '%s' "$io_pub_body" | jq -r 'if type=="object" and (.number|type)=="number" then .number else "" end' 2>/dev/null)" || io_pub_pr=''
  case "$io_pub_pr" in ''|*[!0-9]*) io_pub_pr='' ;; esac
fi
if [ "$io_pub_rc" -eq 0 ] && [ -z "$io_pub_pr" ]; then
IO_PUB_PUSH_CREATE
      emit_gh_read "$gh_base/pulls?head=$gh_owner:" io_pub_body io_pub_rc "\"\$io_pub_head\"'&state=open&per_page=100'" '  '
      cat <<'IO_PUB_PUSH_RESOLVE'
  io_pub_pr="$(printf '%s' "$io_pub_body" | jq -r 'if type=="array" and (.[0].number|type)=="number" then .[0].number else "" end' 2>/dev/null)" || io_pub_pr=''
  case "$io_pub_pr" in ''|*[!0-9]*) io_pub_pr='' ;; esac
fi
[ "$io_pub_rc" -ne 0 ] || [ -n "$io_pub_pr" ] || io_pub_rc=79
IO_PUB_PUSH_RESOLVE
      if [ "$#" -gt 0 ]; then
        printf '%s\n' 'if [ "$io_pub_rc" -eq 0 ] && [ -n "$io_pub_pr" ]; then'
        cat <<'IO_PUB_LABEL_HEAD'
  io_pub_body_file="$(mktemp)" || io_pub_body_file=''
  [ -n "$io_pub_body_file" ] || io_pub_label_rc=79
  if [ "$io_pub_label_rc" -eq 0 ]; then
IO_PUB_LABEL_HEAD
        printf '%s\n' "    jq -n --args '{labels: \$ARGS.positional}' --$labels_argv > \"\$io_pub_body_file\" || io_pub_label_rc=79"
        printf '%s\n' '  fi'
        printf '%s\n' '  if [ "$io_pub_label_rc" -eq 0 ]; then'
        # Kept out of the emission's exit status: the PR exists by now, and failing would strand it.
        emit_gh_read "$gh_base/issues/" io_pub_body io_pub_label_rc "\"\$io_pub_pr\"'/labels'$gh_post_argv" '    ' "$gh_post_cfg"
        printf '%s\n' '    [ "$io_pub_label_rc" -eq 0 ] || printf '"'"'[publish] github label attach failed; the pull request is unaffected\n'"'"' >&2'
        printf '%s\n' '  fi'
        printf '%s\n' '  [ -z "$io_pub_body_file" ] || rm -f "$io_pub_body_file"'
        printf '%s\n' 'fi'
      fi
      # GitHub returns the number only here, and Ship's mr_iid gate reads it back off this line.
      printf '%s\n' "[ -z \"\$io_pub_pr\" ] || printf 'View pull request !%s: %s/%s\n' \"\$io_pub_pr\" $(sq "https://github.com/$gh_project/pull") \"\$io_pub_pr\""
      # A subshell, not a bare `exit`: the caller evals this text in its own shell.
      printf '%s\n' '( exit "$io_pub_rc" )'
    else
      printf '%s\n' "io_git_push_with_gitlab_refresh -u ${IO_PUBLISH_REMOTE:-origin} HEAD \\"
      printf '%s\n' '-o merge_request.create \'
      printf '%s\n' "-o merge_request.target=${IO_PUBLISH_TARGET:-master} \\"
      printf '%s\n' "-o merge_request.title=$(sq "$title") \\"
      # $MR_DESCRIPTION stays an unexpanded reference: the prompt defines it in the caller's shell.
      printf '%s\n' '-o "merge_request.description=$MR_DESCRIPTION" \'
      for label in "$@"; do
        printf '%s\n' "-o merge_request.label=$(sq "$label") \\"
      done
      printf '%s\n' '-o merge_request.remove_source_branch'
    fi
    ;;
  assets-push)
    branch="${2:-}"
    dir="${3:-}"
    [ "$forge" = github ] || usage
    [ -n "$branch" ] && [ -n "$dir" ] || usage
    case "$branch" in
      assets/*/*) usage ;;
      assets/?*) case "${branch#assets/}" in *[!A-Za-z0-9._-]*) usage ;; esac ;;
      *) usage ;;
    esac
    # Plumbing, never porcelain: this runs before the run's fix is committed, so checkout/switch/stash/add would destroy it.
    # mktemp -d, not mktemp: `update-index --cacheinfo` rejects the 0-byte file a bare mktemp leaves behind.
    cat <<'IO_PUB_ASSETS_HEAD'
io_pub_rc=0
io_pub_n=0
io_pub_assets=''
io_pub_f=''
io_pub_sha=''
io_pub_base=''
io_pub_url=''
io_pub_tree=''
io_pub_commit=''
io_pub_idxdir="$(mktemp -d)" || io_pub_idxdir=''
[ -n "$io_pub_idxdir" ] || io_pub_rc=79
if [ "$io_pub_rc" -eq 0 ]; then
IO_PUB_ASSETS_HEAD
    printf '%s\n' "  for io_pub_f in $(sq "$dir")/*.png; do"
    cat <<'IO_PUB_ASSETS_LOOP'
    [ -f "$io_pub_f" ] || continue
    io_pub_base="${io_pub_f##*/}"
    io_pub_sha="$(git hash-object -w --no-filters -- "$io_pub_f")" || io_pub_sha=''
    if [ -z "$io_pub_sha" ]; then io_pub_rc=79; break; fi
    GIT_INDEX_FILE="$io_pub_idxdir/index" git update-index --add --cacheinfo "100644,$io_pub_sha,$io_pub_base" || io_pub_rc=79
    if [ "$io_pub_rc" -ne 0 ]; then break; fi
    io_pub_url="$(jq -rn --arg s "$io_pub_base" '$s|@uri')" || io_pub_url=''
    if [ -z "$io_pub_base" ] || [ -z "$io_pub_url" ]; then io_pub_rc=79; break; fi
IO_PUB_ASSETS_LOOP
    printf '%s\n' "    io_pub_url=$(sq "https://github.com/$gh_project/raw/$branch/")\"\$io_pub_url\""
    cat <<'IO_PUB_ASSETS_TREE'
    io_pub_assets="${io_pub_assets}ASSET ${io_pub_base} ${io_pub_url}"$'\n'
    io_pub_n=$((io_pub_n + 1))
  done
fi
if [ "$io_pub_rc" -eq 0 ] && [ "$io_pub_n" -gt 0 ]; then
  io_pub_tree="$(GIT_INDEX_FILE="$io_pub_idxdir/index" git write-tree)" || io_pub_tree=''
  [ -n "$io_pub_tree" ] || io_pub_rc=79
fi
if [ "$io_pub_rc" -eq 0 ] && [ "$io_pub_n" -gt 0 ]; then
IO_PUB_ASSETS_TREE
    printf '%s\n' "  io_pub_commit=\"\$(git commit-tree \"\$io_pub_tree\" -m $(sq "screenshots for $branch"))\" || io_pub_commit=''"
    # An empty sha collapses the refspec into git's delete-the-branch form, wiping URLs an earlier render published.
    printf '%s\n' '  [ -n "$io_pub_commit" ] || io_pub_rc=79'
    printf '%s\n' 'fi'
    printf '%s\n' 'if [ "$io_pub_rc" -eq 0 ] && [ "$io_pub_n" -gt 0 ]; then'
    printf '%s\n' "  git push --force $(sq "${IO_PUBLISH_REMOTE:-origin}") \"\$io_pub_commit\"$(sq ":refs/heads/$branch") || io_pub_rc=\$?"
    cat <<'IO_PUB_ASSETS_TAIL'
fi
if [ "$io_pub_rc" -eq 0 ] && [ "$io_pub_n" -gt 0 ]; then
  printf '%s' "$io_pub_assets"
fi
[ -z "$io_pub_idxdir" ] || rm -rf "$io_pub_idxdir"
( exit "$io_pub_rc" )
IO_PUB_ASSETS_TAIL
    ;;
  lookup)
    branch="${2:-}"
    [ -n "$branch" ] || usage
    if [ "$forge" = github ]; then
      emit_gh_api "$gh_base/pulls?head=$gh_owner:$branch&state=open&per_page=100" -c "$gh_lookup_map"
    else
      emit_api "projects/$project/merge_requests?source_branch=$branch&state=opened&per_page=100" \
        "$lookup_map"
    fi
    ;;
  lookup-captured)
    branch="${2:-}"
    [ -n "$branch" ] || usage
    if [ "$forge" = github ]; then
      emit_gh_json_api "$gh_base/pulls?head=$gh_owner:$branch&state=open&per_page=100" "$gh_lookup_map"
    else
      emit_json_api '' \
        "projects/$project/merge_requests?source_branch=$branch&state=opened&per_page=100" \
        '' "$lookup_map"
    fi
    ;;
  # state is the vocabulary work-ticket-build-and-ship.js gates on: opened|merged|closed|locked|unknown.
  mr-show)
    id="${2:-}"
    [ -n "$id" ] || usage
    if [ "$forge" = github ]; then
      # Slurped so an empty body still prints the unknown sentinel; "closed" fails open downstream.
      emit_gh_api "$gh_base/pulls/$id" -cs \
        ".[0] | if type==\"object\" and (.number|type)==\"number\" then {state: ($gh_state), sha: (.head.sha // \"\")} else {state: \"unknown\", sha: \"\"} end"
    else
      emit_api "projects/$project/merge_requests/$id" '{state: (.state // "unknown"), sha: (.sha // "")}'
    fi
    ;;
  # "" defaults, never "unknown": converge-vector routes "" to unreadable, anything else to mergeable.
  mr-show-captured)
    id="${2:-}"
    [ -n "$id" ] || usage
    if [ "$forge" = github ]; then
      emit_gh_json_api "$gh_base/pulls/$id" \
        "if type==\"object\" and (.number|type)==\"number\" then {state: ($gh_state), sha: (.head.sha // \"\"), branch: (.head.ref // \"\"), title: (.title // \"\"), merge_status: ($gh_merge_status), description: (.body // \"\")} else empty end"
    else
      emit_json_api '' "projects/$project/merge_requests/$id" '' \
        'if type=="object" then {state: (.state // ""), sha: (.sha // ""), branch: (.source_branch // ""), title: (.title // ""), merge_status: (.detailed_merge_status // ""), description: (.description // "")} else empty end'
    fi
    ;;
  commit-show)
    sha="${2:-}"
    [ -n "$sha" ] || usage
    if [ "$forge" = github ]; then
      emit_gh_json_api "$gh_base/commits/$sha" \
        'if type=="object" then {parent_ids: [(.parents // [])[].sha]} else empty end'
    else
      emit_json_api '' "projects/$project/repository/commits/$sha" '' \
        'if type=="object" then {parent_ids: (.parent_ids // [])} else empty end'
    fi
    ;;
  note-create)
    id="${2:-}"
    [ -n "$id" ] || usage
    if [ "$forge" = github ]; then
      # Issues, not /pulls/{n}/comments: that path is the review-comment endpoint and 422s a plain body.
      cat <<'IO_PUB_NOTE_HEAD'
IO_PUBLISH_RC=0
IO_PUBLISH_JSON=''
io_pub_body_file="$(mktemp)" || io_pub_body_file=''
[ -n "$io_pub_body_file" ] || IO_PUBLISH_RC=79
if [ "$IO_PUBLISH_RC" -eq 0 ]; then
  jq -n --arg body "${IO_PUBLISH_NOTE_BODY:-}" '{body: $body}' > "$io_pub_body_file" || IO_PUBLISH_RC=79
fi
if [ "$IO_PUBLISH_RC" -eq 0 ]; then
IO_PUB_NOTE_HEAD
      emit_gh_read "$gh_base/issues/$id/comments" IO_PUBLISH_JSON IO_PUBLISH_RC "$gh_post_argv" '  ' "$gh_post_cfg"
      printf '%s\n' 'fi'
      printf '%s\n' '[ -z "$io_pub_body_file" ] || rm -f "$io_pub_body_file"'
      emit_gh_json_tail "$note_map"
    else
      emit_json_api '--method POST' "projects/$project/merge_requests/$id/notes" \
        '-f "body=$IO_PUBLISH_NOTE_BODY"' \
        "$note_map"
    fi
    ;;
  mr-diffs)
    id="${2:-}"
    [ -n "$id" ] || usage
    diffs_map='if type=="array" then [.[] | {new_path: (.new_path // ""), old_path: (.old_path // "")}] else empty end'
    # GitHub sends previous_filename present-and-null on a non-rename, so `//` and not has(…).
    [ "$forge" != github ] ||
      diffs_map='if type=="array" then [.[] | {new_path: (.filename // ""), old_path: (.previous_filename // .filename // "")}] else empty end'
    emit_json_pages "projects/$project/merge_requests/$id/diffs?per_page=100&page=" \
      "$diffs_map" "$gh_base/pulls/$id/files?per_page=100&page="
    ;;
  # converge-vector strict-compares and fingerprints these fields, so a `// default` would invent a verdict.
  mr-awards)
    id="${2:-}"
    [ -n "$id" ] || usage
    awards_map='if type=="array" then [.[] | {name, created_at, user: {id: .user.id}}] else empty end'
    [ "$forge" != github ] || awards_map="$gh_awards_map"
    emit_json_pages "projects/$project/merge_requests/$id/award_emoji?per_page=100&page=" \
      "$awards_map" "$gh_base/issues/$id/reactions?per_page=100&page="
    ;;
  mr-pipelines)
    id="${2:-}"
    [ -n "$id" ] || usage
    pipelines_map='if type=="array" then [.[] | {id, status, source, ref, sha, created_at}] else empty end'
    [ "$forge" != github ] || pipelines_map="$gh_check_runs_map"
    emit_json_pages "projects/$project/merge_requests/$id/pipelines?per_page=100&page=" \
      "$pipelines_map" "$gh_base/commits/refs/pull/$id/head/check-runs?per_page=100&page="
    if [ "$forge" = github ]; then
      # Folded after the loop, never inside it: emit_json_pages concatenates one projection per page.
      printf '%s\n' 'if [ "$IO_PUBLISH_RC" -eq 0 ] && [ -n "$IO_PUBLISH_JSON" ]; then'
      printf '%s\n' "  IO_PUBLISH_JSON=\"\$(printf '%s' \"\$IO_PUBLISH_JSON\" | jq -c $(sq "$gh_check_runs_agg") 2>/dev/null)\" || IO_PUBLISH_JSON=\"\""
      printf '%s\n' '  [ -n "$IO_PUBLISH_JSON" ] || IO_PUBLISH_RC=79'
      printf '%s\n' 'fi'
    fi
    ;;
  mr-notes)
    id="${2:-}"
    [ -n "$id" ] || usage
    notes_map='if type=="array" then [.[] | {id, body, system, type, created_at, updated_at, author: {id: .author.id}}] else empty end'
    [ "$forge" != github ] || notes_map="$gh_notes_map"
    emit_json_pages "projects/$project/merge_requests/$id/notes?per_page=100&sort=desc&order_by=created_at&page=" \
      "$notes_map" "$gh_base/issues/$id/comments?per_page=100&page="
    ;;
  mr-discussions)
    id="${2:-}"
    [ -n "$id" ] || usage
    if [ "$forge" = github ]; then
      emit_gh_graphql_pages "$id" "$gh_threads_query" "$gh_threads_map"
    else
      emit_json_pages "projects/$project/merge_requests/$id/discussions?per_page=100&page=" \
        'if type=="array" then [.[] | {id, individual_note, notes: [(.notes // [])[] | {id, body, system, created_at, updated_at, resolvable, resolved, author: {id: .author.id}}]}] else empty end'
    fi
    ;;
  *)
    usage
    ;;
esac
