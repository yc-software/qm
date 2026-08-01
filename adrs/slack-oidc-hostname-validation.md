# Validate Slack OIDC endpoints by hostname

I noticed that the Slack OIDC detection currently looks for `slack.com` as a
substring in the configured endpoint.

That can produce a false positive. For example, an endpoint such as
`https://not-slack.com.example/idp` would be treated as Slack even though it
belongs to another identity provider. The CLI could then advertise Slack SSO
configuration for a deployment that does not use Slack identity.

I think the smallest safe change is to parse each endpoint as a URL and compare
its hostname against an explicit Slack hostname allowlist. Malformed endpoints
should fail closed.

The tests could cover:

- the legitimate Slack hostname;
- any intentionally supported Slack subdomains;
- a hostname that only contains `slack.com` as a substring;
- malformed endpoint values;
- mixed endpoint configurations.

The implementation should also make the mixed-value behavior explicit: a
malformed or non-Slack value must not turn a non-Slack configuration into a
Slack configuration, and the accepted URL scheme should be documented.

This keeps the security decision in one shared helper and avoids silently
generating the wrong authentication setup.
