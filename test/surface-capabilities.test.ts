import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { surfaceCapabilities, surfaceForDeliveryType } from "../src/surfaces/surface-capabilities.ts";

const guestChannel = (surface: string, channel: string) => ({
  surface,
  actor: { externalId: `${surface}:111` },
  conversation: {
    kind: "channel" as const,
    threadRef: `${surface}:th:${channel}`,
    channelRef: channel,
    audience: [{ externalId: `${surface}:111` }, { externalId: `${surface}:222`, isExternalGuest: true }],
  },
  text: "hello",
});

test("discord channel turn with a guest reader is refused", async () => {
  const built = buildApp(testConfig({}));
  const result = await built.app.turn(guestChannel("discord", "900"));
  assert.equal(result.status, "refused");
  assert.match(result.reason ?? "", /non-internal participant/);
});

test("the Slack external-participants flag never opens a discord channel", async () => {
  const built = buildApp(testConfig({}));
  built.config.setExternalSlackParticipants("org:default-org" as never, true);
  const result = await built.app.turn(guestChannel("discord", "901"));
  assert.equal(result.status, "refused");
});

test("delivery types map back to their surface", () => {
  assert.equal(surfaceForDeliveryType("principal"), "slack");
  assert.equal(surfaceForDeliveryType("group"), "slack");
  assert.equal(surfaceForDeliveryType("discord"), "discord");
  assert.equal(surfaceForDeliveryType("discord-dm"), "discord");
  assert.equal(surfaceForDeliveryType("web"), undefined);
  assert.equal(surfaceCapabilities("discord")?.coreAmbient, false);
  assert.equal(surfaceCapabilities("slack")?.coreAmbient, true);
});

async function judgmentsFor(built: ReturnType<typeof buildApp>, container: string) {
  for (let i = 0; i < 50; i++) {
    const rows = (await built.ambientJudgments?.list({ container })) ?? [];
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

test("discord ingest never runs the ambient judge", async () => {
  const built = buildApp(testConfig({}));
  await built.app.ingestSurfaceEvents([{ container: "C77", ts: "1.0", authorId: "U1", text: "hi" }], "slack");
  assert.equal((await judgmentsFor(built, "C77")).length, 1, "control: slack ingest must record a judgment");
  await built.app.ingestSurfaceEvents(
    [{ container: "1234567890123456789", ts: "1234567890123456790", authorId: "discord:1", text: "hi" }],
    "discord",
  );
  assert.equal((await judgmentsFor(built, "1234567890123456789")).length, 0);
});

test("a direct or scheduled ambient judgment of a discord container never acts", async () => {
  const built = buildApp(testConfig({}));
  await built.app.ingestSurfaceEvents(
    [{ container: "1234567890123456780", ts: "1234567890123456781", authorId: "discord:1", text: "hi" }],
    "discord",
  );
  assert.deepEqual(await built.app.judgeAmbientContainer("discord", "1234567890123456780", { reason: "scheduled" }), {
    act: false,
  });
  assert.equal((await judgmentsFor(built, "1234567890123456780")).length, 0);
});
