# Memory providers

QM keeps its built-in notebook memory unless `MEMORY_PROVIDER_CONFIG` defines a scope-aware provider router. Routes independently select where each scope recalls from, accepts explicit writes, and receives automatic post-turn capture.

## Prompt memory

Each turn carries at most 6,000 characters of memory, selected across every notebook
the conversation may read and every provider routed to it. Each notebook, and each external
provider within it, gets its own heading and its own ```untrusted-data block. Recalled text is
reference data, never instructions: QM escapes triple backticks and closing tags (`</` becomes
`<\/`) and prefixes heading-like lines (`#` alone or followed by a space, tab or another `#`, even when indented) with a backslash, so a recalled row cannot close its
block, end the `<environment>` section or pose as a heading. With PostgreSQL and an embedding
model, facts are ranked by exact cosine similarity to the current message and recent
dialogue; otherwise the newest facts come first. Later turns add only newly selected facts.
Provider rows without fact ids are compared by content hash. An MCP provider's answer becomes one
row per line, so it should return one self-contained fact per line; a `memorable` procedure block
stays one row. Only new rows are added, a row already shown stays counted while its provider keeps
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

MCP reads receive `query` and `acting_user` by default. Writes receive `content` and `acting_user`. Operation entries can map optional fields with `queryArg`, `contentArg`, `actorArg`, `scopeArg`, `maxCharsArg`, `inputArg`, `replyArg`, `capturedAtArg`, `sourceArg`, and `idempotencyArg`. Only configured optional fields are sent, so providers can match strict MCP schemas.

Read and write operations use separate OAuth client-credential pairs. Omit `write` and set route capture to `off` for a read-only provider. Provider calls time out after `timeoutMs` (3 seconds by default). QM continues to decide readable/writable scopes and passes the acting user to the provider.

