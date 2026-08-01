# Detect Slack OIDC by hostname, not substring

Saw #58 and checked the code. The substring match is there and it's worse than it sounds at first glance.

`usesSlackOidc` in `cli/src/slack-manifests.ts` (line 37) checks whether any of the four OIDC endpoint env vars contain `"slack.com"` using `.includes()` on the raw URL string. A URL like `https://not-slack.com.example/idp` or `https://evil-slack.com/auth` would match, because the string contains the substring regardless of where the hostname boundary actually falls.

The function drives real behavior: it's called from `cli/src/commands/outputs.ts` (decides whether to render the SSO manifest) and `cli/src/commands/init.ts` (scaffolds the manifest on first setup). So a false match doesn't just log something wrong — it generates a Slack SSO manifest for a non-Slack provider, which is confusing at best.

Worth noting: the actual runtime OIDC verification in `plugins/portal/src/oidc.ts` uses `jose`'s `jwtVerify` with an exact issuer match, so this isn't an auth bypass. It's purely a CLI tooling bug — wrong manifest gets generated, operator sees unexpected Slack SSO files in their output.

The fix direction seems straightforward — parse the URL and compare the hostname — but I'm not sure whether subdomains like `enterprise.slack.com` are valid Slack OIDC issuers or if it's always bare `slack.com`. That would affect whether you do an exact match or an `.endsWith` check.

Happy to help verify once a fix is in.
