import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import { createHarnessRouter } from "../src/harness/harness-router.ts";
import { recoveredRuntime, recoveredModelAccount } from "../src/harness/runtime-recovery.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import type { HarnessTurnInput, RuntimeChoice } from "../src/harness/harness.ts";
import type { SessionEntry } from "../src/types.ts";

for (const [modelId, account, child] of [
  ["gpt-5.6-luna", "company", false],
  ["gpt-5.6-luna", "company", true],
  ["claude-haiku-4-5", "anthropic", false],
  ["gpt-5.6-luna", "openai", true],
] as const) {
  test(`provider refusal preserves ${account} ${modelId} ${child ? "child" : "parent"} runtime`, async () => {
    const harness = createPiHarness({ apiKey: "sk-company-anthropic-test", openaiApiKey: "sk-company-openai-test" });
    const choice: RuntimeChoice = { harnessId: "pi", modelId, effortLevel: "low", fastMode: false };
    const router = createHarnessRouter(new Map([["pi", harness]]), harness, () => choice);
    const requests: Array<{ model: string; credential: string | null }> = [];
    const entries: SessionEntry[] = [];
    let nested = 0;
    const realFetch = globalThis.fetch;
    const refusal =
      "Synthetic transport fixture: this would violate Anthropic's Terms of Service. API integrators: you can reduce refusals for your users by configuring a fallback model.";
    globalThis.fetch = async (_url, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { model: string };
      const headers = new Headers(init?.headers);
      requests.push({ model: payload.model, credential: headers.get("x-api-key") ?? headers.get("authorization") });
      return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: refusal } }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    };
    try {
      await assert.rejects(
        router.turns.runTurn({
          session: {
            id: "refusal-fixture",
            threadRef: child ? "agent:main:subagent:refusal" : "web:actor:refusal",
          } as HarnessTurnInput["session"],
          runId: "run",
          runtimeActorId: "actor",
          runtimeAccount: account,
          input: "Say hello.",
          systemPrompt: "Harmless synthetic transport test.",
          history: [],
          scopeLabel: "personal:actor",
          orgScopeId: "org:test",
          runtime: choice,
          ...(account === "company" ? {} : { providerKeys: { [account]: "sk-personal-test" } }),
          tools: {
            sessionSyscalls: {
              async open() {
                nested++;
                throw new Error("a refused response cannot create a nested child");
              },
              async write() {
                throw new Error("unexpected write");
              },
              async read() {
                return { ok: true, mode: "children", children: [] };
              },
            },
          } as unknown as HarnessTurnInput["tools"],
          async emit(entry) {
            const saved = {
              ...entry,
              sessionId: "refusal-fixture",
              seq: entries.length,
              parentSeq: null,
              createdAt: Date.now(),
            };
            entries.push(saved);
            return saved;
          },
          recordModelCall() {},
          recordLlmRequest() {},
        }),
        (error: unknown) => error instanceof NonRetryableTurnError && error.message.includes(refusal),
      );
      assert.equal(requests.length, 1, "no alternate-model or alternate-provider request after refusal");
      assert.equal(requests[0]!.model, modelId);
      assert.match(requests[0]!.credential ?? "", account === "company" ? /company/ : /personal/);
      assert.equal(nested, 0);
      assert.deepEqual(recoveredRuntime(entries, "run", "actor"), choice);
      assert.equal(recoveredModelAccount(entries, "run", "actor"), account);
      assert.equal(
        entries.some((entry) => entry.type === "assistant"),
        false,
        "the refusal is not stored as successful output",
      );
    } finally {
      globalThis.fetch = realFetch;
      await router.turns.close?.();
    }
  });
}
