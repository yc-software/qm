# Support multiple allowed email domains for portal OIDC

## Context

We self-host QM and sign users in through an external OIDC provider (Entra ID).
Our organization spans two email domains, so the portal single-domain
`OIDC_ALLOWED_EMAIL_DOMAIN` (checked as `email.endsWith("@<domain>")`) cannot
cover both. The only current workaround, `OIDC_ALLOWED_EMAILS`, requires listing
every individual account — fragile as people join.

## Proposal

Add a comma-separated `OIDC_ALLOWED_EMAIL_DOMAINS` (plural) alongside the
existing singular `OIDC_ALLOWED_EMAIL_DOMAIN`:

- Both feed the same domain check in `resolvePrincipal` (`plugins/portal/src/oidc.ts`).
- The singular var stays for backward compatibility.
- The production trust-boundary validation (`plugins/portal/src/index.ts`) counts
  the plural list as satisfying the boundary requirement.
- A new validation rejects invalid entries in the comma-separated list.

I have been running this as a local patch and it works; happy to share the diff if
useful. Principal stays `OIDC_PRINCIPAL_CLAIM=email`.

## Status

Proposed — more detail in issue #672.
