# Published app serving

Published applications execute on a **different browser origin for each immutable deployment ID**. The portal and web UI are trusted QM origins; applications are not. `/d/<name-or-id>/` and the legacy `/deployments/<name-or-id>/` are authenticated launch links, not transparent application root directories.

## Supported entry points

The portal, direct authenticated Node web UI, and standalone Vite dev server recognize both launch prefixes. Vite delegates authentication to Node. Production direct Node access still requires the existing verified-identity ingress; an unsigned `webuiuser` cookie is not a production sign-in method. Normal application resources, forms and API requests run on the isolated application origin after launch. Live editing uses the trusted QM editor with verified source identity. The unsigned cookie mode used by test fixtures is sufficient for the local app-runtime checks, but is not a fully authenticated editor/session API mode; use the local portal for live editing rather than treating that test escape hatch as production authentication.

Friendly names are stable human links. Execution hosts use immutable IDs so renaming an app or reusing its name cannot transfer another application's cookies, localStorage or service-worker origin. Old name-based execution links are compatibility redirects; app browser state from an old name origin does not migrate automatically.

The HTTP contract includes HTML, external CSS and scripts, modules, relative and root-relative resources, fetch, forms, app-local cookies/storage, redirects, and streamed HTTP/SSE responses. The existing gateway supports HTTP/1.1 and HTTP/2 upstreams. This change does **not** add WebSocket upgrade support or claim arbitrary WebSocket applications work. Apps needing a WebSocket transport require separate gateway/provider support; never bypass authorization by exposing a private provider endpoint.

## Development

Explicit non-production, loopback-only core ingress with a configured core signing secret uses:

```
http://<deployment-id>.apps.localhost:<core-port>/
```

Modern Chromium and Firefox resolve these loopback hosts without a hosts-file edit. This is not enabled on non-loopback sockets, arbitrary Host headers, or production instances. Use the ordinary local portal or Node dev sign-in; no cloud credentials, wildcard DNS, OIDC registration, or app-cookie injection is needed. Vite must target the correct Node server through `WEB_UI_SERVER_URL`. A direct app bookmark uses the configured `PUBLIC_WEB_URL` / `DEPLOY_APPS_LOGIN_URL` sign-in surface.

## Production prerequisites

Configure core with:

- `DEPLOY_APPS_DOMAIN=apps.example.com`: a domain you control, with wildcard DNS and TLS.
- `AWS_DEPLOY_GATE_SECRET`: a strong app-gateway signing secret (the retained environment name is historical, not an AWS requirement).
- `PUBLIC_WEB_URL=https://qm.example.com` or `DEPLOY_APPS_LOGIN_URL`: the trusted authenticated launch surface.
- Existing source-signing, portal identity and durable replay-store configuration. Replicas must share replay claims and signing keys.

Route `*.apps.example.com` to **core's app gateway**, preserving Host. Route the QM hostname to the portal. Do not point the wildcard at the provider runtime and assume QM's ACL still applies. The gateway domain may be on a different registrable domain from QM; it does not need a parent-domain portal cookie. `PORTER_DEPLOY_APPS_DOMAIN` is provider ingress configuration and is not the QM gateway domain.

An installation without a usable isolated origin receives an actionable app-launch configuration error. Sandboxed legacy/admin path inspection remains deliberately constrained and is not a substitute for a working interactive app. Adding `allow-same-origin` to those trusted-origin sandboxes is unsafe.

### Kubernetes / Helm

The chart can render a dedicated app ingress:

```yaml
publicUrl: https://qm.example.com
env:
  DEPLOY_APPS_DOMAIN: apps.example.com
ingress:
  enabled: true
  className: nginx
  hosts: [qm.example.com]
appsIngress:
  enabled: true
  tlsSecretName: qm-apps-wildcard-tls
```

Supply gateway and other secrets through the chart's existing secret mechanisms. Provision the wildcard TLS secret, typically with DNS-01; a wildcard cannot use an HTTP-01-only issuer. The app ingress targets core independently from the main portal ingress. Rendering rejects missing domain, invalid domain, disabled core or missing TLS-secret name. Rendering does not provision DNS, obtain a certificate, or prove a live cluster route.

