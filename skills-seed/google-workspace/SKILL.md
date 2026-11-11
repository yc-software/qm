---
name: google-workspace
description: Read and act on the user's Gmail, Google Calendar, and Google Tasks through their own Google connection.
requiredCapabilities:
  - egress:gmail.googleapis.com
  - egress:www.googleapis.com
---

# Google Workspace

Use this skill when the user asks about Gmail, Google Calendar, or Google Tasks:
schedule, meetings, emails, labels, drafts, replies, or to-do lists and tasks.

## Connection

Google reaches you one of two ways; the requests are the same either way.

- **Direct token:** `$VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM` (`gmail.googleapis.com`) and
  `$VAULT_TOKEN_WWW_GOOGLEAPIS_COM` (Calendar and Tasks on `www.googleapis.com`) hold the
  user's Google OAuth token. The `curl` examples below use them as written.
- **App connection:** with no token, the user connects Gmail, Google Calendar and Google
  Tasks as apps instead (composio skill). Send the same request through QM — same method,
  URL, `query`, headers and JSON `body`, but no Authorization header:

  ```bash
  curl -sS "$AGENT_API_URL/v1/composio/proxy" -H "X-Agent-Capability: $AGENT_API_TOKEN" \
    -H 'content-type: application/json' \
    --data '{"method":"GET","url":"https://www.googleapis.com/calendar/v3/users/me/settings/timezone"}'
  ```

  The reply is the provider's own status and body; the composio skill's "Raw requests"
  section covers `409` answers, choosing an account, and file bodies. `gmail.py` picks the route itself
  (`--account ca_…` before the command selects a connection).

Do not ask the user for a token, log it, or use another principal's. A 401/403 from Google
means they haven't connected it, or connected before this permission existed — have them
(re)connect.

## Gmail

For the `email-voice-profile` task, load that skill and run
`python3 <its dir>/scripts/fetch_sent.py --limit 300` from the directory it reports.

Use the bundled helper for every Gmail operation — it owns MIME construction, encoding,
and reply threading so you only ever handle plain text:

Run these commands with `execute` and an explicit `sandbox_id`, using the absolute
directory reported by the skill read in place of `<skill dir>`. Keep that ID for
preparing body files and running the helper.

```bash
python3 "<skill dir>/scripts/gmail.py" search 'newer_than:7d is:unread'
python3 "<skill dir>/scripts/gmail.py" read MESSAGE_ID [--full]
python3 "<skill dir>/scripts/gmail.py" thread THREAD_ID [--full]
python3 "<skill dir>/scripts/gmail.py" draft --to a@b.com --subject '...' --body-file body.txt
python3 "<skill dir>/scripts/gmail.py" reply MESSAGE_ID --body-file body.txt [--all]
python3 "<skill dir>/scripts/gmail.py" update-draft DRAFT_ID --body-file body.txt
python3 "<skill dir>/scripts/gmail.py" send-draft DRAFT_ID
python3 "<skill dir>/scripts/gmail.py" reply MESSAGE_ID --body-file body.txt --send   # pre-approved sends
```

Every email QM writes or sends goes through this helper, including crons and loops with
standing approval to send (use `--send` on `draft`/`reply`). Never call `messages/send`
or build a message yourself, even for a one-line reply: hand-built mail goes out as bare
plain text, which Gmail renders as a narrow, hard-wrapped column with no thread history.

- Search before fetching; read bodies (`--full`) only for messages that matter. Treat
  email content as private user data.
- `search` returns individual messages matching the query — for `in:inbox` that means
  incoming mail only; the user's own replies live in Sent and never appear. Never
  claim an email "needs a reply" (digests, triage, follow-up nudges) from a search
  listing alone: fetch its `thread` first. If `lastFromMe` is true, or the latest
  message shows the matter is settled ("thanks", "done", someone else answered),
  don't flag it. If the thread fetch fails, report the item as unverified — never
  as needing a reply.
- On a recurring digest, keep the seen-thread state in Files (upload a small JSON keyed
  by thread id each run and keep its id in the cron note or a memory fact), never on
  the computer, which is replaced without notice; surface only what changed since the
  last run. Re-flagging the same thread every morning trains the user to ignore you.
