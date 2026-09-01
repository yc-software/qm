# Memory providers

QM keeps its built-in notebook memory unless `MEMORY_PROVIDER_CONFIG` defines a scope-aware provider router. Routes independently select where each scope recalls from, accepts explicit writes, and receives automatic post-turn capture.

```json
{
  "providers": [
    {
      "id": "org-brain",
      "type": "mcp",
      "url": "http://brain-relay.internal:8080",
      "timeoutMs": 3000,
      "read": {
        "tool": "read_brain",
        "clientIdEnv": "BRAIN_RO_CLIENT_ID",
        "clientSecretEnv": "BRAIN_RO_CLIENT_SECRET"
      },
      "write": {
        "tool": "write_brain",
        "clientIdEnv": "BRAIN_RW_CLIENT_ID",
        "clientSecretEnv": "BRAIN_RW_CLIENT_SECRET"
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
      "provider": "org-brain",
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

Options: `bin` (default `memorable`; may include arguments, e.g. `node /opt/memorable/cli.js`),
`injectTimeoutMs` (default 15000) and `recordTimeoutMs` (default 120000). The CLI is not bundled:
install it with `npm i -g memorable-cli`. It sees only an allow-listed environment —
`MEMORABLE_*`, `PATH`, `HOME`, proxy and TLS variables — with `MEMORABLE_BACKEND` defaulting to
`qm` and the database reachable solely as `MEMORABLE_DB_URL`. Routes to this provider accept
`capture: "automatic"` or `"off"`; explicit `remember` writes are facts, not procedures, and are
left to the notebook. The provider never exposes a notebook, so keep `manage: false` and let
`default` handle editing.
