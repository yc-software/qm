# auth — the built-in sign-in broker

An OIDC authorization server that speaks exactly the subset
[`plugins/portal`](../portal/src/oidc.ts) consumes, so the portal keeps talking
standard OIDC and never grows a second authentication path. Instead of an
external identity provider, people sign in with a one-time emailed link (the default)
or an operator-provisioned email and password.

## Password login without email

Set `env.auth.AUTH_LOGIN_METHOD` to `"password"` in the deployment config, then
run `qm setup`. Setup collects passwords for the initial administrator addresses
in `ADMIN_GRANTS`. To provision another account or reset a password, run
`qm password person@example.com` from the deployment directory and follow its
deployment instructions. No Resend key, SMTP account, or verified sender is needed.
Setting a password grants no membership: permit new accounts through the existing
allowlist, domain, or external-user invitation separately. Before modifying a cloud
deployment's credentials, make its complete current `AUTH_PASSWORD_HASHES` secret
available locally so the command can preserve other accounts.

Passwords contain 15 to 128 Unicode characters. The CLI prompts without echoing the
password and saves only salted scrypt hashes in `AUTH_PASSWORD_HASHES`, a secret
JSON object mapping email addresses to hashes. The hash format is
`scrypt$32768$8$3$<base64url salt>$<base64url key>` (16-byte salt, 64-byte key).
Keep that secret in the deployment secret store; the broker reloads it at startup,
so accounts survive restarts and replicas share the same credentials.

Accounts are provisioned by a trusted operator who checks the person's identity
before assigning their email address. There is no public registration endpoint:
knowing an allowed email address or domain must never let someone claim an admin
account. The broker asserts these operator-verified identities through the same
OIDC `email_verified` claim as email login. The existing allowlists, external-user
expiry, admin grants, PKCE, single-use codes, and portal sessions still apply.
An invitation or allowed domain alone does not create a password account.

Login attempts use the existing `AUTH_SEND_WINDOW_S`, `AUTH_SEND_LIMIT_PER_EMAIL`,
and `AUTH_SEND_LIMIT_PER_IP` settings, in separate durable password buckets.
Both failed and successful attempts count. The email bucket is paired with the
client address, so a stranger cannot lock the account out from other addresses.
Hash verification is also bounded to four concurrent requests per broker.
Backend outages fail closed.

Password recovery is an operator reset, without email delivery. Changing a password
does not revoke already-issued portal sessions; they keep their existing expiry.
Mail-based invitations and authenticator-app 2FA are separate from this login option.
Set `AUTH_LOGIN_METHOD` back to `"email"` and supply mail credentials to use magic
links again. The `/verify` link routes are disabled in password mode.

## Endpoints

| Route                                   | Reached by                                  | Notes                                                                          |
| --------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /authorize`                        | browser, via the portal at `/idp/authorize` | validates the request and renders the sign-in form                               |
| `POST /authorize`                       | browser, via the portal                     | emails a link, or verifies a password and returns an authorization code |
| `GET /verify`                           | browser, via the portal at `/idp/verify`    | consumes the link and redirects to the portal's `/auth/callback` with a code   |
| `POST /token`                           | portal, over the private network            | HTTP Basic client auth, authorization-code grant, PKCE S256                    |
| `GET /userinfo`                         | portal, over the private network            | Bearer access token, verified statelessly                                      |
| `GET /.well-known/jwks.json`            | portal, over the private network            | the ES256 public key                                                           |
| `GET /.well-known/openid-configuration` | operators                                   | discovery, for debugging                                                       |
| `GET /healthz`                          | the platform                                | liveness                                                                       |

The broker is never published directly. The portal republishes only the three
browser-facing routes under `AUTH_BROKER_PREFIX` (`/idp` by default), which is
why the issuer is `https://<portal>/idp` and the sign-in pages share the portal's
origin, cookies, and CSP.

## Durability

Nothing about a sign-in lives in this process. The sign-in link, the
authorization code, and the access token are self-contained JWTs sealed with
purpose-separated keys derived from `AUTH_TOKEN_SECRET`; the id_token is signed
with the P-256 key in `AUTH_SIGNING_JWK`. Single use — of both the link and the
code — and the send rate limits are claimed through core's Postgres-backed
`ReplayDedupe` over the chassis signed core client, so a restart, a blue-green
deploy, or a second instance cannot resurrect a spent link. If core cannot record
a claim the broker fails closed and refuses the sign-in.

## Configuration

Every value below is set by `qm` from the deployment config and the secret
store; the broker refuses to start if any of it is missing or a placeholder.

