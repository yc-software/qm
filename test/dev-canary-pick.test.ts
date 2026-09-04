import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverCanaryChannel, pickCanaryChannel } from "../scripts/dev/lib/canary.ts";

test("pickCanaryChannel prefers #dev-canary, then ci-*, never plain human channels", () => {
  const human = { id: "C1", name: "project-alpha" };
  const ci = { id: "C2", name: "ci-bot2-pong-13526" };
  const dedicated = { id: "C3", name: "dev-canary" };
  assert.equal(pickCanaryChannel([human, ci, dedicated])?.id, "C3");
  assert.equal(pickCanaryChannel([human, ci])?.id, "C2");
  assert.equal(pickCanaryChannel([human]), null);
  assert.equal(pickCanaryChannel([]), null);
});

test("pickCanaryChannel rejects human ci-* channels without a numeric throwaway suffix", () => {
  assert.equal(pickCanaryChannel([{ id: "C7", name: "ci-alerts" }]), null);
  assert.equal(pickCanaryChannel([{ id: "C8", name: "ci-migration" }]), null);
  assert.equal(pickCanaryChannel([{ id: "C9", name: "ci-ping2-15533" }])?.id, "C9");
  assert.equal(pickCanaryChannel([{ id: "C10", name: "ci-envnote-500" }])?.id, "C10");
});

test("discoverCanaryChannel paginates and finds dev-canary on a later page", async () => {
  const pages = [
    { ok: true, channels: [{ id: "C1", name: "project-alpha" }], response_metadata: { next_cursor: "p2" } },
    { ok: true, channels: [{ id: "C2", name: "dev-canary" }], response_metadata: { next_cursor: "" } },
  ];
  let call = 0;
  const fakeFetch = (async () => ({ json: async () => pages[call++] })) as unknown as typeof fetch;
  const found = await discoverCanaryChannel("xoxb-test", fakeFetch);
  assert.equal(found?.id, "C2");
  assert.equal(call, 2);
});

test("discoverCanaryChannel survives a mid-pagination failure with what it has", async () => {
  const first = { ok: true, channels: [{ id: "C3", name: "ci-ping-99" }], response_metadata: { next_cursor: "p2" } };
  let call = 0;
  const fakeFetch = (async () => {
    call++;
    if (call === 1) return { json: async () => first };
    throw new Error("network blip");
  }) as unknown as typeof fetch;
  const found = await discoverCanaryChannel("xoxb-test", fakeFetch);
  assert.equal(found?.id, "C3");
});

test("pickCanaryChannel skips archived channels", () => {
  assert.equal(
    pickCanaryChannel([
      { id: "C4", name: "dev-canary", is_archived: true },
      { id: "C5", name: "ci-x-1" },
    ])?.id,
    "C5",
  );
  assert.equal(pickCanaryChannel([{ id: "C6", name: "ci-x-1", is_archived: true }]), null);
});