External routes fail open by default (`failOpen: true`): a failing or slow provider contributes nothing, the turn continues with the other routes, and the failure is recorded as an [outcome](#provider-outcomes). Set `failOpen: false` on a route to make it strict: any failure of that provider then fails the whole recall or search for every scope the route serves, so one provider outage stops memory there. Explicit writes report a provider failure the same way on either kind of route, as described under [Provider outcomes](#provider-outcomes), because the other routes may already have stored the facts.

Explicit writes (the `memory` tool's `add` and `POST /v1/memory/facts`) send `idempotencyArg`, when it is mapped, a UUID (RFC 9562 version 8) derived from the tenant, the turn, the notebook scope and the fact text, so a retry of the same facts to the same notebook in the same turn carries the same key. A write made outside a turn, such as one with a portal token, carries no key. Automatic capture keeps sending its own per-turn key. A result whose `structuredContent.status` is `"pending"` is recorded as pending and any other success as committed. A timed-out write is recorded as unknown and is not retried, because the provider may still have stored the facts.

### Attesting the member (`attestActor`)

By default an MCP provider learns who is asking only from the actor argument (`acting_user`), which it cannot tell apart from any other argument. Set `"attestActor": true` on an `mcp` provider to also send the member's canonical QM person id in the `x-qm-actor` HTTP header on every request of each call; linked principals fold into one id, as described in [principal-links.md](./principal-links.md). The model cannot set this header. The actor argument is still sent, with the same value. The field defaults to `false`, applies to reads and writes, and is rejected on `memorable` providers or when it is not a boolean. A provider should honour the header only from OAuth clients it has granted an attest right.

QM attests only ids of 1 to 256 visible ASCII characters (`!` through `~`), the same rule the credential broker and attested MCP connectors apply. When the member's canonical id breaks it, QM makes no call and records the outcome as `denied` with code `invalid_actor`; link the member to a conforming principal id with `POST /v1/admin/principal-links`. On a strict route that denial fails every recall the route serves for that member, so keep attested routes fail-open until every member is linked. A write that carries no member at all, such as QM's own note about missing channel history, is not sent to an attested provider.

## Provider outcomes

Every recall and search, and every explicit write through the memory tool or `POST /v1/memory/facts`, records one outcome per provider and scope. A `memorable` provider reports a CLI failure or timeout as `empty`, because its CLI returns nothing in both cases.

| Outcome                | Meaning                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                   | The provider returned rows.                                                                                                                                                                               |
| `empty`                | It returned nothing. A `code` in its structured result is kept; a read coded `actor_unlinked` is empty, and its text is ignored.                                                                          |
| `committed`, `pending` | An explicit write was acknowledged; `pending` means the provider finishes it later.                                                                                                                       |
| `unknown`              | A write timed out, so whether the provider stored anything is unknown.                                                                                                                                    |
| `denied`               | HTTP 401 or 403, an OAuth credential error, any result coded `actor_not_attested` or `argument_mismatch`, an error or write result coded `actor_unlinked`, or an actor QM can't attest (`invalid_actor`). |
| `timed_out`            | A read took longer than `timeoutMs`.                                                                                                                                                                      |
| `failed`               | Any other error. `code` carries the provider's error code or `http_<status>`.                                                                                                                             |

QM reads `code` and `status` on a successful result only from `structuredContent`, never from its text, which is memory. An error result's code may sit in `structuredContent` or in a JSON text block, at `code` or `error.code`. A code is kept only when it is 1 to 64 letters, digits, `_`, `.`, `:` or `-`. A provider this conversation may not read is not called and records no outcome.

Where to read them:

- **Stored turns.** When providers are routed, each turn's user entry carries `payload.memoryRecallOutcomes`, a list of `{ provider, scope, outcome, ms, code? }`, even when no memory text was injected or the turn failed. A strict route's recall failure fails the turn before any entry is written, so that turn shows up only in the admin Errors log. Operators read it in the admin session transcript (`GET /v1/admin/sessions/:id`); member-facing transcripts hide it.
- **The `memory` tool.** Search results start with one line per problem, `[code] detail Fix: …`, followed by the hits in one `untrusted-data` block. Add results list the problems after the count of facts remembered, and add one line for each provider that answered `pending`. The stored tool result carries the same `problems`, and an add result also carries the write `outcomes`. A search with a failed provider never reports "no remembered facts", even on a strict route.
- **HTTP.** `POST /v1/memory/search` and `POST /v1/memory/facts` answer `502` with an `application/problem+json` body: `status`, `title`, `detail` and `problems`, each `{ code, provider, detail, fix }`, plus the `results` of a search whose failing routes fail open or the `added`, `scopeId` and `outcomes` of a write. A successful write's `200` body carries `outcomes` when providers are routed. A write's `502` can follow facts the notebook already stored, so read `added` and the problems before sending the same facts again.

Problem codes are `memory_provider_denied` (a refused write stored nothing), `memory_provider_timeout` and `memory_provider_failed` (whether a write landed is unknown, and the detail says so). A failure of the built-in notebook is not a provider problem: it stays QM's own error, as before.

## Automatic capture timing

Post-turn capture waits for a conversation to go quiet. QM buffers consecutive turns from the same member in the same conversation and extracts facts once no new turn arrives for `MEMORY_CAPTURE_QUIET_MS` (180000, three minutes, by default) or after `MEMORY_CAPTURE_MAX_TURNS` turns (10). Set `MEMORY_CAPTURE_QUIET_MS=0` to capture after every turn. A fact stated in one turn can therefore take three minutes to reach a provider, and the buffer lives in the instance's memory, so a restart or deploy during the quiet period drops the buffered turns.

## Troubleshooting

| Symptom                                                                                | Cause                                                                                   | Fix                                                                                                                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Startup fails with `… url (https://host) must not carry credentials or a #fragment`    | The provider URL has `user:pass@` or a `#fragment`.                                     | Move credentials to the `clientIdEnv`/`clientSecretEnv` variables and drop the fragment.                                   |
| Startup fails with `… must use HTTPS or a recognized private HTTP host`                | Plain HTTP to a public host.                                                            | Use `https://`, or HTTP only on `localhost`, `127.0.0.1`, `*.internal`, `*.flycast` or `*.local`.                          |
| Startup fails with `… is not a valid URL (value not shown)`                            | The URL does not parse; QM never echoes it, since it may hold secrets.                  | Check the value of `url` in `MEMORY_PROVIDER_CONFIG`.                                                                      |
| Outcome `denied` with `http_401`, `http_403` or an OAuth code such as `invalid_client` | The provider rejected QM's OAuth client.                                                | Check the client id and secret variables and the client's grant on the provider.                                           |
| Outcome `denied` with `actor_not_attested`                                             | `attestActor` is set but the provider has not granted QM's client the attest right.     | Grant that client the attest right on the provider.                                                                        |
| Outcome `denied` with `invalid_actor`                                                  | The member's canonical id is not 1 to 256 visible ASCII characters, so QM made no call. | Link the member to a conforming principal id with `POST /v1/admin/principal-links`.                                        |
| Outcome `empty` or `denied` with `actor_unlinked`                                      | The provider has no member linked to this QM person id.                                 | Link the QM person id to their member on the provider.                                                                     |
| Outcome `timed_out` or write `unknown`                                                 | The provider took longer than `timeoutMs`.                                              | Raise `timeoutMs` (up to 30000) or fix the provider's latency; check whether a timed-out write landed before repeating it. |
| Outcome `failed`, including `server_error` from the provider's token endpoint          | Wrong tool name, schema mismatch, a provider error, or its OAuth server failing.        | Check the provider's logs and the `tool` and `*Arg` mappings.                                                              |
| New facts reach the provider minutes late                                              | Automatic capture waits `MEMORY_CAPTURE_QUIET_MS`.                                      | Lower `MEMORY_CAPTURE_QUIET_MS`, or use explicit writes.                                                                   |

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
