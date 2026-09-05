# Portal — the public SSO front door

The portal is the **one** publicly-reachable app in the stack. It replaces the per-surface
`fly proxy` tunnels (one per app, each on its own local port) with a single signed-in URL that
fronts every surface. It does provider-neutral **OIDC** sign-in (Google Workspace
is the email-first deployment default) and reverse-proxies — over Fly's private 6PN — to the
surfaces, which all stay **private** (no public `[http_service]` of their own):

| Path        | → upstream        | Notes                                                                         |
| ----------- | ----------------- | ----------------------------------------------------------------------------- |
| `/*` (root) | `<prefix>-web-ui` | Pi web UI SPA, root-mounted (`/web-ui/*` 308-redirects to root for old links) |
| `/admin/*`  | `<prefix>-admin`  | governance — admin access derived from the core (`canAdminister`)             |

User deployments are never served on this authenticated origin; they use the dedicated apps domain.

It is a thin `node:http` server (native TS type-stripping), like the other
surfaces, and it does **not** import the core.

## How a request flows

1. **Sign in** — `GET /auth/login` starts an OIDC Authorization-Code flow with PKCE(S256) +
   `state` + `nonce`, all sealed into a short-lived signed `portal_oidc_tmp` cookie.
2. **Callback** — `GET /auth/callback` exchanges the code over the TLS back-channel
   (confidential client, `client_secret_basic` + the PKCE verifier), then binds the id_token
   signature and payload (`nonce`/`aud`/`iss`/`sub`/timestamps and, for Slack, the `team_id`
   workspace pin) against the configured HTTPS JWKS, then reads
   the subject from userinfo. The verified `sub` **is** the core principal id. It mints a
   signed `portal_session` cookie (`{sub, org, auth, exp}`, HMAC, 8h sliding lifetime with a
   24h absolute maximum by default).
3. **Proxy** — every other path requires a valid session. The portal picks the upstream by the
   **exact first path segment**, strips the prefix, and proxies to the private upstream,
   synthesizing the surface cookie for compatibility and attaching a short-lived signed portal
   identity. Surfaces pass that identity to core, which verifies it before any user-scoped action.

## Operator admin login without email

Run `qm admin-login` with the deployment's configuration and secrets to generate
a private admin login URL. Open it and confirm the displayed email. The URL
expires after five minutes and works once. With multiple email-based
`ADMIN_GRANTS` administrators, use `qm admin-login --email admin@example.com`.
The command can also run with `PORTAL_PUBLIC_URL`, `PORTAL_SESSION_SECRET`, and
`ADMIN_GRANTS` in its environment, without a deployment config file.

`GET /auth/admin-login` only renders the confirmation page. Its script moves the
token out of the URL fragment into the form and clears the fragment. Nothing
signs in until the user submits that same-origin form. `POST /auth/admin-login`
verifies the token's purpose, portal origin, signature and lifetime, checks the
account's current admin status, and consumes its unique ID through core's
durable Postgres replay store. It then issues the ordinary portal session and
clears any old impersonation cookie. No account or role is created.

This is an operator capability: keep deployment secrets and generated URLs
private. It does not prove an email inbox, replace another user's login, or
depend on a hosting provider. Leave the built-in broker's sender and selected
email credentials unset to run without email; configure them later and restart
to enable ordinary email sign-in. Existing external OIDC login is unchanged.

Live integration checks require a running core, Postgres, admin, portal and
built-in auth broker with email unset. Set `QM_ADMIN_LOGIN_ENV_FILE` to a private
JSON file containing that deployment's environment and run
`node --test test/integration/admin-login.test.ts` from the repository root. Use a
disposable test deployment: the test redeems real links for its configured admin.

## Security model (the parts that must be right)

- **Identity comes from verified OIDC or an operator-issued admin link.** The browser cannot assert an unsigned identity. The
  upstream request is built **from scratch** — an _allowlist_ of safe headers
  (`content-type`/`accept`/`user-agent`/…) plus the one synthesized cookie. The client's
  headers and cookies are **never** forwarded, so a browser can't smuggle a forged
  `admin=`/`x-as-principal` into a 6PN-trusting upstream, and there's no CL/TE desync surface
  (`node:http` frames the piped body itself).
