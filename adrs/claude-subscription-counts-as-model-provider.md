# Running on a Claude subscription trips the "deployment isn't set up" gate

I ran QM locally with `HARNESS=claude` and a `CLAUDE_CODE_OAUTH_TOKEN` from
`claude setup-token` — no API key, just my Claude subscription. Chat turns work
fine end to end. But the portal blocks the whole UI with "This deployment isn't
set up yet — an admin still needs to finish setup by adding a model API key",
even though the assistant answers happily underneath.

Where it comes from: the portal gates on `modelProviderConfigured === false`
(`plugins/portal/src/index.ts:1056`), which the core computes in
`src/api/routes/surface.ts:892` from `ModelCredentialStore.availability()`
(`src/model/model-credential-store.ts`) — and that only counts
anthropic/openai/openrouter API keys from env or the admin panel. It never
considers `CLAUDE_CODE_OAUTH_TOKEN`, even though the claude harness passes that
token through to the Claude Code child and serves turns with it.

The local fix that worked for me, in `src/wiring.ts` right after
`createModelCredentialStore(...)` (line ~397): when `config.harness === "claude"`
and `config.claudeProcessEnv.CLAUDE_CODE_OAUTH_TOKEN` (or
`ANTHROPIC_AUTH_TOKEN`) is set, wrap the store so `availability()` reports
`anthropic: true`:

```ts
const claudeSubscriptionAuth =
  config.harness === "claude" &&
  Boolean(config.claudeProcessEnv.CLAUDE_CODE_OAUTH_TOKEN ?? config.claudeProcessEnv.ANTHROPIC_AUTH_TOKEN);
const modelCredentials: ModelCredentialStore = claudeSubscriptionAuth
  ? {
      ...storedModelCredentials,
      availability: async () => ({ ...(await storedModelCredentials.availability()), anthropic: true }),
    }
  : storedModelCredentials;
```

I deliberately didn't fake an anthropic key in `resolve()`/`fallback`, because
resolved keys get injected into harness child processes and an invalid
`ANTHROPIC_API_KEY` would override the OAuth login inside Claude Code.

Ask: count a Claude subscription token as a configured model provider (here or
wherever you'd rather put it), so subscription-only setups don't get told they
aren't set up.
