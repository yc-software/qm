import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createMockHarness } from "./support/mock-harness.ts";
import type { TurnRequest } from "../src/types.ts";

async function app(fallbackModelId = "gpt-6.1-terra") {
  const built = buildApp(testConfig({ harness: "pi", openaiApiKey: "sk-test" }), {
    harnesses: { pi: createMockHarness() },
  });
  await built.config.setPurposeRuntime("fallback", { harnessId: "pi", modelId: fallbackModelId });
  return built;
}

const turn = (model: string, extra: Partial<TurnRequest> = {}): TurnRequest => ({
  surface: "cron",
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef: `dm:U1:${model}` },
  text: "post the standup",
  triggered: true,
  unattended: true,
  model,
  harness: "pi",
  ...extra,
});

test("an unattended turn on a model this deployment can't serve runs on the fallback runtime", async () => {
  const built = await app();
  const res = await built.app.turn(turn("claude-sonnet-5"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(res.runtime?.modelId, "gpt-6.1-terra");
  assert.equal(
    res.runtime?.change && "rule" in res.runtime.change ? res.runtime.change.rule : undefined,
    "model fallback",
  );
  assert.match(
    res.runtime?.change && "reason" in res.runtime.change ? (res.runtime.change.reason ?? "") : "",
    /^pi\/claude-sonnet-5 can't run here/,
  );
});

test("an unattended turn on an unknown model id runs on the fallback runtime", async () => {
  const res = await (await app()).app.turn(turn("claude-opus-5.5"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(res.runtime?.modelId, "gpt-6.1-terra");
  assert.equal(
    res.runtime?.change && "rule" in res.runtime.change ? res.runtime.change.rule : undefined,
    "model fallback",
  );
});

test("an unattended turn on a usable model keeps it", async () => {
  const res = await (await app()).app.turn(turn("gpt-6.1-sol"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(res.runtime?.modelId, "gpt-6.1-sol");
  assert.equal(res.runtime?.change, undefined);
});

test("when the fallback can't run either, the unattended turn fails with both reasons", async () => {
  const built = await app("claude-opus-5");
  await assert.rejects(
    built.app.turn(turn("claude-sonnet-5")),
    /pi\/claude-sonnet-5 can't run here .* The fallback runtime can't run either: pi\/claude-opus-5 can't run here/,
  );
});

test("a triggered turn whose model a person just chose is still refused, not swapped", async () => {
  const res = await (await app()).app.turn(turn("claude-sonnet-5", { surface: "loop", unattended: undefined }));
  assert.equal(res.status, "refused");
  assert.match(res.reason ?? "", /^pi\/claude-sonnet-5 can't run here/);
});

test("an unknown model whose fallback can't run either fails with both reasons as sentences", async () => {
  await assert.rejects(
    (await app("claude-opus-5")).app.turn(turn("claude-opus-5.5")),
    /runtime pi\/claude-opus-5\.5 is not approved\. The fallback runtime can't run either: /,
  );
});