- **Routing decides once.** The router rejects pathologically-encoded targets (`%2f`, `%5c`,
  `%2e%2e`, `\`, `//`, NUL → 400), selects the upstream by exact segment, and derives the
  `/admin` gate from that _selected_ key — never a second `startsWith` that could disagree
  (tier-escape guard).
- **Admin is derived from ONE source — the core's `admin_grants`.** The portal asks the admin
  surface (`GET /api/whoami` over 6PN, **no signing secret**), which asks the core
  (`GET /v1/admin/whoami` → `canAdminister`). The portal caches the boolean ~60s and **fails
  closed** (admin surface down ⇒ no Admin link on the landing, `/admin` 403). `canAdminister` is
  re-checked **per action** at the core — the live boundary. There is **no portal/admin id list**
  anymore; the only place an admin is named is the core's `ADMIN_GRANTS`.
- **Non-admin users need no per-id config.** `PORTAL_EXPECTED_TEAM_ID` pins the workspace, so any
  verified member is a valid user (`WEB_UI_PRINCIPALS` empty = any verified principal).
- **CSRF / open-redirect.** Every non-GET requires a same-origin `Origin`; `returnTo` is reduced
  to a same-origin path (rejects `//evil`, `/\evil`, `https:/evil`, `%2f%2f`/`%5c`).
- **Secret hygiene.** In production the portal refuses to boot unless `PORTAL_SESSION_SECRET`,
  `PORTAL_IDENTITY_SECRET`, and `OIDC_CLIENT_SECRET` are set and distinct from core ingress auth.
  Public and OIDC endpoints must use HTTPS. Session and temporary cookies use domain-separated keys.

### Documented trade-offs & residual risks (v1)

- **Surface isolation.** The private surface hop carries a signed portal identity; core verifies
  it independently, so a synthesized cookie alone confers no user authority. User deployments
  stay on a dedicated apps hostname and are never proxied through the portal or admin origin.
- **Stateless logout.** `POST /auth/logout` clears the cookie but can't revoke an already-issued
  session before `exp`; the core's `canAdminister` (re-read per request) remains the live admin
  revocation path. Slack has no RP-initiated end-session, so SSO re-login is silent.

## Playground mode

`PORTAL_PLAYGROUND=1` turns the deployment into a public try-it instance: an
unauthenticated browser navigation (a `GET` that accepts HTML) mints an anonymous
principal (`playground-<random>`), seals it into the ordinary `portal_session`
cookie, and continues — so each visitor's sessions, files, memory, and sandbox are
pinned to their browser through the same scoping that isolates real teammates.
Non-HTML requests without a session still get `401`, so the SPA's API calls ride
the cookie from the first page load and bare `curl` never mints.

What playground mode does **not** change: `/auth/login` still runs the full OIDC
flow (that's how the one admin signs in — production still demands the usual OIDC
config), `/admin` refuses anonymous sessions outright, and admin identity remains
the core's `ADMIN_GRANTS`. Signing out of an anonymous session just clears the
cookie; the next visit starts a fresh playground identity.

Minting is rate-limited per client address through the core's Postgres-backed
single-use claim store (the same one the sign-in broker uses), so restarts and
blue-green deploys can't reset it; if the core can't record the claim the portal
fails closed and answers 429. `PORTAL_PLAYGROUND_MINTS_PER_IP` (default 30, at
most 64 — the core grants at most 64 claim slots per request) per
`PORTAL_PLAYGROUND_MINT_WINDOW_S` (default 3600, at most 86400 — the core's
claim horizon); the portal refuses to boot outside those ranges rather than
silently serving 429 to everyone. IPv6 clients are bucketed per /64, not per
address, so a visitor with a routed prefix can't rotate through fresh budgets.
The client address comes from `clientIpOf` — on Fly that's `fly-client-ip`;
elsewhere set `PORTAL_XFF_TRUSTED_HOPS` when a reverse proxy fronts the portal,
or every visitor (and every crawler that accepts HTML) shares the socket
address's one bucket.

Because playground authority must never leave this origin, the portal refuses
to boot with `PORTAL_PLAYGROUND` alongside `PORTAL_COOKIE_DOMAIN`, an apps
domain (`PORTAL_APPS_DOMAIN` / `DEPLOY_APPS_DOMAIN`), or an explicit
`PORTAL_DEPLOYMENTS_ENABLED=1` — a domain-wide cookie or the deployment proxy
would hand anonymous sessions to surfaces that never see the `anon` flag. The
deployment proxy (`/d/<app>/`), on by default for signed-in portals, turns
itself off under the playground, and anonymous sessions are refused it at
request time too. Outside the playground, `PORTAL_APPS_DOMAIN` defaults to
`DEPLOY_APPS_DOMAIN`, and `PORTAL_COOKIE_DOMAIN` to the portal host itself when
the apps domain sits directly under it (`apps.<portal host>`), so one core-side
variable configures both processes. Any other layout needs an explicit
`PORTAL_COOKIE_DOMAIN` — deriving a shared parent by guesswork risks landing on
a public suffix browsers refuse. Anonymous sessions are also refused the `/connect/*` and
`/drop/*` flows, so a visitor can't attach real OAuth tokens or dropped secrets
to a throwaway principal that a cleared cookie orphans.

The `anon` flag lives only in the portal's session cookie — it does not cross
the portal identity boundary. To the core, a playground visitor is an ordinary
**internal** principal of the deployment's org: they can run turns, use their
sandbox, create crons, and reach anything granted or published at `org:` scope,
including org-granted credentials. That is the design — visitors are members of
the playground org — so a playground must be its own deployment with nothing
sensitive at org scope: no org-wide credential grants, no real connector
credentials, no company data. A cleared cookie mints a fresh principal, so pair
this with the core's real brakes: `BUDGET_USD_PER_WINDOW`,
`ORG_BUDGET_USD_PER_WINDOW`, `RATE_LIMIT_PER_WINDOW`, and a single pinned model
via the admin `base-model` / `webui-models` resources. Nothing
garbage-collects an abandoned visitor's scope yet.

## Env

Non-secret (`[env]`): `PORT` (8097 local / 8080 image), `PORTAL_PUBLIC_URL`, `CORE_API_URL`,
`CORE_ORG_ID`, `WEB_UI_UPSTREAM`, `ADMIN_UPSTREAM`,
`OIDC_AUTH_ENDPOINT` / `OIDC_TOKEN_ENDPOINT` / `OIDC_USERINFO_ENDPOINT` / `OIDC_ISSUER` /
`OIDC_JWKS_URI` / `OIDC_SCOPES` / `OIDC_CLIENT_ID`, `PORTAL_EXPECTED_TEAM_ID`,
`PORTAL_SESSION_TTL_S`, `PORTAL_SESSION_MAX_TTL_S`. `PORTAL_SESSION_MAX_TTL_S` caps a session's total life from authentication; it defaults to the larger of one day and `PORTAL_SESSION_TTL_S`, and boot fails if it is set below the TTL.
There is no `PORTAL_ADMIN_PRINCIPALS` — admin
access is derived from the core (see the security model above).
For local development only, `PORTAL_LOCAL_AUTH_BYPASS=1` mints a local session as
`PORTAL_DEV_PRINCIPAL` without contacting OIDC. The portal refuses this in production
and only accepts it when `PORTAL_PUBLIC_URL` is loopback.

Identity: `OIDC_PRINCIPAL_CLAIM` — `email` (default; the org-canonical id: the
verified work email, lowercased; sign-in fails unless the IdP marks the email verified) or `sub`
(the IdP's opaque subject, e.g. the Slack U… id — only for deployments still keyed on Slack ids).
`OIDC_ALLOWED_EMAIL_DOMAIN` — with `email`, additionally reject any account outside this domain
(checked against the email suffix and Google's `hd` claim).
An address those rules reject still signs in when an org admin has invited it as an
external user: the callback asks core over the signed core client
(`GET /v1/auth/broker/email-allowed`) and accepts an active invitation, `hd` notwithstanding.
An address the env rules permit never triggers the lookup; core unreachable means not allowed.
Deployments keyed on `sub` never consult it, so external users cannot sign in there.

### Google Workspace SSO with the email principal

The OIDC client is generic, so Google is pure config. One-time setup:

1. In a Google Cloud project under the org's Workspace: **APIs & Services → Credentials →
   Create OAuth client ID** (type "Web application"), authorized redirect URI
   `https://<portal-host>/auth/callback`. On the consent screen choose **Internal** (members
   of the Workspace only).
2. Point the portal at Google:
   ```
   OIDC_AUTH_ENDPOINT=https://accounts.google.com/o/oauth2/v2/auth
   OIDC_TOKEN_ENDPOINT=https://oauth2.googleapis.com/token
   OIDC_USERINFO_ENDPOINT=https://openidconnect.googleapis.com/v1/userinfo
   OIDC_ISSUER=https://accounts.google.com
   OIDC_JWKS_URI=https://www.googleapis.com/oauth2/v3/certs
   OIDC_SCOPES="openid email profile"
   OIDC_CLIENT_ID=<client id>
   OIDC_ALLOWED_EMAIL_DOMAIN=<org domain, e.g. example.com>
   ```
   (unset `PORTAL_EXPECTED_TEAM_ID` — it's a Slack-OIDC concept).
3. The Slack plugin keys on emails by default too (bot scope `users:read.email`, already in the
   repo manifest — reinstall the app if it predates the scope), so Slack turns and web logins
   resolve to the same principal.
4. A deployment whose state predates email keying (Slack U… ids in the DB) must be re-keyed
   **once**: `scripts/migrate-principals-to-email.mjs` (dry-run by default; see its header).
   Update the core's `ADMIN_GRANTS` to emails in the same change.

Secrets: `OIDC_CLIENT_SECRET`, `PORTAL_SESSION_SECRET`, and `PORTAL_IDENTITY_SECRET`; each must be
distinct from `CORE_SIGNING_SECRET`.

## Run / test

```bash
npm start
npm run typecheck
npm test
```

See **`deploy/README.md` → Portal** for the public bring-up (IPs + cert, DNS, the Slack OIDC
app, and secrets) and `deploy/portal/fly.toml`.
