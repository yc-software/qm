---
name: memory
description: Deliberately search, add to, or curate your long-term memory with the `memory` tool — beyond the automatic recall/capture every turn already does. Use when asked who someone is or what they're working on, when you learn a durable fact worth keeping now, or when your notebook holds stale or wrong entries you should clean up.
---

# memory — search, write, and curate what you remember

Everything here goes through the typed `memory` tool. Memory is NOT a file: writing
`memory/MEMORY.md` with `write` or shell commands lands on your computer's disk and is
silently lost — the tool is the one real path.

Every turn already auto-recalls your notebooks into "## What you remember" and
auto-extracts facts after you reply. This skill is for what the automatic path misses:

- **Search** (`action: "search"`) — what you remember is bigger than what auto-recall
  injects. Search spans every notebook this conversation may read (personal, channel,
  org); when more than one is in reach, each hit is tagged with the notebook it came
  from. Matching is substring-based (all terms must match), so prefer distinctive terms
  (a name, a project) over sentences.
  An empty result is a real answer: you have nothing recorded, so don't assert a memory.
- **Write now** (`action: "remember"`) — when the user corrects you or tells you
  something they'll expect you to know later, persist it immediately instead of hoping
  post-turn extraction catches it. Write self-contained facts (who/what, with enough
  context to be useful cold). Duplicates are dropped; `added` in the reply is the count
  actually new.
- **Curate** (`action: "read"`, then `action: "rewrite"`) — read your whole notebook and
  rewrite it without stale, duplicate, or wrong lines. A rewrite replaces the entire
  notebook: read first, then write back the full corrected content, never a fragment.
  Curation is for quality — merging duplicates, deleting disproven facts — not for
  deleting things the user asked you to remember.

The notebook you write is this conversation's own (your personal one in a DM, the
channel's in a channel). There is no way to reach anyone else's, by design.

Two targeted writes the tool doesn't carry go through the self-API instead, called with
`$AGENT_API_URL` and `$AGENT_API_TOKEN` (both already in your environment on every turn —
if they are unset, this instance has no self-API; say so rather than pretending):

## Save context into another room the user belongs to

When someone asks you (say, in a DM) to remember something _for_ a channel or group DM — the
way Bob, in a DM, might want the background on a project saved into that project's channel
so you know it when paged there — add a target to a `facts` call:

```bash
curl -fsS -X POST "$AGENT_API_URL/v1/memory/facts" \
  -H "x-agent-capability: $AGENT_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"channel":"project-atlas","facts":["This channel coordinates ..."]}'
```

Name a `channel` (core resolves the name — an ambiguous one comes back `409` with
candidates), or a group DM by its `participants` (the other members' ids). Core checks the
person you're helping may post there before writing: any internal teammate may write to a
public channel; a private channel or group DM requires they're a member (`403` otherwise).
This appends only — you can't read or wholesale-rewrite another room's notebook this way. The
reply echoes the resolved `channel`/`group` and the `scopeId` written to.

## Org-wide notebook (admins)

When the chatting user is an org admin, the self-API additionally accepts the org-wide
notebook as a target:

```bash
curl -fsS -X POST "$AGENT_API_URL/v1/memory/facts" \
  -H "x-agent-capability: $AGENT_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"scope":"org","facts":["..."]}'
```

(`?scope=org` on `GET /v1/memory/self`, `"scope":"org"` on the PUT body to curate.)
Those writes land in the notebook every conversation in the org recalls, so confirm the
wording with the admin before writing and keep personal facts out of it. A `403 org
memory writes require an org admin` means the user isn't one — say so rather than
retrying (`GET $AGENT_API_URL/v1/admin/whoami` answers it definitively).

## Failure modes

- "memory isn't available in this conversation" — this conversation's memory policy
  forbids it; don't retry, just say memory is off here.
- On a read-only wake (a heartbeat glance), memory can be searched and read but not
  written — save the fact on a normal turn instead.
- `401 unauthorized` from the self-API — your token expired mid-turn; this resolves on
  the next turn.
