# Deployment broker credentials

An operator can give every agent in a deployment access to shared API keys without storing them in the
settings database. Set them in the server environment, the same way as `MODEL_GATEWAY_API_KEY`. The core
reads them once at startup.

Agents use these credentials only through the credential broker. They never see the secret, and org admins
can see them in Settings but can't edit, delete or replace them.

## Format

`BROKER_CREDENTIALS` is a JSON array. Each entry names the env var that holds its secret:

```json
[
  {
    "slug": "web-search",
    "displayName": "Web search",
    "host": "api.search.example",
    "secretEnv": "WEB_SEARCH_API_KEY",
    "injection": { "header": "X-API-KEY", "scheme": "" },
    "allowedMethods": ["POST"],
    "allowedPathPrefixes": ["/search"],
    "maxRequestsPerDay": 500
  }
]
```

| Field                 | Required | Meaning                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `slug`                | yes      | Lowercase kebab-case name agents use. Must be unique.                                                                                                                                                                                                                                                                                                              |
| `host`                | yes      | Bare hostname the broker pins requests to (subdomains match, as for stored credentials).                                                                                                                                                                                                                                                                           |
| `secretEnv`           | yes      | Name of the env var holding the secret. It must be set and non-empty.                                                                                                                                                                                                                                                                                              |
| `displayName`         | no       | Label shown in Settings and to agents. Defaults to the slug.                                                                                                                                                                                                                                                                                                       |
| `injection`           | no       | `header` and `scheme` for the secret. Defaults to `Authorization: Bearer <secret>`; set `scheme` to `""` to send the raw secret. `headers` adds fixed, non-secret headers the API needs on every call, such as `{"x-api-version": "2025-11-01"}`; callers cannot override them, and they cannot replace the secret's header, `content-type`, or transport headers. |
| `allowedMethods`      | no       | Allowed HTTP methods. Defaults to `GET`.                                                                                                                                                                                                                                                                                                                           |
| `allowedPathPrefixes` | no       | Allowed path prefixes. Defaults to any path.                                                                                                                                                                                                                                                                                                                       |
| `maxRequestsPerDay`   | no       | Cap on calls let through per UTC day, shared by every core process. Calls over the cap get `429 daily_cap_reached`.                                                                                                                                                                                                                                                |

Never put a secret in `BROKER_CREDENTIALS` itself; a JSON syntax error can quote part of the value.
Unknown fields, a missing secret, a duplicate slug or any invalid value stop the core at startup with an
error naming the entry. Errors never include secret values.

## Behaviour

- **Who can use them:** every conversation whose participants all belong to the org, as if the credential
  had an org-wide grant. Admins can't narrow that. Published apps can't use them.
- **Delivery:** broker only. They are never injected into sandbox environments.
- **Precedence:** a deployment slug is reserved. Lookups return the deployment credential even if the
  settings database still holds one with the same slug, and admins can't create, edit or delete a stored
  credential with that slug.
- **Broker only, everywhere:** decision providers and skill-pack Git auth can't use a deployment credential.
- **Usage:** broker calls are logged and summarised in Settings like any other credential.

## Operating

1. Put each secret in your secret store and expose it to the core as its own env var.
2. Set `BROKER_CREDENTIALS` to the JSON array and restart the core.
3. To rotate a key, change the secret's env var and restart. To remove a credential, drop its entry and
   restart.
4. If the settings database already holds a credential with the same slug, the core logs a warning at startup
   and the stored one is ignored. Delete the stored one before adding the env entry; otherwise it becomes
   active again if the env entry is later removed.
