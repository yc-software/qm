# Deployment OAuth connectors

A deployment can add personal OAuth 2.0 authorization-code connectors without copying core files. Put a descriptor at `sandbox/connectors/<id>.json` beside the deployment's `sandbox/tools/` and `sandbox/skills/`, then sync the deployment layer normally. Core persists the descriptor in the existing deployment-layer store; other core instances hydrate the same registry.

For source deployments using `DEPLOYMENT_LAYER`, the same `connectors/` directory belongs under that layer root. The descriptor is core configuration, not an installed sandbox file.

## Example: Xero

`sandbox/connectors/xero.json`:

```json
{
  "id": "xero",
  "label": "Xero",
  "description": "Accounting, invoices and contacts",
  "hosts": ["api.xero.com"],
  "authUrl": "https://login.xero.com/identity/connect/authorize",
  "tokenUrl": "https://identity.xero.com/connect/token",
  "scopes": ["offline_access", "accounting.transactions", "accounting.contacts"],
  "clientIdEnv": "XERO_OAUTH_CLIENT_ID",
  "clientSecretEnv": "XERO_OAUTH_CLIENT_SECRET",
  "clientAuth": "basic",
  "tenants": {
    "url": "https://api.xero.com/connections",
    "idField": "tenantId",
    "labelField": "tenantName"
  }
}
```

Register the callback URI using the configured public web URL with the provider: `https://<your-qm-host>/v1/connectors/oauth/xero/callback`. Set the referenced client ID and secret in core's secret source, or configure the connector through the existing administrator OAuth client settings. Never put their values in the descriptor, a tool, a skill, or a sandbox environment.

People connect the provider from Keychain using their own consent. For a tenant-aware provider, they then choose an organization there. Core re-fetches the provider's authorized tenant list before saving the choice. Reconnecting clears the previous selection. One canonical API host is supported for tenant-aware connectors.

## Tool access

No additional mint endpoint is needed. The existing keychain `use` operation materializes the owner's connector credential, or an explicitly approved credential grant, after refreshing it in core when necessary. It returns only provider access material, never the OAuth client secret or refresh token.

For this example the sandbox receives:

- `VAULT_TOKEN_API_XERO_COM`: the provider-issued access token.
- `VAULT_TENANT_API_XERO_COM`: the selected tenant ID.

A deployment tool can send those as `Authorization: Bearer …` and `Xero-tenant-id: …`. It must not persist access tokens. Expiry and renewal follow the provider's token response; core cannot shorten a token's upstream validity. Existing personal-turn token injection and grant-based use follow the same tenant-selection gate. Selecting a tenant chooses the tool's default organization; it does not downscope the provider token or restrict it to that organization at the provider.

## Descriptor contract

Required: `id`, `label`, `hosts`, `authUrl`, `tokenUrl`, `scopes`, `clientIdEnv`, `clientSecretEnv`.

Optional:

- `description`: short text shown in Keychain.
- `clientAuth`: `body` (default) or `basic`.
- `pkce`: enable S256 proof-key exchange.
- `authParams`: extra consent parameters; protocol fields such as state, callback, client ID and PKCE cannot be overridden.
- `tenants`: HTTPS discovery URL, string `idField` and `labelField`, and optional top-level `itemsField` for a response wrapping the tenant array.

Endpoints must be HTTPS URLs without embedded credentials, queries, fragments, or IP literals. API hosts cannot overlap another connector's hosts. Stock providers and subscription-auth hosts cannot be replaced. Unknown descriptor fields and executable adapters are rejected. The standard token endpoint must return OAuth JSON fields such as `access_token`, `refresh_token`, and numeric `expires_in`.

Registration is a privileged deployment operation, not an agent capability or sandbox plugin. Only trusted operators should set endpoints and secret references. This is not an untrusted plugin sandbox or an arbitrary OAuth adapter framework.

## Updates and removal

The bundle's optional `connectors` array is additive to contract version 1. Old tools/skills-only bundles remain valid. A layer update replaces the custom connector catalog; omitting connectors removes their registration. Invalid updates leave the current valid layer intact.

Removing registration stops new consent and refresh routing, but does not revoke already-issued provider tokens or delete existing keychain credentials. Disconnect users before removal when access must stop immediately. Pending organization selections cannot be completed while the descriptor is absent. Change endpoints or client identity deliberately; existing provider sessions may require reconnecting. Deployment registration and OAuth client enablement remain separate controls.
