# Personal credentials for published apps

A publisher can explicitly approve their own saved env credential for one published
app. The publisher must currently own the app's personal home. Channel/team homes,
delegated credential ownership, file credentials, and managed OAuth/connector
credentials are unsupported. Personal scope grants do not authorize apps.

App users can see data returned by the provider. App managers control the code that
uses the credential. Explain these consequences and obtain the owner's explicit
approval before recording a binding. Approval must come from the owner in their own
live personal conversation; triggered turns and app tokens cannot grant access.

## Grant and inspect

Use the agent's control-plane capability (`AGENT_API_TOKEN`) for these routes.
Both require a verified live owner conversation. Use deployment and credential IDs,
not deployment names, credential service names, or keychain handles. Get credential
IDs and field names from the keychain metadata.

`GET /v1/deployments/:id/credentials` returns `{ "credentialBindings": [...] }`.
`POST /v1/deployments/:id/credentials` replaces the complete list. For example,
with fake identity and credential IDs:

```json
{
  "credentialBindings": [
    {
      "credentialId": "0123456789abcdef",
      "ownerId": "owner@example.com",
      "host": "api.example.com",
      "allowedMethods": ["GET", "POST"],
      "allowedPathPrefixes": ["/v1/data"],
      "headers": [
        { "name": "x-token-id", "field": "TOKEN_ID" },
        { "name": "x-token-secret", "field": "TOKEN_SECRET" }
      ]
    }
  ]
}
```

Only IDs and routing rules are stored. Values remain encrypted in the keychain and
are read inside core for each authorized request. Every binding must belong to the
publisher. Any invalid entry rejects the whole replacement.

`host` is an exact lowercase DNS hostname without scheme, port, userinfo, trailing
dot, or wildcard. A host already recorded on the credential constrains this value.
Methods are nonempty uppercase HTTP method lists; supported methods are GET, HEAD,
POST, PUT, PATCH, DELETE, and OPTIONS. Path prefixes are nonempty absolute paths
without encoding, query strings, fragments, whitespace, or traversal. `/v1/data`
permits that path and descendants, but not `/v1/database`. A trailing slash permits
only descendants starting with that slash. Requests require HTTPS on the exact
host, without explicit ports, userinfo, fragments, or ambiguous encoded separators.

Allowed authentication header names (case insensitive) are `authorization`,
`x-api-key`, `api-key`, `x-auth-token`, `x-access-token`, `x-token-id`, and
`x-token-secret`. Names and fields must be distinct. For multi-field credentials,
`field` is required and must match metadata. For scalar credentials it can be
omitted to select the credential's `envKey`. `scheme` is optional, printable ASCII,
and defaults to empty; a separating space is appended when needed. A scalar bearer
binding uses `"headers": [{"name":"Authorization","scheme":"Bearer"}]`.

## Call from the app

Published apps receive `AGENT_API_URL` and the broker-only `AGENT_CREDENTIAL_TOKEN`
when core's API URL and signing secret are configured, even with no initial org
credentials. The token contains no personal credential IDs or provider keys.
Previously published apps need one redeploy to receive a token if they never had one.

```javascript
const response = await fetch(`${process.env.AGENT_API_URL}/v1/credentials/broker`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-agent-capability": process.env.AGENT_CREDENTIAL_TOKEN,
  },
  body: JSON.stringify({
    credential: "0123456789abcdef",
    method: "GET",
    url: "https://api.example.com/v1/data",
  }),
});
const result = await response.json();
```

The broker injects both approved headers and returns the provider's status,
content type, and text body. String request bodies pass through unchanged. Caller
headers cannot replace authentication or the broker's actor identity. Provider
redirects are not followed. Personal requests validate DNS at connection time and
reject private network addresses, including mixed public/private answers. They use
standard TLS verification, a 30-second deadline, and a 5 MB response limit. Oversized
responses fail without returning a partial body. Existing org credential networking
is unchanged. This is a text HTTP interface: gRPC and binary protocols
are unsupported, and paired headers do not automatically make provider SDKs work.

## Revoke and lifecycle

```http
POST /v1/deployments/:id/credentials
Content-Type: application/json

{"credentialBindings":[]}
```

Revocation affects subsequent requests using already-issued tokens, without a
redeploy. Bindings live outside code versions, so rollback and redeploy cannot
restore revoked bindings. Transfer and archive clear bindings; a restored app needs
fresh approval. A stopped or archived app cannot use its token. Deleted, expired,
changed-owner, or unsupported credentials fail closed. In-flight provider requests
cannot be recalled.

Org broker credentials still use their slugs. App tokens retain their original org
credential ceiling and org calls also check the current org-wide ACL and published
app switch. Ordinary session behavior is unchanged. App tokens cannot read the
keychain, grant bindings, call control-plane APIs, or use the Git HTTP broker.
