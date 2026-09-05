# Email transport for sign-in links

Ordinary sign-in uses the built-in `auth` broker, which emails a one-time link.
Administrators can start without email: leave the sender and selected transport's
credentials unset, then run `qm admin-login` after deployment. It prints a private,
single-use login link valid for five minutes. The selected account must already
have `org_admin` access. Other users need email or an external identity provider.

Email sign-in needs one transport. SMTP is the default recommendation: any existing mail account or
relay works and there is no DNS wait. Pick Resend only when the operator
prefers it and has DNS control over a domain they are happy to send from.

Set `env.auth.AUTH_EMAIL_TRANSPORT` to `resend` or `smtp` before collecting
secrets, then run `npm exec qm -- setup` and choose to configure email. It prompts
for exactly the credentials that choice needs and generates every signing key
itself. Email sign-in activates when the sender and every selected credential
are present. Missing credentials disable email sign-in without stopping QM or
`qm admin-login`, even if a sender is still configured.

## What you can do, and what only the operator can

| Step                                                | Who                                              |
| --------------------------------------------------- | ------------------------------------------------ |
| Choose the transport and set `AUTH_EMAIL_TRANSPORT` | you                                              |
| Create the Resend account                           | operator (it is their billing relationship)      |
| Mint the Resend API key                             | operator, or you if they hand you console access |
| **Add the domain's DNS records**                    | **operator — needs DNS control**                 |
| Obtain SMTP host, username, password                | operator                                         |
| Enter the values into `.env` through `qm setup`     | you                                              |
| Confirm a real sign-in link arrives                 | operator, in their inbox                         |

Domain verification is the step most likely to stall an otherwise-autonomous
deploy: it needs registrar or DNS-provider access you will not have. Raise it
with the operator early, before you start collecting secrets, rather than
discovering it at `qm doctor`.

## Resend

1. Operator creates an account at <https://resend.com>.
2. Under **Domains**, add the sending domain and publish the DKIM/SPF records
   Resend prints. This requires DNS control and can take minutes to hours to
   verify. Sending from an unverified domain fails at delivery time, not at
   `qm doctor`.
3. Under **API keys** (<https://resend.com/api-keys>), create a key with send
   access. It starts with `re_`.
4. `qm setup` collects it as `RESEND_API_KEY` and the verified sender as
   `AUTH_EMAIL_FROM` (for example `Acme <no-reply@acme.com>`).

`qm doctor` calls the Resend API to prove the key is accepted. It cannot prove
the domain is verified — check the Domains page.

## SMTP

Any relay works: Postmark, Amazon SES, SendGrid, Fastmail, Google Workspace, or
the operator's own mail server. Collect the host, username, and password.

`qm setup` collects `SMTP_HOST`, `SMTP_USERNAME`, and `SMTP_PASSWORD`. Two
optional settings live in `env.auth`:

- `SMTP_PORT` defaults to `587`.
- `SMTP_TLS` defaults to `implicit` when the port is `465` and `starttls`
  otherwise. `none` is refused in production, and a relay that does not
  advertise STARTTLS is refused rather than sent credentials in cleartext.

`qm doctor` proves the relay is reachable and answers. It does not authenticate;
wrong credentials surface on the first real send.

### Gmail / Google Workspace app password

The fastest SMTP path when the operator already has a Google account: no new
account, no DNS wait.

1. The account must have 2-Step Verification enabled — Google only offers app
   passwords with it on.
2. Operator visits <https://myaccount.google.com/apppasswords>, creates an app
   password, and hands you the 16-character value.
3. `qm setup` values: `SMTP_HOST` is `smtp.gmail.com`, `SMTP_USERNAME` is the
   full address of the account that minted the app password, `SMTP_PASSWORD` is
   the app password (spaces optional).
4. Set `AUTH_EMAIL_FROM` to that same address — Gmail rewrites the From header
   to the authenticated account, so any other sender silently becomes wrong.

Two limits to raise with the operator: Gmail caps sending at roughly 2,000
messages a day (a few hundred for free accounts), fine for sign-in links but
not bulk mail; and a Workspace admin can disable app passwords org-wide, in
which case the page in step 2 refuses to create one and you need a different
relay.

### Amazon SES when there is no domain

SES works without owning a domain: verify a single email address instead.

1. In the SES console, under **Identities**, create an email-address identity
   and click the verification link SES sends to it.
2. Under **SMTP settings**, create SMTP credentials (an IAM user with a
   generated SMTP password — not the AWS access key itself).
3. `qm setup` values: `SMTP_HOST` is the region endpoint (for example
   `email-smtp.us-east-1.amazonaws.com`), `SMTP_USERNAME` and `SMTP_PASSWORD`
   are the generated SMTP credentials, and `AUTH_EMAIL_FROM` is the verified
   address.

New SES accounts start in the sandbox, which only delivers to verified
addresses. That is enough for a single administrator signing in with the
verified address; for a whole team, the operator requests production access
from the SES console (usually granted within a day) or verifies each
recipient.

## Invitation emails for external users

Admins invite people outside the organization from the admin Users tab or by
chatting with QM. Core emails those invitations through Resend, so the CLI
delivers `RESEND_API_KEY` and `AUTH_EMAIL_FROM` to core as well as to the
broker. Both are optional on core: without them the invitation is still created
and the admin shares the sign-in link by hand. Core also receives
`AUTH_ALLOWED_EMAIL_DOMAIN`, so an address in the organization's own domain is
refused as an external user; those people sign in directly.

## Who may sign in

Set one of these, or the broker refuses to start:

- `env.auth.AUTH_ALLOWED_EMAIL_DOMAIN` for a whole domain, or
- `AUTH_ALLOWED_EMAILS` in `.env` for named addresses — `qm setup` derives it
  from `ADMIN_GRANTS` so the administrator's address is typed once.

## Using an external identity provider instead

Drop `"auth"` from `services`. Sign-in then follows the OIDC path in
`deployment.md`, and the operator supplies `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, and the provider endpoints instead of an email transport.
