# ADR-0002: Add GitHub Copilot as a harness

**Status:** Proposed
**Date:** 2026-08-02

## Context

`HARNESS` accepts `mock`, `pi`, `opencode`, `codex`, and `claude`. GitHub Copilot
is the one widely-used coding agent with no adapter, which is a gap against the
README's claim that a deployment isn't tied to any single vendor — Copilot is the
default agent inside organizations already standardized on GitHub.

GitHub now ships the Copilot SDK (public preview April 2026) with a
JavaScript/TypeScript client that talks to the same agent runtime behind the
Copilot CLI, so an adapter no longer requires driving an interactive CLI.

## Decision

Target the SDK, not the CLI. GitHub removed `--headless --stdio` from the CLI
without a deprecation period (github/copilot-cli#1606), breaking the SDK and every
downstream integration built on it, so the CLI's programmatic surface is not a
stable dependency. The SDK can manage the CLI process lifecycle itself or attach
to one running in server mode; the latter fits a long-lived core process better.

## Implementation sketch

The adapter boundary is already the right shape, so this is additive:

- `src/config.ts` — add `"copilot"` to the harness union (line 31); add a
  `copilotProcessEnv` allow-list mirroring `claudeProcessEnv`, carrying `PATH`,
  TLS/proxy variables, and the GitHub credential only.
- `src/model/pi-models.ts` — add `"copilot"` to `HARNESS_IDS`, register the model
  entries, and extend `modelSupportedByHarness`.
- `src/harness/copilot-harness.ts` — new adapter exporting
  `createCopilotHarness` and `copilotHarnessConfigOptions`, built with
  `defineHarness(profile, implementation)` the way `claude-harness.ts` is.
- `src/wiring.ts` — register it in the harness map alongside the `"claude"` entry.
- Tests mirroring `test/claude-harness.test.ts`, `test/claude-harness-turn.test.ts`,
  and `test/harness-adapter.test.ts`.

Worth noting for scoping: `HarnessImplementation` requires only `runTurn`.
`close`, `resetSession`, `shouldRespond`, `compactHistory`, `contextTokenBudget`,
`oneShot`, `judge`, `screenSecurity`, `pickAckEmoji`, `generateTitle`, and
`summarizeApproval` are all optional and degrade gracefully, so a first adapter
can be `runTurn` plus a capability profile, with the auxiliary model utilities
added once the turn path is proven. That makes this considerably smaller than the
~900-line existing adapters at MVP.

## Consequences

- One more adapter, plus tests and a model-availability entry.
- The SDK is in public preview, so expect breaking changes; the harness boundary
  keeps that churn out of core.
- Copilot's default model has changed over time, so the default must stay
  configurable rather than assumed, and `screenSecurity` should not presume a
  particular provider.
- Capability flags matter here: whatever the adapter cannot support should be
  declared absent in the profile rather than stubbed, so the router can route
  around it.

## Open question

Is Copilot in scope for QM, or is the harness set deliberately limited to agents
that run fully locally?
