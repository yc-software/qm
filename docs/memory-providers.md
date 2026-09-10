# Memory providers

QM keeps its built-in notebook memory unless `MEMORY_PROVIDER_CONFIG` defines a scope-aware provider router. Routes independently select where each scope recalls from, accepts explicit writes, and receives automatic post-turn capture.

## Built-in semantic recall (prototype)

Configure an OpenAI-compatible embeddings endpoint to rank the built-in notebook's
facts by cosine similarity instead of injecting its last 6,000 characters:

```bash
MEMORY_EMBEDDING_URL=https://your-provider.example/v1/embeddings
MEMORY_EMBEDDING_MODEL=your-embedding-model
MEMORY_EMBEDDING_API_KEY=your-provider-key
```

All three settings are required together. They configure the core, not the agent
computer. The configured provider receives memory text and the retrieval query;
choose an endpoint approved to handle that data. No provider is selected implicitly.
Without these settings, existing recall behavior is unchanged. External memory
providers retain their existing behavior.

- Text remains authoritative. The index stores normalized vectors keyed by fact
  content hash and notebook scope in the existing `memory_vectors` durable map
  (Postgres JSONB when `DATABASE_URL` is configured; in-process otherwise).
  This prototype uses an exact scan of **one authorized notebook**, not a separate
  vector database or approximate-nearest-neighbor index.
- Indexing is lazy: the next recall embeds missing/changed facts in batches of 64,
  reuses unchanged vectors, and prunes removed ones. Completed batches are saved
  so a timeout doesn't restart a large backfill from zero. Changing the configured
  endpoint or model rebuilds the index. Do not silently change a model behind a
  fixed ID.
- Each turn embeds the current message and up to 2,000 characters of recent,
  audience-visible, non-quarantined user/assistant dialogue. Tool outputs are not
  included. Existing external-provider `query` values remain unchanged.
- Recall packs complete bullets in descending similarity order, up to the existing
  6,000-character **per-notebook** budget. The prototype cutoff is cosine 0.2;
  it is a starting heuristic, not a calibrated probability of relevance. It needs
  evaluation for the chosen model. No always-loaded summary is introduced.
- Text search (`memory` action `search`, or `POST /v1/memory/search` with
  `{"query":"distinctive terms","limit":20}`) is independent of embeddings. It
  searches the full authorized notebooks with case-insensitive, all-term substring
  matching. It is grep-like literal search, not regex or semantic search.
- Embedding requests share an eight-second recall deadline. Provider failures fall
  back to bounded recent **whole** bullets, with a generic warning; chat, writes,
  and grep remain available. A text recheck prevents deleted facts from being
  returned after a concurrent edit during embedding.

Verification:

```bash
node --test test/semantic-memory.test.ts test/semantic-memory-http.test.ts
DATABASE_URL=postgres://... node --test test/semantic-memory-pg.test.ts
# Optional live embedding smoke test; uses synthetic facts and a mock reply model
# to inspect the actual context built by the running QM HTTP server:
MEMORY_RECALL_LIVE=1 OPENROUTER_API_KEY=... node --test test/semantic-memory-http.test.ts
```

The initial implementation targets ordinary-sized personal/team notebooks. Large
notebook backfills, index size, concurrent fleet traffic, and retrieval quality on
representative real conversations still need broader evaluation before rollout.

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

Read and write operations use separate OAuth client-credential pairs. Omit `write` and set route capture to `off` for a read-only provider. External routes fail open by default so an outage does not block recall; set `failOpen: false` on a route to make it strict. Provider calls time out after `timeoutMs` (3 seconds by default). Explicit writes always fail visibly. QM continues to decide readable/writable scopes and passes the acting user to the provider.

## Migrating from the retired `BRAIN_*` variables

Earlier releases wired an external knowledge server through `BRAIN=mcp`, `BRAIN_MCP_URL`, `BRAIN_QUERY_TOOL`, and the `BRAIN_RO_*`/`BRAIN_RW_*` OAuth client pairs, exposing `read_brain` and `write_brain` tools. Those variables are ignored now; startup logs a `[config]` warning while any of them is still set. Express the same server as an `mcp` provider above: `url` takes the old `BRAIN_MCP_URL`, `read.tool` the old `BRAIN_QUERY_TOOL`, and `read`/`write` name the env variables holding each OAuth client pair. Static bearer tokens (`BRAIN_AUTH=bearer`) have no equivalent; the provider framework authenticates with client credentials only.

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
