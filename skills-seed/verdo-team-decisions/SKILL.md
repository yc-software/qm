---
name: verdo-team-decisions
description: Get your team to decide something with a deadline, a structured vote, and a webhook when it is done. Use this when the agent needs a human decision, not just a discussion.
---

# Verdo: Team Decisions

Use this skill when you need your team to make a decision: approve a proposal, pick between options, or sign off on something. You need a structured result, not a Slack thread.

Verdo creates a decision with options and a deadline. It notifies the right people (Slack or email), collects votes, and settles the result. You get the outcome back as structured data.

## When to use this

- The agent needs human input before proceeding (approve/reject, pick one of N)
- A decision needs a deadline and accountability (not "whenever someone replies")
- The result needs to feed back into the agent's workflow (webhook or polling)
- Multiple people need to weigh in with a clear resolution rule

## When NOT to use this

- You just need to send a message (use Slack directly)
- The decision is yours alone (just decide)
- You need a discussion, not a vote (use a Slack thread)

## Setup

You need a Verdo API key. Get one from your workspace at verdo.ink/dashboard/settings, Developer, Create API key.

Set it as an environment variable or credential:
```
VERDO_API_KEY=vdok_your_key_here
```

The API base is `https://verdo.ink/api`.

## Create a decision

```bash
curl -X POST https://verdo.ink/api/v1/decisions \
  -H "Authorization: Bearer $VERDO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Ship the redesigned onboarding flow this sprint?",
    "options": [
      {"text": "Ship it"},
      {"text": "One more round of testing"},
      {"text": "Descope: too risky"}
    ],
    "tags": ["engineering", "sprint-planning"],
    "idempotency_key": "onboarding-redesign-sprint-47",
    "source_agent": "sprint-planner"
  }'
```

**Response (201 Created):**
```json
{
  "decision": {
    "id": "c4b44598-...",
    "title": "Ship the redesigned onboarding flow this sprint?",
    "lifecycle_status": "active",
    "request_fingerprint": "a1b2c3...",
    "notification_status": "delivered"
  },
  "created": true
}
```

If you send the same `idempotency_key` again, you get the existing decision back with `"created": false`. Nothing is duplicated.

**Tags** trigger routing rules. If the workspace has a routing rule matching `engineering`, the decision is automatically routed to the designated approver.

## Check the result

```bash
curl https://verdo.ink/api/v1/decisions/DECISION_ID/status \
  -H "Authorization: Bearer $VERDO_API_KEY"
```

`lifecycle_status` values: `active` (voting open), `decided` (settled), `cancelled`, `stalled` (deadline passed without resolution).

## Webhooks

Subscribe to get notified when decisions settle, instead of polling:

```bash
curl -X POST https://verdo.ink/api/v1/webhooks \
  -H "Authorization: Bearer $VERDO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-server.com/webhook", "event_type": "decision.settled"}'
```

The response includes a `signing_secret` (shown once). Verify deliveries with HMAC-SHA256.

**Event types:** `decision.settled`, `decision.escalated`, `decision.cancelled`.

## Other tools

- **List:** `GET /api/v1/decisions?source_agent=sprint-planner&lifecycle_status=active`
- **Cancel:** `POST /api/v1/decisions/DECISION_ID/cancel` (creator only)
- **Edit:** `POST /api/v1/decisions/DECISION_ID/edit` (creator only, voids votes)
- **Search:** `GET /api/v1/decisions/search?q=onboarding`
- **Precedent:** `GET /api/v1/decisions/precedent?q=onboarding+redesign`

## Routing rules

Workspace admins configure routing rules in Settings. A rule matches decisions by tag and assigns an approver whose vote is final. The agent doesn't need to know who approves: it just sets the right tags.

## Key principle

The agent proposes. The human decides. The agent never approves, rejects, or settles a decision. That is by design.