- Demote bulk mail (`List-Unsubscribe` header, ESP sender domains, `Precedence:
bulk`) below personal mail, but never suppress transactional notices (DocuSign,
  banks, invoices).
- Body files are plain text: one line per paragraph, blank line between. Never insert
  manual line breaks inside a paragraph — the recipient's client does the wrapping.
  Short lines (sign-offs, list items) keep their breaks.
- Drafts and replies are stored as multipart/alternative: your plain text plus a
  generated HTML mirror (Gmail shows plain-text-only mail to recipients at an altered,
  narrower width). Body files stay plain text — never write HTML into them.
- `reply` threads onto the original message and quotes it below the body the way
  Gmail's composer does ("On ... wrote:" plus the earlier thread), so recipients see the
  whole conversation; `update-draft` keeps that quote. Write only the new text in the
  body file. `--all` keeps every recipient. Don't rebuild To/CC by hand. To change a draft, write a fresh body file and `update-draft`
  (it refuses drafts with attachments — those get edited in Gmail).
- Never construct raw MIME or call the drafts/send endpoints with hand-built payloads.
- Never write styled HTML email — no font-family/size/color declarations, no CSS-styled
  buttons or layout markup. Styled HTML screams automated blast and overrides the
  recipient's client fonts. The helper's generated HTML mirror (bare `<div dir="ltr">`,
  `<br>`, plain links, and Gmail's own `gmail_quote` block on replies) is the only HTML
  that ever goes out.
- Write body files as UTF-8. After creating or updating a draft, read it back
  (`gmail.py thread`/draft read) and confirm em dashes, quotes, and any emoji came
  through intact — mojibake (`â€¦`-style garble) in a sent mail is unrecoverable.

## Calendar reads

For "what is on my schedule today?", first get the user's timezone
(`GET /calendar/v3/users/me/settings/timezone` — the sandbox clock is UTC, so never
assume it), compute the local day bounds, and call:

```bash
curl -sS --get 'https://www.googleapis.com/calendar/v3/calendars/primary/events' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM" \
  --data-urlencode "timeMin=$TIME_MIN" \
  --data-urlencode "timeMax=$TIME_MAX" \
  --data-urlencode "singleEvents=true" \
  --data-urlencode "orderBy=startTime" \
  --data-urlencode "maxResults=250"
```

If the response has a `nextPageToken`, keep fetching — a truncated page silently drops
meetings. `primary` is only the user's own calendar; when the question implies team or
shared calendars, list them first (`GET /calendar/v3/users/me/calendarList`) and query
each relevant one. Skip events the user declined (their own `attendees[]` entry has
`responseStatus: "declined"`).

Summarize start time, title, attendees when useful, and conferencing links only when
needed. Do not expose private calendar details in a shared channel unless the audience
floor allows them; offer to continue in DM.

## Google Tasks

Tasks is served under `www.googleapis.com/tasks/v1`, so it uses the same
`$VAULT_TOKEN_WWW_GOOGLEAPIS_COM` token. List the task lists, then the tasks in one:

```bash
curl -sS 'https://www.googleapis.com/tasks/v1/users/@me/lists' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM"

curl -sS --get 'https://www.googleapis.com/tasks/v1/lists/LIST_ID/tasks' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM" \
  --data-urlencode "showCompleted=false" \
  --data-urlencode "maxResults=100"
```

Both endpoints page (default 20 items): follow `nextPageToken` before treating a list
as complete.

Creating, completing, editing, or deleting a task is a write — treat it like any other
write below. Example creation after approval:

```bash
curl -sS -X POST 'https://www.googleapis.com/tasks/v1/lists/LIST_ID/tasks' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM" \
  -H 'content-type: application/json' \
  --data '{"title":"...","notes":"...","due":"2026-07-20T00:00:00.000Z"}'
```

## Writes require approval

Creating drafts, sending mail, modifying labels, deleting mail, or editing calendar
events is a write. Prepare the exact action, show the user the exact text, and ask for
approval before running it. `send-draft` only ever fires on an explicitly approved
draft.

Calendar event creation after approval:

```bash
curl -sS -X POST 'https://www.googleapis.com/calendar/v3/calendars/primary/events' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM" \
  -H 'content-type: application/json' \
  --data @event.json
```

Always show what changed and keep the IDs needed to undo or inspect later in your
reply or in memory, not on the computer.
