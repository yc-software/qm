---
name: memory
description: Deliberately search, add to, or curate your long-term memory with the `memory` tool — beyond the automatic recall/capture every turn already does. Use when asked who someone is or what they're working on, when you learn a durable fact worth keeping now, or when your notebook holds stale or wrong entries you should clean up.
---

# memory — search, write, and curate what you remember

Everything here goes through the typed `memory` tool. Memory is NOT a file: writing
`memory/MEMORY.md` with `write` or shell commands lands on your computer's disk and is
silently lost — the tool is the one real path.

Every turn already auto-recalls a bounded selection from your notebooks into "## What you remember" and
auto-extracts facts after you reply. This skill is for what the automatic path misses:

- **Search** (`action: "search"`) — what you remember is bigger than what auto-recall
  injects. Search spans every notebook this conversation may read (personal, channel,
  org); when more than one is in reach, each hit is tagged with the notebook it came
  from. Matching is substring-based (all terms must match), so prefer distinctive terms
  (a name, a project) over sentences.
  An empty result means those terms found no match, not that nothing is recorded. Try fewer terms or alternate wording before concluding a fact is absent.
- **Read another notebook** (`action: "read", scope: "channel:…"`) — use the exact
  scope ID from a search result to load that authorized notebook. `search` accepts
  `scope` too, to narrow a query. Omit it to search all authorized notebooks or read
  the current notebook. Access comes from this turn's sharing policy; naming a
  scope never grants access. Other notebooks are read-only.
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
channel's in a channel). Other authorized notebooks can be searched/read, not rewritten here.

The org-admin write path uses the self-API instead, called with
`$AGENT_API_URL` and `$AGENT_API_TOKEN` (both already in your environment on every turn —
if they are unset, this instance has no self-API; say so rather than pretending):

## Cross-conversation writes

Cross-conversation writes are not supported. Do not pass `scope` on remember/rewrite
or a channel/recipient on the facts API. To change a room's memory, work in that room.
The explicit org-admin path below remains separate from ordinary memory tools.

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
