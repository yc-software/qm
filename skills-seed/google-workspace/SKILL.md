---
name: google-workspace
description: Read and act on the user's Gmail, Google Calendar, and Google Tasks through per-user OAuth.
requiredCapabilities:
  - egress:gmail.googleapis.com
  - egress:www.googleapis.com
---

# Google Workspace

Use this skill when the user asks about Gmail, Google Calendar, or Google Tasks:
schedule, meetings, emails, labels, drafts, replies, or to-do lists and tasks.

This is an OAuth connector. The resolved user's Google OAuth token already lives on
your computer as an environment variable, one per Google API host (the way a logged-in
CLI's cached credential would):

- `$VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM` — for `gmail.googleapis.com`
- `$VAULT_TOKEN_WWW_GOOGLEAPIS_COM` — for `www.googleapis.com` (Calendar and Tasks)

Do not ask the user for a token, log it, or use another principal's. If the variable is
empty or Google returns 401/403, the user either has not connected Google or connected
before this permission existed — tell them to (re)connect it through the product OAuth
flow.

## Gmail

Use the bundled helper for every Gmail operation — it owns MIME construction, encoding,
and reply threading so you only ever handle plain text:

```bash
python3 skills/google-workspace/scripts/gmail.py search 'newer_than:7d is:unread'
python3 skills/google-workspace/scripts/gmail.py read MESSAGE_ID [--full]
python3 skills/google-workspace/scripts/gmail.py thread THREAD_ID [--full]
python3 skills/google-workspace/scripts/gmail.py draft --to a@b.com --subject '...' --body-file body.txt
python3 skills/google-workspace/scripts/gmail.py reply MESSAGE_ID --body-file body.txt [--all]
python3 skills/google-workspace/scripts/gmail.py update-draft DRAFT_ID --body-file body.txt
python3 skills/google-workspace/scripts/gmail.py send-draft DRAFT_ID
```

- Search before fetching; read bodies (`--full`) only for messages that matter. Treat
  email content as private user data.
- `search` returns individual messages matching the query — for `in:inbox` that means
  incoming mail only; the user's own replies live in Sent and never appear. Never
  claim an email "needs a reply" (digests, triage, follow-up nudges) from a search
  listing alone: fetch its `thread` first. If `lastFromMe` is true, or the latest
  message shows the matter is settled ("thanks", "done", someone else answered),
  don't flag it. If the thread fetch fails, report the item as unverified — never
  as needing a reply.
- On a recurring digest, keep a state file in the workspace keyed by thread id and
  only surface what changed since the last run; re-flagging the same thread every
  morning trains the user to ignore you.
- Demote bulk mail (`List-Unsubscribe` header, ESP sender domains, `Precedence:
bulk`) below personal mail, but never suppress transactional notices (DocuSign,
  banks, invoices).
- Body files are plain text: one line per paragraph, blank line between. Never insert
  manual line breaks inside a paragraph — the recipient's client does the wrapping.
  Short lines (sign-offs, list items) keep their breaks.
- Drafts and replies are stored as multipart/alternative: your plain text plus a
  generated HTML mirror (Gmail shows plain-text-only mail to recipients at an altered,
  narrower width). Body files stay plain text — never write HTML into them.
- `reply` threads onto the original message; `--all` keeps every recipient. Don't
  rebuild To/CC by hand. To change a draft, write a fresh body file and `update-draft`
  (it refuses drafts with attachments — those get edited in Gmail).
- Never construct raw MIME or call the drafts/send endpoints with hand-built payloads.
- Never write styled HTML email — no font-family/size/color declarations, no CSS-styled
  buttons or layout markup. Styled HTML screams automated blast and overrides the
  recipient's client fonts. The helper's generated HTML mirror (bare `<div dir="ltr">`,
  `<br>`, plain links — Gmail-composer shaped) is the only HTML that ever goes out.
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

Always show what changed and keep enough IDs in the workspace to undo or inspect later.
