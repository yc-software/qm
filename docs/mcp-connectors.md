# MCP connector credentials

Administrators register HTTP MCP servers through `PUT /v1/admin/mcp-servers/:id`
from an administrator session (`/api/admin/mcp-servers/:id` in the web UI behind the portal); agent tokens
are refused, so an agent cannot change which tools it may call or which calls need
approval. Registration controls the outbound destination and the tools available to agents.

`approval` decides which calls pause for a person's approval, bound to the exact
arguments and good for one call: `annotations` (the default; tools annotated
`destructiveHint: true` and not `readOnlyHint: true`), `all`, or `none`. An update
that omits `approval` keeps the current policy.

`attestActor: true` (catalog servers with shared `bearer` or `client-credentials`
auth only) sends the calling person's canonical id in the `x-qm-actor` header; see
[principal-links.md](./principal-links.md#attested-actors). `attestAudience` sets where
such a server may be used: `personal` (the default) only in the person's own private
conversation with QM; `any` in every conversation, for the internal person the turn
acts for: whoever asked QM or wrote the message it answers unprompted, the person who
started a session or subagent, and the owner of scheduled work. It is refused for QM
system actors, guests and bots.
`any` requires `attestActor`; an update that omits `attestAudience` keeps it, and
turning `attestActor` off resets it to `personal`.

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
and refresh a `refreshToken`. An unsupported provider must manage token renewal
in its integration; do not store a refresh token that QM cannot refresh.

`auth: "oauth-user"` gives each person their own sign-in, and the URL is usually
enough. A new registration that omits `auth` is probed: if the server publishes
protected-resource metadata (RFC 9728, then RFC 8414), it becomes `oauth-user`;
otherwise it is `none`. With no `clientId`, core registers a public PKCE client
through the server's `registration_endpoint` (RFC 7591) for its own OAuth callback
URLs. Pass `clientId` (and the authorize/token URLs if discovery fails) only for
servers without dynamic registration. People sign in on first use through the
`<id>_sign_in` tool.

`readOnly: true` marks every tool on the server as safe for read-only turns. Without
it, only tools annotated `readOnlyHint: true` are.

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
tokens. Per-user endpoints require HTTPS. Core refuses MCP server, OAuth discovery,
and OAuth token endpoints that resolve to loopback, link-local, private, or
unspecified addresses, checked on the address actually dialed. HTTP redirects are
rejected for every MCP authentication mode, and OAuth token requests do not follow
redirects. A server reached over HTTPS can't send any of its requests, the OAuth token
request included, to plain HTTP. Updating an endpoint
or credential host is an administrative trust decision. Tool call auditing records
the initiating actor as before; authentication does not expand the audience allowed
to receive the result.

An operator can let core reach particular private services, such as a gbrain on the
same Docker network, VPC or tailnet, by listing their exact origins in core's
`PRIVATE_NETWORK_ALLOWED_ORIGINS` (`env.core` in `qm.config.jsonc`), separated by commas:
`http://gbrain:8787,https://gbrain.example-tailnet.ts.net`. An entry is a scheme, host
and port, with no path, query, fragment or credentials. A request to a listed origin
may reach private addresses; a request to any other origin is refused as described
above, and the refusal names this setting. A listed origin is open to every request core's
guarded fetch makes, including OAuth discovery, registration and token requests to
endpoints a registered server's OAuth metadata names, so list only services that can
safely receive such requests. The same list covers custom model providers, both the API key
check when an admin saves one and every model call to it, and decision providers that call
their own endpoint. Loopback, unspecified, link-local and cloud metadata
addresses, including the IPv6 metadata addresses of AWS, Google Cloud, Oracle Cloud, Akamai and
Scaleway, Tailscale's `100.100.100.100` and `fd7a:115c:a1e0::53`, and Alibaba Cloud's `100.100.100.200`, are never allowed: core refuses to start with one in the list, and refuses a listed
name that resolves to one. Per-user endpoints still require HTTPS, and redirects stay
refused. A request that follows redirects, such as core fetching a loop item's image, never
gets the allowance, and its refusal does not name this setting. Only the deployment's environment sets the list. It is not an admin setting,
and it does not open sandbox egress.

- **Docker Compose.** List the service, such as `http://gbrain:8787`, and register
  `http://gbrain:8787/mcp`. Core must run on the same Compose network. A server
  registered as `localhost` or `127.0.0.1` stays refused; use the service name.
- **Same VPC or private network.** List the address, such as `http://10.0.12.7:8787`,
  or a name your DNS serves, such as `http://gbrain.internal:8787`.
- **Tailscale.** List `https://gbrain.<tailnet>.ts.net`. Core's host must be on the
  tailnet and resolve MagicDNS names; core's fetch uses no proxy.

Prefer IP literals or fully qualified names your own DNS serves. A single-label name
such as `gbrain` can fall through to resolver search domains, and a listed name is
only as safe as its DNS. TLS to an IP literal needs a certificate that names the IP.
Listing the Docker host (the bridge gateway or `host.docker.internal`) opens that
host on the listed port.
