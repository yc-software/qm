# Smaller fix for the keyless-harness gate

Same thing #67 hit. I'm on `HARNESS=claude` with a `CLAUDE_CODE_OAUTH_TOKEN`, no API key, Postgres behind it. Admins
get redirected to `/admin/onboarding` on every request and everyone else gets the 503 about the deployment not being
set up. Turns work the whole time, it's just the gate.

Different suggestion for where to fix it though.

There's already a function for this. `modelProviderAvailabilityFor` in `src/model/pi-models.ts:213` takes a harness and
gives back the providers that harness can use, and `claude` falls through to `ALL_PROVIDERS_AVAILABLE`:

```ts
if (harness === "pi") return managedKeys;
if (harness === "opencode") return { ...configKeys, openrouter: false };
if (harness === "codex") return configKeys;
return ALL_PROVIDERS_AVAILABLE; // claude and mock
```

`surface.ts` imports it and uses it at line 933 for the runtime config. Line 892, the onboarding flag, doesn't:

```ts
...(managedKeys ? { modelProviderConfigured: Object.values(managedKeys).some(Boolean) } : {}),
```

So the same file works it out two different ways. `git log -S` puts line 892 in #29, which was about routing the first
admin to onboarding, so I'd guess the harness case just never came up.

What I've got running:

```ts
modelProviderConfigured: Object.values(modelProviderAvailabilityFor(harnessId, managedKeys)).some(Boolean),
```

`harnessId` is already computed in `getSurfaceConfig` and the helper is already imported, so it's the one line. `pi`
and `codex` are unchanged, `claude` and `mock` no longer need a key stored, and `opencode` only shifts if the one
stored key is OpenRouter, which it can't use anyway.

Versus the wiring.ts wrapper in #67: no need to go looking for `CLAUDE_CODE_OAUTH_TOKEN`, and `mock` gets sorted too.
Downside is that `claude` reports configured even with no token set anywhere, so a deploy that really is broken gets a
working UI and failing turns instead of the onboarding page. #67 doesn't have that problem. I'd still take it, because
the onboarding page can't tell you anything useful about OAuth auth either way, but it's a real difference and worth
deciding on before picking one.

Typecheck's clean, `test/model-credential-route.test.ts` is 11/11 and the `surface*` tests are 126/126. Applied it on
our own deployment earlier today. If you want a regression test it'd go in the core surface-config tests, flag true
for `harnessId: "claude"` against an empty credential store.
`plugins/portal/test/onboarding-redirect.test.ts` builds the response by hand so it never gets near this.