| Variable                                                                        | Source                                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_ISSUER`, `AUTH_CLIENT_ID`, `AUTH_REDIRECT_URI`                            | derived from `publicUrl`                                                                                                    |
| `AUTH_CLIENT_SECRET`, `AUTH_TOKEN_SECRET`, `AUTH_SIGNING_JWK`                   | generated by `qm setup`                                                                                                     |
| `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_EMAIL_DOMAIN`                              | the operator's admin address or domain                                                                                      |
| `AUTH_LOGIN_METHOD` | `email` (default) or `password` |
| `AUTH_PASSWORD_HASHES` | operator-provisioned account hashes; required only in password mode |
| `AUTH_EMAIL_FROM`                                                               | the operator's verified sender; required only in email mode                                                                                              |
| `AUTH_BRAND_NAME`                                                               | `botName` in the deployment config; the Admin page's live branding, when set, takes precedence on rendered pages and emails |
| `AUTH_EMAIL_TRANSPORT` and the chosen transport's variables (below)             | the operator's email provider                                                                                               |
| `AUTH_LINK_TTL_S`, `AUTH_CODE_TTL_S`, `AUTH_ACCESS_TTL_S`, `AUTH_REQUEST_TTL_S` | optional, capped                                                                                                            |
| `AUTH_SEND_WINDOW_S`, `AUTH_SEND_LIMIT_PER_EMAIL`, `AUTH_SEND_LIMIT_PER_IP`     | optional                                                                                                                    |
| `CORE_API_URL`, `CORE_ORG_ID`, `CORE_SIGNING_SECRET`                            | the chassis core block                                                                                                      |

The signing key is single, not a set: rotating it means redeploying, and links
minted by the previous key stop verifying at that moment.

## Invited external users

An address an org admin has invited as an external user (Admin → Users, or by
asking the agent) may sign in until its expiry even though it is on neither
`AUTH_ALLOWED_EMAILS` nor `AUTH_ALLOWED_EMAIL_DOMAIN`. The env list is checked
first and settles the answer on its own; only an address it does not cover is
looked up in core over the signed core client (`GET
/v1/auth/broker/email-allowed`), at every step — when the link is requested,
when it is opened, and when the code is exchanged — so a revoked or expired
invitation stops working at once. A lookup that fails or times out counts as not
allowed. One of the two env variables is still required at boot.

## Email transport

In email mode, `AUTH_EMAIL_TRANSPORT` selects one of two, and the broker refuses to start
without that transport's credentials. `AUTH_EMAIL_FROM` is the verified sender
either way, optionally as `Name <sender@example.com>`.

| Transport | Variables                                                                             | Notes                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resend`  | `RESEND_API_KEY`                                                                      | A key with send access from <https://resend.com/api-keys>. The sending domain must be verified under Domains, which needs DNS records; an unverified domain fails at delivery, not at boot.                                                             |
| `smtp`    | `SMTP_HOST`, `SMTP_USERNAME`, `SMTP_PASSWORD`, and optionally `SMTP_PORT`, `SMTP_TLS` | Any relay. `SMTP_PORT` defaults to `587`. `SMTP_TLS` defaults to `implicit` on port `465` and `starttls` otherwise; `none` is refused in production, and a relay that does not advertise STARTTLS is refused rather than sent credentials in cleartext. |

`qm doctor` proves the Resend key is accepted, or that the SMTP relay is
reachable and answers. Neither proves deliverability — the first real sign-in
link does that.

## Known trade-offs

The sign-in link carries its token in the URL **fragment**, which browsers never
put on the wire, so it reaches no access log, no proxy, and no `Referer`. The
confirmation page moves it from `location.hash` into the form and calls
`history.replaceState`, so it does not linger in the address bar or the history
entry either; the value is held in `sessionStorage` for the life of the tab so a
reload still works. That last step needs JavaScript — the page says so, and the
link can be re-requested if a mail gateway strips the fragment.

The per-mailbox send budget is keyed on the mailbox _and_ the requesting client
address, so a stranger cannot exhaust a known user's budget and lock them out;
the per-address budget is what bounds a single source. Both are durable claims,
so they survive restarts, and both are keyed by an HMAC under
`AUTH_TOKEN_SECRET` so another plugin holding the shared core signing secret
cannot compute — and pre-claim — a chosen mailbox's slots.

## Live password integration tests

`test/password-flow.test.ts` starts the real broker, portal, and admin services and
exercises password login, admin sessions, rejected credentials, external-member
revocation, PKCE, spent codes, rate limits across a broker restart, client-IP
spoofing, and unavailable core. It needs an isolated core backed by a real
Postgres database with no mail service configured; it uses no auth bypass.
No model calls are made.

From the repository root, install dependencies with Node 24, start an isolated
Postgres container, then run core in one terminal:

```bash
npm ci
docker run --rm -d --name qm-auth-test-postgres -e POSTGRES_PASSWORD=qm-local-test -p 127.0.0.1:55439:5432 postgres:16-alpine
```

```bash
export CORE_SIGNING_SECRET="$(openssl rand -hex 32)"
export CONNECTOR_SECRET_KEY="$(openssl rand -hex 32)"
DATABASE_URL=postgres://postgres:qm-local-test@127.0.0.1:55439/postgres \
  NODE_ENV=development ORG_ID=acme DATA_DIR=.context/password-auth-test \
  SESSION_STORE=postgres RUN_STORE=postgres HARNESS=pi WORKERS=0 BACKGROUND_WORK_ENABLED=false \
  ADMIN_GRANTS=admin@example.com:org_admin PORT=18080 node src/index.ts
```

In another terminal, supply the same core signing secret and run:

```bash
AUTH_INTEGRATION_CORE_URL=http://127.0.0.1:18080 \
  AUTH_INTEGRATION_CORE_SIGNING_SECRET="$CORE_SIGNING_SECRET" \
  node --test plugins/auth/test/password-flow.test.ts
```

`AUTH_INTEGRATION_ORG_ID` defaults to `acme` and must match core's `ORG_ID`.
`AUTH_INTEGRATION_ADMIN_EMAIL` defaults to `admin@example.com` and must hold a core
admin grant. Without the two required integration variables, this test is skipped.
The test creates temporary local service processes and shuts them down itself;
stop the dedicated core and Postgres processes when finished.
