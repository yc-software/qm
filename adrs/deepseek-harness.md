# DeepSeek Harness as a harness

Ask: add DeepSeek Harness (`dsh`) as another inner engine, same seat as pi / opencode / codex / claude.

Not the DeepSeek model provider (that's PR 265). The harness itself: https://github.com/deepseek-ai/deepseek-harness

Why we'd want it: it's the loop DeepSeek measures their agent benches in, and it already speaks JSON-RPC (and ACP). Transport-wise that looks like the Codex adapter, not a new protocol.

The work, as we read it from the existing four:

- a `dsh` adapter through `defineHarness` / `runTurn`
- rebind its tools onto QM's sandbox (same brain/hands split as the others)
- add `dsh` to `HARNESS_IDS`, or do issue 542 first so this doesn't touch the closed set

We're not sending an implementation. If this is in scope we'd use it. If you'd rather keep the set at four, that's fine.

Status: request, no code.
