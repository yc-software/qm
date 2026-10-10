# Choose sign-in

Offer three routes: email and password for getting started, email links, or
an external OIDC provider such as Slack. The password username is the user's
email address, not a separate username. Do not require Resend, SMTP, DNS, or
an identity-provider registration for password onboarding.

## Email and password

Keep `auth` in `services`. Use a release whose auth image and CLI support
`AUTH_PASSWORD_USERS`; if the installed release does not, upgrade deliberately
or offer `qm admin-login` rather than inventing a password setting.

1. Set `ADMIN_GRANTS=<verified-work-email>:org_admin` and ensure that address
   is admitted by `AUTH_ALLOWED_EMAILS` or `env.auth.AUTH_ALLOWED_EMAIL_DOMAIN`.
   A password does not grant a role or bypass the email allowlist.
2. Generate a password hash with the helper in the deployment's pinned auth
   image (use that exact image reference in place of `<auth-image>`):

   ```bash
   docker run --rm -it --entrypoint node <auth-image> \
     /app/src/hash-password.ts admin@example.com
   ```

   The operator enters and confirms a password of at least 12 characters at
   the hidden prompts. The helper prints `<email>:scrypt$...`, not the password.
   The package-consumer repository does not contain `plugins/auth/src`; do not
   ask the operator to clone QM to run a source-checkout command.

3. Save the complete output as `AUTH_PASSWORD_USERS` in the private, gitignored
   `.env` through `npm exec qm -- secrets set AUTH_PASSWORD_USERS '<email>:<hash>'`.
   Single quotes preserve the hash's `$` characters. Multiple users are
   comma-separated entries. Never put the plaintext password in chat, config,
   command arguments, or shell history; treat the hash as a secret too.
4. Run `npm exec qm -- setup` and decline email configuration. Deploy using
   the selected provider workflow, then have the operator sign in with their
   email and password and verify the Admin page and a real web response.

This is an onboarding option, not password self-service: no password reset or
registration flow is implied. Once set up, configure email links or an identity
provider, verify that replacement works, then unset `AUTH_PASSWORD_USERS` and
redeploy. Do not remove the working login route first.

## Other routes

- Email links: follow `email.md` for SMTP or Resend.
- Slack OIDC: follow `slack.md`; the bot integration remains optional.
- Another OIDC provider: follow the endpoint configuration in `deployment.md`.
- Administrator-only bootstrap: `npm exec qm -- admin-login` works without
  email setup and does not create an account or grant an administrator role.
