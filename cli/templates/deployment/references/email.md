# Email transport for sign-in links

Sign-in uses the built-in `auth` broker, which emails a one-time link. It needs
one transport. SMTP is the default recommendation: any existing mail account or
relay works and there is no DNS wait. Pick Resend only when the operator
prefers it and has DNS control over a domain they are happy to send from.

Set `env.auth.AUTH_EMAIL_TRANSPORT` to `resend` or `smtp` before collecting
secrets, then run `npm exec qm -- setup`, which prompts for exactly the
credentials that choice needs and generates every key itself.

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

## Who may sign in

Set one of these, or the broker refuses to start:

- `env.auth.AUTH_ALLOWED_EMAIL_DOMAIN` for a whole domain, or
- `AUTH_ALLOWED_EMAILS` in `.env` for named addresses — `qm setup` derives it
  from `ADMIN_GRANTS` so the administrator's address is typed once.

## Using an external identity provider instead

Drop `"auth"` from `services`. Sign-in then follows the OIDC path in
`deployment.md`, and the operator supplies `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, and the provider endpoints instead of an email transport.
