# Memory providers

QM keeps its built-in notebook memory unless `MEMORY_PROVIDER_CONFIG` defines a scope-aware provider router. Routes independently select where each scope recalls from, accepts explicit writes, and receives automatic post-turn capture. Org admins can also bind members to personal-memory brains at runtime through the [memory registry](#memory-registry).

## Prompt memory

Each turn carries at most 6,000 characters of memory, selected across every notebook
the conversation may read and every provider routed to it. Each notebook, and each external
provider within it, gets its own heading and its own ```untrusted-data block. Recalled text is
reference data, never instructions: QM escapes triple backticks and closing tags (`</` becomes
`<\/`) and prefixes heading-like lines (`#` alone or followed by a space, tab or another `#`, even when indented) with a backslash, so a recalled row cannot close its
block, end the `<environment>` section or pose as a heading. With PostgreSQL and an embedding
model, facts are ranked by exact cosine similarity to the current message and recent
dialogue; otherwise the newest facts come first. Each notebook and each provider keeps its own
order, and recall and search take one row from each of them in turn until the budget or limit is
full; scores are never compared across sources. Later turns add only newly selected facts.
Provider rows without fact ids are compared by content hash. An MCP provider whose answer carries
`structuredContent.facts`, a list of `{ id, text, date?, kind? }` with string `id` and `text`
(gbrain's `memory_recall` returns `id`, `text`, `date` and `kind`), gives one row per fact, and
search shows it as `<provider id>:<fact id>`. A `facts` value that isn't such a list, or a fact id that is empty or holds whitespace, fails the read with `malformed_fact`. Whitespace runs in a fact's text, date and kind, line breaks included, become one space, a blank fact is skipped, and a fact that doesn't fit the provider's `maxChars` is skipped while later ones may still fit. Without
`structuredContent.facts`, the answer becomes one row per line, so it should return one
self-contained fact per line; a `memorable` procedure block stays one row. A claim held by several
sources (compared ignoring case and surrounding spaces) is shown once, as the first notebook's copy
when there is one, at that copy's own place in its list. The lists holding the other copies skip
them, so a second copy neither moves the claim up nor costs its list a turn. Search ends that line
with the other copies' addresses, such as `(also acme-company:4821)`, or `[org:acme] #12` for a copy
in another notebook. Only new rows are added, a row already shown stays counted while its provider keeps
answering (at most as many earlier rows as its latest answer showed, and at least one, so a later
refusal is still noted), and a row that drops out is never announced as removed. When a provider
that showed rows earlier refuses the member, is withheld from the conversation or is no longer
routed, the turn adds one note not to rely on memory from sources that are not currently authorized.

Choose the model with the org setting `memory-embedding-model`
(`{ "modelId": "gateway/<model>" }`, or `null` to turn ranking off).
Gateway models with `mode=embedding` are listed automatically; a direct OpenAI-compatible
model is registered in the model registry with `"kind": "embedding"`. The provider
receives fact text during background indexing and the query during recall. PostgreSQL
stores typed vectors in `memory_fact_vectors`; recall ranks live, disclosed facts once per
scope in SQL and returns compact ranked matches. No approximate vector index is used.

Semantic recall requires the PostgreSQL `vector` extension. Its migration is registered
only after a configured embedding model resolves, not during an unconfigured startup.
If the application database role cannot install extensions, an administrator must install
`vector` first. File-backed installations use newest-first recall, even with a model selected.

A single background indexer embeds at most 64 missing facts and removes stale vectors in
bounded batches every 30 seconds. It also sends a short dimension probe every ten minutes so a provider's
vector-width change is detected even when its model identifier stays the same.

New or edited facts may wait for a background tick before becoming semantic matches.
Unindexed facts participate at the recency fallback score alongside indexed semantic
matches. If the provider/database fails, recall falls back to newest-first. Text search (`memory` search, `POST /v1/memory/search`) remains
immediate and does not use embeddings.

## External routing

```json
{
  "providers": [
    {
      "id": "org-knowledge",
      "type": "mcp",
      "url": "http://memory-provider.internal:8080",
      "timeoutMs": 3000,
      "read": {
        "tool": "search_knowledge",
        "clientIdEnv": "KNOWLEDGE_RO_CLIENT_ID",
        "clientSecretEnv": "KNOWLEDGE_RO_CLIENT_SECRET"
      },
      "write": {
        "tool": "write_knowledge",
        "clientIdEnv": "KNOWLEDGE_RW_CLIENT_ID",
        "clientSecretEnv": "KNOWLEDGE_RW_CLIENT_SECRET"
      }
    }
  ],
  "routes": [
    {
      "provider": "default",
      "scopes": ["personal", "channel", "group", "team"],
      "capture": "automatic"
    },
    {
      "provider": "org-knowledge",
      "scopes": ["org"],
      "capture": "explicit",
      "manage": false,
      "label": "Organizational knowledge"
    }
  ]
}
```

Set the compact JSON document as `MEMORY_PROVIDER_CONFIG`. `default` names QM's local/Postgres notebook. A scope selector may be a kind (`org`) or an exact scope ID (`org:acme`). Earlier matching routes can compose multiple recall providers; the first route with `manage` enabled supplies notebook editing and revision history.

Capture policies are:

- `off`: recall only;
- `explicit`: writes only through deliberate memory actions;
- `automatic`: explicit writes plus post-turn capture.

Only a conversation's own writes reach a provider other than the notebook: the `memory` tool's `add`, `POST /v1/memory/facts`, post-turn capture and, on a registry brain in the member's own DM, forgetting a brain fact by its ref ([Forgetting a brain fact](#forgetting-a-brain-fact)). Everything else changes the notebook alone: an admin's `/v1/admin/memory` writes, onboarding status, a member's own edits through `/v1/memory`, QM's note about missing channel history, and any write made from another conversation. The nightly memory tidy goes further: its turn recalls, searches and writes the notebook alone, through its tools and its agent API token alike. It can't schedule work that would run without that rule: its turn has no cron, webhook or goal tools, its agent API token is refused when it creates or changes crons, loops or webhooks, and the subagents and swarm workers it starts follow the same rule. A session message it sends starts work only in a session that already follows the rule, such as one of its own subagents; any other session gets the message as mail, and an interrupt is refused. Every later turn in the tidy's own conversation is notebook-only too, whatever wakes it, such as a background watch or a credential approval. QM recognizes the tidy by the job it created for that notebook, not by the job's title or task, so editing the job keeps the rule and no other scheduled job is affected.

MCP reads receive `query` and `acting_user` by default. Writes receive `content` and `acting_user`. Operation entries can map optional fields with `queryArg`, `contentArg`, `factsArg`, `actorArg`, `scopeArg`, `maxCharsArg`, `inputArg`, `replyArg`, `capturedAtArg`, `sourceArg`, and `idempotencyArg`. Only configured optional fields are sent, so providers can match strict MCP schemas. A provider without `scopeArg` sends the same call for every scope it serves, so QM refuses it at startup unless it serves one scope (a single scope ID such as `persona:<id>`, or the org scope, of which an instance has one) or only personal scopes, which the acting member tells apart, on routes that do not manage a notebook, because notebook reads carry no member. Providers whose operations call the same server URL and tool without `scopeArg` count as one provider here, since their calls look the same to the server. A provider routed to `channel`, `group` or `team` scopes, to several scope IDs, or to more than one scope kind maps `scopeArg` on read and write. A write with `factsArg` sends the facts under that name as a list of `{ "fact": "…", "provenance": "…" }` objects instead of `content`, where `provenance` is the scope ID of the conversation the facts came from, such as `personal:U0JORDAN`. A write operation sets `factsArg` or `contentArg`, not both. On a turn a member wrote, a read's query is the message they sent, cut to its first 2,000 characters as the notebook's recall query also cuts it, rather than the notebook's query, which opens with the turn's recent dialogue. Other turns, such as subagent results and automations, and search send their query as it is.

Read and write operations use separate OAuth client-credential pairs. Omit `write` and set route capture to `off` for a read-only provider. Recall and search time out after `timeoutMs` (3 seconds by default), because they run before every turn. Writes time out after 30 seconds, the most `timeoutMs` allows, with every batch of a split write sharing that one deadline: a write takes longer the more facts it carries, and one that times out is recorded as unknown even when the provider stored it. A deadline cancels the connection, the OAuth token request and the tool call alike, and QM stops reading any response at 1 MB, so an oversized or endless reply fails the call there. QM continues to decide readable/writable scopes and passes the acting user to the provider.

External routes fail open by default (`failOpen: true`): a failing or slow provider contributes nothing, the turn continues with the other routes, and the failure is recorded as an [outcome](#provider-outcomes). Set `failOpen: false` on a route to make it strict: any failure of that provider then fails the whole recall or search for every scope the route serves, so one provider outage stops memory there. Explicit writes report a provider failure the same way on either kind of route, as described under [Provider outcomes](#provider-outcomes), because the other routes may already have stored the facts.

Explicit writes (the `memory` tool's `add` and `POST /v1/memory/facts`) send `idempotencyArg`, when it is mapped, a UUID (RFC 9562 version 8) derived from the tenant, the turn, the notebook scope and the fact text, so a retry of the same facts to the same notebook in the same turn carries the same key. A write made outside a turn, such as one with a portal token, carries a key of its own, so only a retry within a turn is deduplicated. Automatic capture sends its own per-turn key. A write carries at most 20 facts, the limit of gbrain's `memory_write`: the `memory` tool and `POST /v1/memory/facts` refuse more, and a provider write with `factsArg` sends a larger automatic burst as consecutive calls of at most 20 facts, the second with `:1` added to the per-turn key, the third with `:2`, and so on, so a provider that replays a repeated key never takes one batch for another. Only the first call carries the turn's `inputArg` and `replyArg`. The notebook and every other route still receive the burst as one write. A result whose `structuredContent.status` is `"pending"` is recorded as pending and any other success as committed; a split write is pending when any of its batches is. A timed-out write is recorded as unknown and is not retried, because the provider may still have stored the facts.

### Attesting the member (`attestActor`)

By default an MCP provider learns who is asking only from the actor argument (`acting_user`), which it cannot tell apart from any other argument. Set `"attestActor": true` on an `mcp` provider to also send the member's canonical QM person id in the `x-qm-actor` HTTP header on every request of each call; linked principals fold into one id, as described in [principal-links.md](./principal-links.md). The model cannot set this header. The actor argument is still sent, with the same value. The field defaults to `false`, applies to reads and writes, and is rejected on `memorable` providers or when it is not a boolean. A provider should honour the header only from OAuth clients it has granted an attest right.

An attested read returns what that member alone may see, so a route to an attested provider may list only `personal` or `personal:<id>` selectors. QM refuses any other selector at startup, naming the route, because a channel, group, team or organization conversation would show one member's private memory to everyone in it. Within a personal route QM calls the provider only for that scope's own member, and only when the answer goes back to them. A read there by anyone else, by a QM system actor (`system:…`), or in a scheduled turn whose answer goes to a teammate or a channel is withheld without a call; a write there by another member, or in such a scheduled turn, is refused without a call and recorded as `denied` with code `private_only`.

QM attests only ids of 1 to 256 visible ASCII characters (`!` through `~`), the same rule the credential broker and attested MCP connectors apply. When the member's canonical id breaks it, QM makes no call and records the outcome as `denied` with code `invalid_actor`; link the member to a conforming principal id with `POST /v1/admin/principal-links`. On a strict route that denial fails every recall the route serves for that member, so keep attested routes fail-open until every member is linked. QM attests only the member a run acts for: their own turns, and scheduled runs they own. A write by a system actor, or one that changes only the notebook as described under capture policies above, is not sent to an attested provider and records no outcome for it. An attested provider also cannot manage a notebook (`manage: true`), because notebook reads for admin views carry no member.

## Provider outcomes

Every recall and search, and every explicit write through the memory tool or `POST /v1/memory/facts`, records one outcome per provider and scope. A `memorable` provider reports a CLI failure or timeout as `empty`, because its CLI returns nothing in both cases.

| Outcome                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ok`                   | The provider returned rows.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `empty`                | It returned nothing. A `code` in its structured result is kept; a read coded `actor_unlinked` is empty, and its text is ignored.                                                                                                                                                                                                                                                                                                                                   |
| `committed`, `pending` | An explicit write or forget was acknowledged; `pending` means the provider finishes it later.                                                                                                                                                                                                                                                                                                                                                                      |
| `unknown`              | A write or forget took longer than 30 seconds, or its connection broke after QM reached the provider, such as a dropped connection or an HTTP `502` (`code` then carries `http_<status>`), so whether the provider changed anything is unknown. An error reply from the provider's tool, with or without a code, is `failed`. A forget also ends here when gbrain answers a state its contract doesn't list ([Forgetting a brain fact](#forgetting-a-brain-fact)). |
| `denied`               | HTTP 401 or 403, an OAuth credential error, any result coded `actor_not_attested`, `argument_mismatch`, `scope_denied`, `insufficient_scope` or `permission_denied`, an error or write result coded `actor_unlinked`, an actor QM can't attest (`invalid_actor`), or a write to an attested provider outside its member's private QM conversation (`private_only`).                                                                                                |
| `timed_out`            | A read took longer than `timeoutMs`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `failed`               | Any other error. `code` carries the provider's error code or `http_<status>`, or `unreachable` when a write or forget never reached the provider. A failed write or forget changed nothing.                                                                                                                                                                                                                                                                        |

QM reads `code` and `status` on a successful result only from `structuredContent`, never from its text, which is memory. A result's text blocks are its memory even when they are empty; QM reads `structuredContent` as memory only from a result with no text block. An error result's code may sit in `structuredContent` or in a JSON text block, at `code` or `error.code`. A code is kept only when it is 1 to 64 letters, digits, `_`, `.`, `:` or `-`. A provider this conversation may not read is not called and records no outcome.

Where to read them:

- **Stored turns.** When providers are routed, each turn's user message item carries `body.memoryRecallOutcomes`, a list of `{ provider, scope, outcome, ms, code? }`, even when no memory text was injected or the turn failed. A strict route's recall failure fails the turn before any item is written, so that turn shows up only in the admin Errors log. Operators read it in the admin session transcript (`GET /v1/admin/sessions/:id`); member-facing transcripts hide it.
- **The `memory` tool.** Search results start with one line per problem, `[code] detail Fix: …`, followed by the hits in one `untrusted-data` block. Add results list the problems after the count of facts remembered, and add one line for each provider that answered `pending`. The stored tool result carries the same `problems`, and an add result also carries the write `outcomes`. A search with a failed provider never reports "no remembered facts", even on a strict route. A delete names each brain ref it forgot and lists the problems, and its stored result carries `deleted`, `outcomes` and `problems`.
- **HTTP.** `POST /v1/memory/search` and `POST /v1/memory/facts` answer `502` with an `application/problem+json` body: `status`, `title`, `detail` and `problems`, each `{ code, provider, detail, fix }`, plus the `results` of a search whose failing routes fail open or the `added`, `scopeId` and `outcomes` of a write. A successful write's `200` body carries `outcomes` when providers are routed. A write's `502` can follow facts the notebook already stored, so read `added` and the problems before sending the same facts again. `DELETE /v1/memory/facts` answers `200` with `ok`, `forgotten`, `scopeId` and, for brain refs, `outcomes`, or `502` with the problems plus `forgotten`, `scopeId` and `outcomes`. A forget QM refuses is `403` and changes nothing.

Problem codes are `memory_provider_denied` (a refused write or forget changed nothing), `memory_provider_failed` (a failed write or forget changed nothing, and a failed search is missing that provider's results), `memory_provider_timeout` (a search timed out) and `memory_provider_unknown` (whether a write or forget landed is unknown, and the detail says so). A failure of the built-in notebook is not a provider problem: it stays QM's own error, as before.

## Automatic capture timing

Post-turn capture waits for a conversation to go quiet. QM buffers consecutive turns from the same member in the same conversation and extracts facts once no new turn arrives for `MEMORY_CAPTURE_QUIET_MS` (180000, three minutes, by default) or after `MEMORY_CAPTURE_MAX_TURNS` turns (10). Set `MEMORY_CAPTURE_QUIET_MS=0` to capture after every turn. A fact stated in one turn can therefore take three minutes to reach a provider, and the buffer lives in the instance's memory, so a restart or deploy during the quiet period drops the buffered turns.

## gbrain

[gbrain](https://github.com/garrytan/gbrain) keeps each member's facts in a brain their other agents share. This recipe sends personal recall and explicit writes to it and keeps QM's notebook as the first route for every scope.

Pinned versions:

- **gbrain:** the `qm-memory-provider` v3 contract from release `v0.60.655.0` (`79781ec0`) or later. QM vendors it at [`test/fixtures/gbrain/qm-memory-provider-v3.json`](../test/fixtures/gbrain/README.md).
- **QM:** the commit that added `factsArg` or later.

The examples follow one invented member, Jordan. Jordan's Slack user id is `U0JORDAN`, and their web sign-in `jordan@acme.example` is linked to it with `POST /v1/admin/principal-links`, so QM sends `U0JORDAN` from both surfaces. On the brain host, register a recall client and a write client, grant both the attest right for QM, and link Jordan's canonical id to their member:

```bash
gbrain auth register-client qm-recall --grant-types client_credentials --scopes read
gbrain auth register-client qm-write --grant-types client_credentials --scopes write
gbrain auth rescope --client <qm-recall client id> --attest-actor qm
gbrain auth rescope --client <qm-write client id> --attest-actor qm
gbrain access member add jordan
gbrain access member link jordan --qm U0JORDAN
```

Set the four client values as `GBRAIN_RO_CLIENT_ID`, `GBRAIN_RO_CLIENT_SECRET`, `GBRAIN_RW_CLIENT_ID` and `GBRAIN_RW_CLIENT_SECRET`, and this document as `MEMORY_PROVIDER_CONFIG`:

```json
{
  "providers": [
    {
      "id": "gbrain",
      "type": "mcp",
      "url": "https://gbrain.acme.example",
      "attestActor": true,
      "timeoutMs": 3000,
      "read": {
        "tool": "memory_recall",
        "clientIdEnv": "GBRAIN_RO_CLIENT_ID",
        "clientSecretEnv": "GBRAIN_RO_CLIENT_SECRET",
        "maxCharsArg": "max_chars"
      },
      "write": {
        "tool": "memory_write",
        "clientIdEnv": "GBRAIN_RW_CLIENT_ID",
        "clientSecretEnv": "GBRAIN_RW_CLIENT_SECRET",
        "factsArg": "facts",
        "idempotencyArg": "idempotency_key"
      }
    }
  ],
  "routes": [
    { "provider": "default", "scopes": ["personal", "channel", "group", "team", "org"], "capture": "automatic" },
    {
      "provider": "gbrain",
      "scopes": ["personal"],
      "capture": "explicit",
      "manage": false,
      "failOpen": true,
      "label": "gbrain"
    }
  ]
}
```

What this does:

- Every scope keeps QM's notebook first, with automatic capture, so nothing QM remembers today moves.
- In Jordan's DM, QM calls `memory_recall` with `query`, `max_chars: 6000` and `acting_user: "U0JORDAN"`, and sends `x-qm-actor: U0JORDAN` on every request. gbrain answers with Jordan's own recent facts and the facts Jordan may read, one per line, which appear under a `### … · gbrain` heading. Channel, group, team and org turns never call gbrain: its first release serves one member at a time and refuses a channel audience.
- The `memory` tool's add and `POST /v1/memory/facts` in Jordan's DM write to the notebook and to `memory_write` as `{ "facts": [{ "fact": "…", "provenance": "personal:U0JORDAN" }], "idempotency_key": "<UUID>", "acting_user": "U0JORDAN" }`. gbrain saves them on Jordan's own page, readable by Jordan alone, and answers a repeated key with its first receipt. One call carries at most 20 facts, gbrain's limit (the `memory` tool and `POST /v1/memory/facts` refuse more), and `provenance` is cut to gbrain's 200 characters. Automatic capture stays with the notebook.
- gbrain ranks facts on the first 2,000 characters of the question, and without embeddings on its first 12 distinct content words. QM asks with Jordan's message alone, with no label, so recall ranks on what Jordan asked rather than on the turn's recent dialogue.
- `failOpen: true` keeps turns answering from the notebook when gbrain is down or slow, and records the failure as an outcome. `timeoutMs: 3000` is generous: recall's p95 was 49 ms on a local Postgres brain, OAuth token and MCP session included. It bounds recall only: a 20-fact `memory_write` took 1.9 to 3.0 s on a local Postgres brain, so writes get 30 seconds.
- Forgetting or editing a fact changes only the notebook, because the gbrain route sets `manage: false` and the recipe has no forget operation, so search shows the recipe's facts without a ref and QM can't forget them. gbrain keeps the original and recalls it in later turns; withdraw it on the brain host with `gbrain forget <fact-id>`, or connect the brain through the [memory registry](#memory-registry), whose brains forget by ref ([Forgetting a brain fact](#forgetting-a-brain-fact)).
- No gbrain MCP connector is registered. A connector would let the model call gbrain's other tools outside the attested route.

### Verify

1. **The tools match.** With the recall client's credentials, list gbrain's tools:

   ```bash
   TOKEN=$(curl -s https://gbrain.acme.example/token -d grant_type=client_credentials \
     --data-urlencode "client_id=$GBRAIN_RO_CLIENT_ID" --data-urlencode "client_secret=$GBRAIN_RO_CLIENT_SECRET" | jq -r .access_token)
   curl -s https://gbrain.acme.example/mcp -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' |
     sed -n 's/^data: //p' | jq -c '.result.tools[] | select(.name == "memory_recall") | {name, args: (.inputSchema.properties | keys)}'
   ```

   Expected: `{"name":"memory_recall","args":["acting_user","max_chars","query"]}`. The same with the write client and `memory_write` prints `{"name":"memory_write","args":["acting_user","facts","idempotency_key"]}`.

2. **A fact Jordan states in a DM reaches gbrain.** In Jordan's DM, say "Remember that I prefer aisle seats." The `memory` tool answers `Remembered 1 fact.`, and in the admin transcript (`GET /v1/admin/sessions/:id`) its result's `outcomes` include `{ "provider": "gbrain", "outcome": "committed" }`.
3. **A new conversation recalls it.** Start a new DM thread and ask "Which seat do I prefer?". The turn's user entry carries `payload.memoryRecallOutcomes` with `{ "provider": "gbrain", "scope": "personal:U0JORDAN", "outcome": "ok" }`, and the reply mentions the aisle seat.
4. **No recall failures.** `grep -c '\[memory\] gbrain recall failed'` over core's log prints `0`.
5. **Channels don't call gbrain.** Ask the same question in a channel Jordan is in. That turn's `memoryRecallOutcomes` has no `gbrain` entry.

## Troubleshooting

| Symptom                                                                                          | Cause                                                                                                                                                               | Fix                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup fails with `… url (https://host) must not carry credentials or a #fragment`              | The provider URL has `user:pass@` or a `#fragment`.                                                                                                                 | Move credentials to the `clientIdEnv`/`clientSecretEnv` variables and drop the fragment.                                                        |
| Startup fails with `… must use HTTPS or a recognized private HTTP host`                          | Plain HTTP to a public host.                                                                                                                                        | Use `https://`, or HTTP on `localhost`, `127.0.0.1`, `*.internal`, `*.flycast`, `*.local` or an origin in `PRIVATE_NETWORK_ALLOWED_ORIGINS`.    |
| Startup fails with `… is not a valid URL (value not shown)`                                      | The URL does not parse; QM never echoes it, since it may hold secrets.                                                                                              | Check the value of `url` in `MEMORY_PROVIDER_CONFIG`.                                                                                           |
| Startup fails with `… may serve only personal scopes`                                            | A route to an attested provider lists `org`, `channel`, `group` or `team` scopes.                                                                                   | Narrow that route's `scopes` to `personal` or `personal:<id>`, or drop `attestActor` if unneeded.                                               |
| Startup fails with `… no scopeArg, so the server cannot tell apart the scopes it serves`         | Unscoped operations on one server tool serve a `channel`, `group` or `team` kind, several scope IDs, a mix of kinds, or personal scopes with `manage`.              | Set `scopeArg` on the provider's `read` and `write`.                                                                                            |
| Outcome `denied` with `http_401`, `http_403` or an OAuth code such as `invalid_client`           | The provider rejected QM's OAuth client.                                                                                                                            | Check the client id and secret variables and the client's grant on the provider.                                                                |
| Outcome `denied` with `actor_not_attested`                                                       | `attestActor` is set but the provider has not granted QM's client the attest right.                                                                                 | Grant that client the attest right on the provider.                                                                                             |
| Outcome `denied` with `scope_denied` or `insufficient_scope`                                     | QM's OAuth client lacks the scope the provider's tool needs. gbrain also answers `scope_denied` to a write when the member's page lists readers besides the member. | Grant that client the scope on the provider, such as `write` for a write tool. On gbrain, make the member's page readable by that member alone. |
| Startup fails with `memory route N: provider P sets attestActor, so it cannot manage a notebook` | Notebook reads carry no member, so an attested provider cannot serve them.                                                                                          | Set `"manage": false` on that route and keep the `default` route first.                                                                         |
| Outcome `denied` with `invalid_actor`                                                            | The member's canonical id is not 1 to 256 visible ASCII characters, so QM made no call.                                                                             | Link the member to a conforming principal id with `POST /v1/admin/principal-links`.                                                             |
| Outcome `denied` with `private_only`                                                             | A write to an attested provider came from another member or a turn answering somebody else, so QM made no call.                                                     | Save it from the member's own private conversation with QM.                                                                                     |
| Outcome `empty` or `denied` with `actor_unlinked`                                                | The provider has no member linked to this QM person id.                                                                                                             | Link the QM person id to their member on the provider.                                                                                          |
| Outcome `timed_out`                                                                              | A read took longer than `timeoutMs`.                                                                                                                                | Raise `timeoutMs` (up to 30000) or fix the provider's latency.                                                                                  |
| Write outcome `unknown`                                                                          | A write took longer than 30 seconds, or its connection broke after QM reached the provider.                                                                         | Fix the provider's latency, and check whether the write landed before repeating it.                                                             |
| Outcome `failed`, including `server_error` from the provider's token endpoint                    | Wrong tool name, schema mismatch, a provider error, or its OAuth server failing.                                                                                    | Check the provider's logs and the `tool` and `*Arg` mappings.                                                                                   |
| Outcome `failed` with `malformed_fact`                                                           | The answer's `structuredContent.facts` is not a list, or an entry lacks a string `id` or `text`, or its `id` is empty or holds whitespace.                          | Fix the provider's `facts`; QM uses none of that answer.                                                                                        |
| New facts reach the provider minutes late                                                        | Automatic capture waits `MEMORY_CAPTURE_QUIET_MS`.                                                                                                                  | Lower `MEMORY_CAPTURE_QUIET_MS`, or use explicit writes.                                                                                        |

## Migrating from the retired `BRAIN_*` variables

Earlier releases wired an external knowledge server through `BRAIN=mcp`, `BRAIN_MCP_URL`, `BRAIN_QUERY_TOOL`, and the `BRAIN_RO_*`/`BRAIN_RW_*` OAuth client pairs, exposing `read_brain` and `write_brain` tools. Those variables are ignored. Express the same server as an `mcp` provider above: `url` takes the old `BRAIN_MCP_URL`, `read.tool` the old `BRAIN_QUERY_TOOL`, and `read`/`write` name the env variables holding each OAuth client pair. Static bearer tokens (`BRAIN_AUTH=bearer`) have no equivalent; the provider framework authenticates with client credentials only.

## Procedural memory (Memorable)

A provider with `type: "memorable"` records _procedures_ rather than facts: when a turn's
automatic capture fires, QM derives a deterministic tool-call trace from the session (which
files changed, which commands verified the work), redacts any secret values, and hands it to
the [Memorable](https://memorable.sh) CLI with `memorable record`. Recall runs `memorable inject`
with the turn's task and appends the returned pointer to the prompt. No model is involved in
either direction.

```json
{
  "providers": [{ "id": "procedures", "type": "memorable" }],
  "routes": [
    { "provider": "default", "scopes": ["personal", "channel", "group", "team", "org"], "capture": "automatic" },
    { "provider": "procedures", "scopes": ["personal"], "capture": "automatic", "manage": false, "label": "Procedures" }
  ]
}
```

Options: `bin` (default `memorable`; a string or an argv array such as `["node", "/opt/memorable/cli.js"]`),
`passEnv` (extra environment variable names to hand the CLI, e.g. `["MEMORABLE_STORE_KEY"]`),
`injectTimeoutMs` (default 15000) and `recordTimeoutMs` (default 120000). The CLI is not bundled:
install it with `npm i -g memorable-cli@latest` — the `qm` backend needs 0.5.9 or newer, and an
npm `min-release-age` setting can silently pick an older release, so check `memorable --version`
(its `qm` backend also needs the `pg` package resolvable
from QM's working directory). Recording calls the Memorable extraction service, so set both
`MEMORABLE_API_URL` and `MEMORABLE_API_KEY`; recall is local. Consent is the CLI's own act, per
scope: nothing is recorded for a scope until `memorable enable --scope <scope-id>` has been run
with the same `MEMORABLE_BACKEND=qm` and `MEMORABLE_DB_URL`. It sees only an allow-listed environment —
`MEMORABLE_*`, `PATH`, `HOME`, proxy and TLS variables — with `MEMORABLE_BACKEND` defaulting to
`qm` and the database reachable solely as `MEMORABLE_DB_URL`. Routes to this provider accept
`capture: "automatic"` or `"off"`; explicit `remember` writes are facts, not procedures, and are
left to the notebook. A consent refusal from the CLI is reported as a capture error; like any
external route it fails open by default, so the notebook write still lands and the refusal is logged. The provider never exposes a notebook, so keep `manage: false` and let
`default` handle editing.

## Memory registry

Org admins can register personal-memory brains and bind members to them at runtime, and a member can connect a brain of their own, without a redeploy. QM keeps every brain and binding, and the org's member-brain switch, in one Postgres record (table `memory_registry`, row `org`), so a change reaches every instance, blue-green included, on its next memory operation. Each operation reads the record's version and holds one snapshot for the whole operation, so a deleted binding is never served from a cache.

The record's `schema` is `2` while it holds a member's brain and `1` otherwise. Builds from before member brains read only schema 1, so a build on the far side of a deploy or rollback never serves a member's brain without the guarded fetch or the org switch. That fails closed, and it has a cost: an instance on such a build keeps serving the last record it loaded, and one that starts fresh serves no registry brain at all, org brains included, until the record is back at schema 1. Deletions freeze there too: an org binding an admin deletes keeps serving on such an instance until it's replaced. Before you roll back past member brains, delete every member's brain on the current build: members with `DELETE /v1/memory/brain`, or an admin with `DELETE /v1/admin/memory-registry/bindings/:id` and then `/brains/:id` for each brain that has an `owner`. The record returns to schema 1, and org brains keep serving on the older build. If an instance already rolled back, roll forward, delete them, then roll back again.

`MEMORY_PROVIDER_CONFIG` keeps its grammar and meaning. It becomes a read-only overlay: the API can't change it, and a registry brain can't reuse one of its provider ids. Routes run in this order: the env var's routes (or, with no env var, the default notebook route for every scope kind, with automatic capture, editing and fail-closed recall), then registry bindings. Registry bindings never manage a notebook, so a first binding never takes notebook memory away from anyone.

### Brains and bindings

A brain is one MCP endpoint plus one OAuth client-credentials pair, used for reads and writes, and it always attests the member (`attestActor`). Its `preset` names how QM calls the brain; this build knows `gbrain-v1`, which follows gbrain's contract at the [pinned version](#gbrain). A binding connects a brain to the kind `personal` (every member) or to one member's personal scope (`personal:<principal id>`). Shared scopes (channels, teams, the org and groups) can't be bound yet: that needs a gbrain contract that reads a shared scope as the scope.

A scope binds to a brain once, and a binding for the kind `personal` already covers every member's scope, so a brain bound to the kind can't also take a binding for one member, or the reverse. Capture is `off` or `explicit`; automatic capture into a brain isn't available yet.

A brain's `url` must be a public `https://` address. QM refuses plain HTTP and any loopback or private host, such as `localhost`, `127.0.0.1`, `10.x`, `*.internal` or `*.local`, when the brain is registered (400), and it calls every registry brain the way it calls an admin-registered MCP server: on the address actually dialed, it refuses one that is loopback, link-local, private or unspecified, and it rejects HTTP redirects ([MCP connectors](./mcp-connectors.md)). A brain on a private network, such as one beside QM on a Docker network, belongs in `MEMORY_PROVIDER_CONFIG`, which only whoever deploys QM can set.

QM is always an MCP client of gbrain and never gets gbrain's database URL or its owner admin token. The brain's operator provisions the client, the attest right and member links; QM only binds members to what was provisioned.

### Forgetting a brain fact

A member can have QM forget a fact that a [registry brain](#memory-registry) holds, their own brain included. Search shows each brain fact with a ref such as `acme:4821`: the brain's id, then gbrain's fact id. The `memory` tool's `delete` and `DELETE /v1/memory/facts` take notebook `#ids` and brain refs together. QM checks every ref first, so a call it refuses changes nothing; then it deletes the notebook ids together and forgets each ref on its own, with its own result. A fact saved in both stores is forgotten by passing its `#id` and its ref.

QM sends a ref to the brain only when a binding that isn't disabled serves the conversation's notebook, and the member sent the turn in their own DM with QM, or the turn is work QM runs for such a turn, such as its subagents. The web app's first-visit greeting counts as a turn the member sent: QM starts it in the member's own DM when they open the app, with the member's live claims, so it passes every gate for turns a member sent, this one included. Everywhere else QM refuses before anything reaches the brain, with `[error]` in the tool and `403` over HTTP, and nothing changes: in a channel or group, through an admin route, through a member's own edits at `/v1/memory`, in the nightly tidy, on a brain the [gbrain recipe](#gbrain) connects (its facts show no ref), and on turns a bot or an automation such as a cron, webhook or background watch started, even in the member's own DM.

The call is `forget_fact` with `{ "id": <fact id>, "request_id": "<UUID>" }` and the member in `x-qm-actor`. gbrain forgets only a fact on the member's own page; any other id is `fact_not_found`. Search can still show a ref on a fact from another page the member may read, because gbrain's recall doesn't say which page a fact is on, so gbrain refuses to forget it. The request id comes from the session and the tool call (over HTTP, the agent run), so a retry of the same call gets gbrain's first receipt back instead of forgetting twice.

Each ref gets its own result:

| Result                              | Meaning                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Done (`committed`)                  | gbrain forgot it, or had already forgotten it (`fact_already_expired`). The tool lists every ref it forgot on one line, such as `Forgot acme:4821, acme:4822.`                                                                                         |
| Pending (`pending`)                 | gbrain accepted it and finishes it on its own, because it answered a state that isn't final yet, such as `queued`. The tool says `Accepted forgetting acme:4821; the brain finishes it later.`                                                         |
| Unknown (`memory_provider_unknown`) | The call timed out or its response was lost after QM reached the brain, or gbrain answered a state its contract doesn't list. gbrain may have forgotten it, so check its write log before deleting it again.                                           |
| Failed (`memory_provider_failed`)   | gbrain refused it (`fact_not_found`) or ended it `conflict`, `failed` or `cancelled`, or QM couldn't open a session with the brain, so the call was never sent (`unreachable`, or `http_<status>` from a proxy in front of it). Nothing changed there. |
| Refused (`memory_provider_denied`)  | The brain's operator hasn't allowed QM to forget (`actor_not_attested`, see below). Nothing changed.                                                                                                                                                   |

Refs from one brain with the same result and code share one problem line in the tool and one entry in `problems` over HTTP, while `outcomes` keeps one entry per ref.

An edit changes the notebook only. A brain copy that search shows as `(also acme:4821)` keeps the old wording until it's deleted by its ref.

gbrain keeps a forgotten claim withdrawn, so it refuses to save the exact same claim again (`invalid_params`). The notebook still saves it, and the tool shows gbrain's refusal as a `memory_provider_failed` problem line.

**Operator step.** gbrain doesn't let QM's client forget facts by default. On the brain host, add `forget_fact` to the client's attested operations. The list replaces gbrain's default, so keep the default three in it:

```bash
gbrain auth rescope --client <client id> --attest-actor qm --attest-ops forget_fact,get_write_request,memory_recall,memory_write
```

### A member's own brain

A member who runs their own gbrain connects it as their personal memory from chat: the agent calls `PUT /v1/memory/brain` as them, on a turn they sent. QM registers it as a brain they own (`owner`, their canonical principal id), under an id derived from that id, with the `gbrain-v1` preset, and binds it to their own personal scope only, with `explicit` capture. Nobody can bind it to another scope, and the body can't name another owner. On their gbrain they need a confidential client-credentials client that may attest an actor, and a link from their gbrain member to the `principalId` that `GET /v1/memory/brain` returns.

A member's brain gets the same transport as one an admin registered ([Brains and bindings](#brains-and-bindings)), and that covers its OAuth token request too. QM never leaves `https` for an `https` MCP server, so a brain's OAuth metadata can't point the token request, and the client secret in it, at an `http://` endpoint.

A member's `url`, `clientId` and `label` together can be at most 8,000 characters, the request-target length RFC 9110 asks HTTP software to accept, so a member's brain never outgrows what one URL may carry. The client secret a link saves for a member's brain has the same 8,000-character limit. Every instance reloads the whole record after each change, and a single member save could otherwise add up to the API's 1,000,000-byte body limit to it. A save that changes nothing writes nothing.

An org admin's switch, `PUT /v1/admin/memory-registry/member-brains` with `{"enabled": false}`, stops every member's brain at once (code `member_brains_off`) and refuses new ones, without deleting them; `{"enabled": true}` turns them back on. It defaults on.

| Route                     | Body or result                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/memory/brain`    | `principalId`, `memberBrains` (the switch), the member's `brain` and `binding` (or `null`) and their `disabled` rows   |
| `PUT /v1/memory/brain`    | `url`, `clientId`, and optionally `label`; `clientSecret` is refused. Audited as `memory-registry.member-brain.update` |
| `DELETE /v1/memory/brain` | Deletes the brain and its binding. Audited as `memory-registry.member-brain.delete`                                    |

These routes take only an agent capability from a turn the member sent (never a triggered one), refuse inactive members, and are blocked like any other control-plane change in a strict conversation. Their replies show the brain's `url`, client id and binding, so they answer only in the member's DM or in a conversation whose sharing is open. An admin can still change or delete a member's brain through the admin API outside chat; its `owner` never changes. A member has no route outside chat to their brain, so their own agent may change its `url` or disconnect it on a turn they sent. A new `url` clears the brain's secret, and the fresh brain link's form shows the new origin before they enter the secret again.

### API

Every `/v1/admin/memory-registry` route needs an org admin and is audited. Every reply carries registry entries, so an admin's agent reads or changes the registry only in the admin's DM or in a conversation whose sharing is open. Outside chat, an org admin calls these routes from an administrator session in the web UI behind the portal (`/api/admin/memory-registry/...`). Client secrets are write-only and read back as `hasClientSecret`; QM stores them encrypted with a key derived from `CONNECTOR_SECRET_KEY`, exactly as sent, and changing a brain's `url` clears its secret. A request that sets `clientSecret` must also send the brain's `url` (400 otherwise), so a secret goes only to a destination the admin names. An admin's agent can register a brain and change bindings, but it never sends a `clientSecret` or changes an existing brain's `url` (QM refuses both with 400), and it can't delete a brain or binding (403). A binding carries memory only once its brain holds a secret, and a secret is never set in chat. So QM calls no brain an agent registered until an admin sets its secret outside chat, and only an admin outside chat can move or remove an org brain that holds one. An agent's binding to a brain that already holds a secret serves on the next memory operation, within the member links the brain's operator provisioned. A member's own brain is the one exception, described above.

An agent can register a brain for an admin, or connect a member's own, but never carries its client secret. On that person's own turn it mints a brain link with `POST /v1/keychain/drops` and body `{"memoryBrain": "<brain id>", "purpose": "…"}`. The single-use form shows the brain, its origin and who is bound to it, and writes the secret straight into the registry, audited as `memory-registry.brain.secret`. It never enters a keychain, can't be granted and never reaches the agent's computer. Only an org admin, or the member who owns the brain while member brains are on, can mint or use one. The link stops working if the brain's `url` changes or the person who minted it can no longer set the secret.

| Route                                           | Body or result                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/admin/memory-registry`                 | `memberBrains`, `brains`, `bindings`, `disabled` (each binding that isn't serving, with its code) and `overlay` (env ids) |
| `PUT /v1/admin/memory-registry/brains/:id`      | `preset`, `url`, `clientId`, `clientSecret`, `label`, and optionally `timeoutMs`                                          |
| `DELETE /v1/admin/memory-registry/brains/:id`   | Refused while the brain has a binding                                                                                     |
| `PUT /v1/admin/memory-registry/bindings/:id`    | `brain`, `scope`, and optionally `capture`, `recall`, `failOpen`, `label`                                                 |
| `DELETE /v1/admin/memory-registry/bindings/:id` | Deletes the binding                                                                                                       |
| `PUT /v1/admin/memory-registry/member-brains`   | `enabled`: turns members' own brains on or off                                                                            |

`GET` on `/brains/:id` and `/bindings/:id` returns one entry with its `disabled` rows.

### Disabled bindings

A binding that QM can't serve contributes nothing, and every recall, search or explicit write for its scope records outcome `disabled` with one of these codes (problem `memory_provider_disabled`), except `id_taken`, whose id belongs to the env provider. `GET /v1/admin/memory-registry` shows each one, with a `detail` for `invalid_config`.

| Code                | Cause                                                                                                                                                            | Fix                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `secret_missing`    | The brain has no client secret, for example after its `url` changed.                                                                                             | Set the brain's client secret.                                     |
| `preset_unknown`    | This QM build doesn't know the brain's preset, for example during a rollback.                                                                                    | Upgrade QM, or change the preset.                                  |
| `id_taken`          | `MEMORY_PROVIDER_CONFIG` now defines a provider with the brain's id. That provider keeps serving its own routes, and the binding records no outcome.             | Re-register the brain under another id.                            |
| `member_brains_off` | The brain belongs to a member and an org admin turned member brains off.                                                                                         | Turn member brains back on, or leave it off.                       |
| `invalid_config`    | The entry breaks a provider rule, such as the URL rule under [Troubleshooting](#troubleshooting), or its secret was stored under another `CONNECTOR_SECRET_KEY`. | Read its `detail`, then fix or delete it, or set the secret again. |

A stored record this build can't read leaves the last valid snapshot serving; an instance that starts on such a record serves the env routes only. To roll back, delete registry bindings first, then revert QM; the table is never dropped. Before you run a build from before member brains, delete every member's brain as [Memory registry](#memory-registry) describes.
