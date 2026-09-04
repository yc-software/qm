import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTurnOrigin,
  resolveTurnOrigin,
  turnOriginRequestFields,
  type TurnOrigin,
} from "../src/core/turn-origin.ts";

test("legacy turn provenance normalizes to one origin", () => {
  assert.deepEqual(normalizeTurnOrigin({ liveActor: true, triggerTs: "1", entryTs: "1" }), {
    kind: "human",
    messageTs: "1",
    entryTs: "1",
  });
  assert.deepEqual(normalizeTurnOrigin({ unprompted: true, entryTs: "2" }), { kind: "ambient", entryTs: "2" });
  assert.deepEqual(
    normalizeTurnOrigin({
      triggered: true,
      securityScreenData: "external payload",
      triggerDestination: { type: "channel", target: "C1" },
      ownerKeychainUnion: true,
    }),
    {
      kind: "automation",
      screenData: "external payload",
      destination: { type: "channel", target: "C1" },
      useOwnerKeychain: true,
    },
  );
  assert.deepEqual(normalizeTurnOrigin({}), { kind: "direct" });
});

test("combined legacy provenance resolves toward the least interactive origin, keeping authorship", () => {
  assert.deepEqual(
    normalizeTurnOrigin({
      triggered: true,
      unprompted: true,
      liveActor: true,
      triggerTs: "human-ts",
      entryTs: "ambient-ts",
    }),
    { kind: "automation" },
  );
  assert.deepEqual(
    normalizeTurnOrigin({ unprompted: true, liveActor: true, triggerTs: "human-ts", entryTs: "ambient-ts" }),
    {
      kind: "ambient",
      entryTs: "ambient-ts",
      live: true,
    },
    "unprompted + liveActor is a verbatim thread-follow: ambient engagement, live author",
  );
});

test("canonical origins replay through the legacy surface contract", () => {
  const origins: TurnOrigin[] = [
    { kind: "direct" },
    { kind: "human", messageTs: "1", entryTs: "1" },
    { kind: "ambient", entryTs: "2" },
    { kind: "ambient", entryTs: "3", live: true },
    {
      kind: "automation",
      screenData: "payload",
      destination: { type: "channel", target: "C1" },
      useOwnerKeychain: true,
    },
  ];
  for (const origin of origins) assert.deepEqual(normalizeTurnOrigin(turnOriginRequestFields(origin)), origin);
});

test("durable requests from before the origin migration normalize lazily", () => {
  assert.deepEqual(resolveTurnOrigin({ liveActor: true, triggerTs: "1" }), { kind: "human", messageTs: "1" });
  assert.deepEqual(resolveTurnOrigin({ origin: { kind: "ambient", entryTs: "2" }, liveActor: true }), {
    kind: "ambient",
    entryTs: "2",
  });
});

test("typed and legacy provenance resolve toward the least interactive origin", () => {
  assert.deepEqual(resolveTurnOrigin({ origin: { kind: "human" }, triggered: true, securityScreenData: "external" }), {
    kind: "automation",
    screenData: "external",
  });
  assert.deepEqual(resolveTurnOrigin({ origin: { kind: "automation", screenData: "external" }, liveActor: true }), {
    kind: "automation",
    screenData: "external",
  });
});

test("matching automation origins preserve or combine every screening payload", () => {
  assert.deepEqual(
    resolveTurnOrigin({ origin: { kind: "automation" }, triggered: true, securityScreenData: "legacy" }),
    { kind: "automation", screenData: "legacy" },
  );
  const merged = resolveTurnOrigin({
    origin: { kind: "automation", screenData: "typed" },
    triggered: true,
    securityScreenData: "legacy",
  });
  assert.equal(merged.kind, "automation");
  assert.match(merged.kind === "automation" ? (merged.screenData ?? "") : "", /typed/);
  assert.match(merged.kind === "automation" ? (merged.screenData ?? "") : "", /legacy/);
});
