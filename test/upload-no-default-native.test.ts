import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockHarness from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "../src/harness/harness.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

let exercise: ((turn: HarnessTurnInput) => Promise<HarnessTurnResult | void>) | undefined;
mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      const run = harness.turns.runTurn;
      harness.turns.runTurn = async (turn) => (exercise ? ((await exercise(turn)) ?? { reply: "Done" }) : run(turn));
      return harness;
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function scopeWithoutDefault() {
  const built = buildApp(testConfig({ eagerProvisionEnabled: false }));
  await built.directory.replace([{ principalId: "U1", displayName: "Synthetic User", type: "internal" }]);
  await built.directory.replaceChannels(
    [{ channelId: "C1", name: "synthetic-upload", isPrivate: true }],
    [{ channelId: "C1", principalId: "U1" }],
  );
  await built.sandboxResources.initialize();
  const base: Omit<TurnRequest, "text"> = {
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "channel", threadRef: "ch:C1:native", channelRef: "C1", audience: [{ externalId: "U1" }] },
  };
  const files = async () => [
    { name: "shot.png", mimetype: "image/png", ...(await built.blobTransfer.put(PNG)) },
    { name: "notes.txt", mimetype: "text/plain", ...(await built.blobTransfer.put(Buffer.from("SYNTHETIC-42"))) },
  ];
  return { built, base, files };
}

async function artifactText(built: Awaited<ReturnType<typeof scopeWithoutDefault>>["built"], id: string) {
  const opened = await built.files.open(id);
  assert.ok(opened);
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("without a default sandbox, native images and documents still reach the harness", async () => {
  const { built, base, files } = await scopeWithoutDefault();
  let seen: HarnessTurnInput | undefined;
  exercise = async (turn) => {
    seen = turn;
  };
  try {
    const result = await built.app.turn({ ...base, text: "look", attachments: await files() });
    assert.equal(result.status, "ok");
    assert.equal(await built.sandboxResources.resolve("channel:C1"), null);
    assert.equal(Buffer.from(seen!.images![0]!.dataBase64, "base64").length > 0, true);
    assert.equal(Buffer.from(seen!.documents![0]!.dataBase64, "base64").toString(), "SYNTHETIC-42");
    assert.deepEqual(await artifactText(built, seen!.images![0]!.artifactId!), PNG);
    assert.equal((await artifactText(built, seen!.documents![0]!.artifactId!)).toString(), "SYNTHETIC-42");
  } finally {
    exercise = undefined;
  }
});

test("without a default sandbox, a steered upload is registered and surfaced without a computer", async () => {
  const { built, base, files } = await scopeWithoutDefault();
  let steered: Awaited<ReturnType<NonNullable<HarnessTurnInput["prepareSteer"]>>> | undefined;
  exercise = async (turn) => {
    steered = await turn.prepareSteer!("also this", { ...base, text: "also this", attachments: await files() });
  };
  try {
    const result = await built.app.turn({ ...base, text: "start" });
    assert.equal(result.status, "ok");
    assert.equal(await built.sandboxResources.resolve("channel:C1"), null);
    assert.match(steered!.text, /not yet on a computer/);
    assert.equal(steered!.images?.length, 1);
    assert.equal(Buffer.from(steered!.documents![0]!.dataBase64, "base64").toString(), "SYNTHETIC-42");
    const doc = steered!.attachments!.find((a) => a.name === "notes.txt")!;
    assert.equal((await artifactText(built, doc.artifactId!)).toString(), "SYNTHETIC-42");
  } finally {
    exercise = undefined;
  }
});
