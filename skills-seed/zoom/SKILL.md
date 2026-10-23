---
name: zoom
description: Find, create, reschedule, and cancel the user's Zoom meetings through per-user OAuth.
connector: zoom
requiredCapabilities:
  - egress:api.zoom.us
---

# Zoom

Use this skill when the user asks for a Zoom meeting or link, wants to know what Zoom
meetings they have coming up, or wants to move or cancel one.

This is an OAuth connector. The resolved user's Zoom token already lives on your computer
as an environment variable (the way a logged-in CLI's cached credential would):

- `$VAULT_TOKEN_API_ZOOM_US` — for `api.zoom.us`

Pass it as `-H "Authorization: Bearer $VAULT_TOKEN_API_ZOOM_US"`. Never ask the user for a
token, log it, or use another principal's credential.

Per-user connector tokens are present in the user's own DM and personal scheduled tasks,
and in a shared room or channel automation only when the user has opened their connections
there. If the variable is empty in a shared room, ask them to DM you instead of telling
them to reconnect; empty in their DM means they haven't connected Zoom — point them to the
Connectors page.

Zoom error codes: `124` (invalid access token) means they need to reconnect Zoom. `4711`
("does not contain scopes") means their token lacks that scope — if the org's Zoom app
already has it they reconnect, otherwise an admin adds it to the app first. `3001` means the
meeting does not exist or is not theirs.

## Writes require approval

Creating, updating, or deleting a meeting is a write. Show the exact topic, start time with
timezone, and duration (or which meeting changes and how) and ask for approval before
running it. Reads need no approval. In a shared channel, don't post the passcode or full
`join_url` unless everyone there may join.

**Never share `start_url`.** It embeds a host token that lets anyone start the meeting as
the user. Responses that carry it go through `jq` below so it never reaches your output.

## Find meetings

Who the user is, and their default timezone:

```bash
curl -sS 'https://api.zoom.us/v2/users/me' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_ZOOM_US" | jq '{id, email, timezone, code, message}'
```

Upcoming meetings (the next six months; keep fetching with `next_page_token` until it is
empty; times are UTC):

```bash
curl -sS --get 'https://api.zoom.us/v2/users/me/meetings' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_ZOOM_US" \
  --data-urlencode 'type=upcoming' \
  --data-urlencode 'page_size=300' \
  | jq '{next_page_token, meetings: [.meetings[]? | {id, topic, type, start_time, duration, timezone, host_id, join_url}], code, message}'
```

One meeting — a recurring series appears once in the list; its `occurrences` (skip any
with `status: deleted`) come from here:

```bash
curl -sS "https://api.zoom.us/v2/meetings/$MEETING_ID" \
  -H "Authorization: Bearer $VAULT_TOKEN_API_ZOOM_US" \
  | jq '{id, topic, type, start_time, duration, timezone, host_email, join_url, password, occurrences, code, message}'
```

A join URL carries the meeting ID: `https://us06web.zoom.us/j/85012345678?pwd=...` is
meeting `85012345678`. A `type` of `4`, or a `/my/<name>` link, is the user's personal
meeting room, shared by every meeting that uses it — never reschedule or delete it.

## Create a meeting

Send `start_time` as local wall-clock time without an offset (`2026-11-02T10:00:00`) plus
the IANA `timezone`, and Zoom converts it. Use the timezone the user gives, the calendar
event's, or their Zoom profile's; the sandbox clock is UTC, so never assume it. Calendars
that report Windows zone names ("Pacific Standard Time") need mapping to IANA
(`America/Los_Angeles`). `duration` is in minutes.

```bash
curl -sS -X POST 'https://api.zoom.us/v2/users/me/meetings' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_ZOOM_US" \
  -H 'content-type: application/json' \
  --data '{"topic":"Team sync","type":2,"start_time":"2026-11-02T10:00:00","timezone":"America/Los_Angeles","duration":30}' \
  | jq '{id, join_url, password, start_time, duration, timezone, code, message, errors}' > zoom-meeting.json
cat zoom-meeting.json
```

The returned `start_time` is UTC — check it is the instant you meant, because Zoom
silently uses the current time for a missing or past value. The user is the host; leave
`settings` out unless they ask, so the account's defaults (waiting room, passcode) apply.
If the response was lost, list upcoming meetings before creating again — never create a
duplicate.

For a recurring calendar event, create `type: 3` (one link, no fixed time) and leave out
`start_time`. Moving or cancelling one occurrence of the event needs no Zoom change; delete
the meeting only when the whole series ends.

## Reschedule or cancel

Get the meeting first and confirm it is the one the user means. If `host_email` is not the
user's, it belongs to someone who gave them scheduling rights — say whose meeting it is
before changing it. For a recurring meeting with fixed times (`type: 8`), add
`?occurrence_id=<id>` (from `occurrences`) to change or delete one occurrence; without it,
the whole series changes.

Reschedule, with the same time rules as create:

```bash
curl -sS -w '\n%{http_code}\n' -X PATCH "https://api.zoom.us/v2/meetings/$MEETING_ID" \
  -H "Authorization: Bearer $VAULT_TOKEN_API_ZOOM_US" \
  -H 'content-type: application/json' \
  --data '{"start_time":"2026-11-02T11:00:00","timezone":"America/Los_Angeles","duration":45}'
```

`204` comes back even when Zoom ignored a past `start_time`, so get the meeting again and
confirm the new time before reporting it.

Cancel (`204` means done):

```bash
curl -sS -w '\n%{http_code}\n' -X DELETE "https://api.zoom.us/v2/meetings/$MEETING_ID" \
  -H "Authorization: Bearer $VAULT_TOKEN_API_ZOOM_US"
```

Zoom doesn't notify attendees of either change.

## With a calendar

This skill only talks to Zoom. To put a meeting on the user's calendar, use whichever
calendar connector they have:

- Check the event before creating a meeting: the user must be able to edit it (usually as
  organizer), and if it already has a video link, ask before adding another.
- Add the join details without overwriting anything: append the `join_url`, meeting ID,
  and passcode to the description, and fill the location only if it is empty.
- All-day events have no time — ask when the meeting is. For a recurring event, ask whether
  they mean one occurrence or the series.
- Nothing keeps the two in sync. When the event moves or is cancelled, update or delete
  the meeting too (the meeting ID is in the event's join URL); when you move or cancel a
  meeting that is on an event, update the event too, or tell the user that attendees
  weren't told.
- If the calendar step fails after the meeting was created, report the meeting ID and offer
  to delete it.

Report the meeting ID, the `join_url`, and what changed.
