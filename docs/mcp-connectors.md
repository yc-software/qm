# MCP connector credentials

Administrators register HTTP MCP servers through `PUT /v1/admin/mcp-servers/:id`.
Registration controls the outbound destination and the tools available to agents.

`url` is the complete MCP POST endpoint. QM preserves its path and trailing slash;
it does not append `/mcp`. Use a root URL for servers that serve MCP at `/`, or
include the server's exact path (for example `/mcp` or `/api/tools/`). Existing
registrations that relied on QM adding `/mcp` must add it explicitly. The existing
client-credentials token URL convention is unchanged: remove trailing slashes and
a final `/mcp` from the configured URL, then append `/token`.

`credentialScope` selects the identity used for `tools/call`:

- `shared` (the default for existing and new registrations): all callers use the
  configured `auth`, `bearerToken`, or `clientId` and `clientSecret`.
- `per-user`: each call uses the initiating actor's bearer token from the encrypted
  connector keychain, under `credentialHost` in the selected `credentialAccountType`
  slot (`default`, `personal`, or `company`; defaults to `default`). The
  runtime supplies the actor; tool arguments cannot select another user.

For example:

```json
{
  "name": "Customer tools",
  "url": "https://tools.example.com/mcp",
  "auth": "none",
  "credentialScope": "per-user",
  "credentialHost": "accounts.example.com",
  "readOnly": false,
  "enabled": true
}
```

Per-user mode requires persistent keychain encryption (`CONNECTOR_SECRET_KEY`).
Connect the user's account using an existing QM OAuth connector, or have a trusted
integration save its token through the source-authenticated
`POST /v1/connectors/token` endpoint with `host`, `principalId`, `accessToken`, and
optional `expiresAt` (Unix milliseconds). Supported OAuth providers can also store
and refresh a `refreshToken`. This change does not add OAuth provider discovery or
an interactive MCP login flow. An unsupported provider must manage token renewal
in its integration; do not store a refresh token that QM cannot refresh.

Missing, expired, revoked, or unrefreshable user credentials fail the call with a
connection-required message. Per-user MCP calls do not use operator environment
tokens, organization credentials, another user's account, or the shared discovery
credential as fallback. Tokens are resolved again for every call rather than
cached across users. Triggered work uses its existing initiating actor identity.

Tool discovery (`tools/list`, including registration probes) remains connector-wide
and uses the configured `auth`. In per-user mode those credentials are only for
catalog discovery. The server must expose a common, non-sensitive catalog and
check each caller's permissions when executing a tool. A public catalog can use
`auth: "none"`; a private catalog can use a dedicated shared discovery credential.
Do not put user-specific data into names, descriptions, or schemas.

`credentialHost` explicitly authorizes sending that connector's user token to the
registered server. Only register a trusted service permitted to receive those
tokens. Per-user endpoints require HTTPS, except on loopback for local development.
HTTP redirects are rejected for every MCP authentication mode. Updating an endpoint
or credential host is an administrative trust decision. Tool call auditing records
the initiating actor as before; authentication does not expand the audience allowed
to receive the result.