The AWS deployment renderer recognizes generic `DEPLOY_APPS_DOMAIN` before the legacy AWS-specific domain for wildcard core routing. Existing vendored Terraform scaffolds must support `core_public_hosts`; update the scaffold rather than silently sending app hosts to portal.

## Authentication and isolation

App authentication uses an app-host browser challenge and a short-lived, single-use handoff through the authenticated source surface. The final callback is bound to the browser challenge, deployment ID, exact origin and current principal. The gateway then issues a host-only HttpOnly app session and redirects to the clean app URL. Gateway cookies and QM source credentials are not forwarded to the application runtime. Handoff tokens are app/origin-scoped, are not forwarded upstream, and are removed from the final address bar. A root-scoped application service worker can observe its own app-origin handoff requests, including their URLs; a reserved gateway route is not invisible to that worker. These tokens still require the HttpOnly browser challenge and single-use replay claim. This is not a claim that all same-origin app code is unable to observe app-scoped handoff URLs.

App sessions assert identity, not permanent access. The gateway checks current identity and deployment authorization for each request. An application's viewing grant allows using its own HTTP actions; it does not permit managing the deployment. Sibling-app requests cannot rely on same-site cookies to read or mutate another app: the gateway enforces the exact app origin and does not delegate that boundary to upstream CORS headers.

Portal session, login-state and impersonation cookies use browser-enforced `__Host-` names, Secure, HttpOnly and Path=/, with no Domain. Old unprefixed cookies no longer authenticate; users sign in again after upgrade. `PORTAL_COOKIE_DOMAIN` is retained only for clearing old cookie state, not issuing domain-wide credentials. App sessions last at most eight hours; signing out of the portal or switching the source account does **not** immediately revoke or switch an already-issued app session. Relaunching through `/d` establishes the current source actor; an existing app bookmark may retain the prior actor until expiry. Identity refresh across workers retains the existing approximately ten-second cache interval, rather than promising instantaneous cross-replica deactivation. Revoking the app grant or deactivating the principal denies subsequent gateway requests. Already downloaded data, app-controlled offline storage, and authorized in-flight streams are not retroactively erased.

Application paths such as `/api`, `/v1`, `/auth`, `/signin` and `/d` belong to the application on its isolated origin. Only `/__qm` and `/__claw__` are reserved gateway namespaces.

## Release smoke test

Before rollout, use normal sign-in on the target deployment and a real provider-backed application. Test both launch prefixes through each deployed front door; final origin and clean path/query; CSS, classic and module scripts; fetch GET/POST and a form; redirects and SSE; share, revoke and deactivation; and sibling-app read/write denial. Verify the actual wildcard certificate and app-host route to core. Local browser and rendered-infrastructure tests do not replace this staging check.

## Remembered sign-in compatibility

Portal sessions retain the seven-day sliding and thirty-day absolute defaults.
App sessions remain independently bounded to eight hours and check current identity
and deployment access on gateway requests; source logout does not immediately revoke
an already established app session. “Sign out everywhere” retains the upstream broker
revocation contract for remembered sign-ins, not retroactive deletion of app sessions.

The broker's remembered browser cookie is now `__Host-qm_idp_session`, with
`Secure; HttpOnly; SameSite=Lax; Path=/` and no Domain. An ordinary host-only cookie
without the prefix can still be shadowed by a sibling app setting a parent-domain
cookie. The portal forwards only the prefixed broker cookie to the broker; the old
`qm_idp_session` is never accepted for authentication and is cleared at the configured
broker path when the portal issues or clears its session. Both names are stripped
before requests reach app runtimes.

Deploy compatible portal and auth-plugin versions together. Existing portal and
remembered-browser cookies require fresh sign-in; there is no legacy-cookie
fallback. Broker cookies are intentionally rooted at `/`, not its `/idp` proxy
prefix, because `__Host-` cookies require `Path=/`. Broker issuer/client signature
binding and durable remembered-session revocation are unchanged.
