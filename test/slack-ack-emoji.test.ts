import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAckEmoji } from "../src/slack/config.ts";
import { createAckEmojiPicker } from "../src/slack/ack-emoji.ts";
import { CURATED_ACK_EMOJI, DEFAULT_ACK_REACTIONS, createAckPresenter } from "../src/slack/presenters.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

const ORG = "org:test" as const;

test("parseAckEmoji: normalizes colons/case, splits on commas and spaces, drops junk, dedupes", () => {
  assert.deepEqual(parseAckEmoji(":custom_thinking:, CUSTOM_OK  custom_ok\n:+1:"), [
    "custom_thinking",
    "custom_ok",
    "+1",
  ]);
  assert.deepEqual(parseAckEmoji("bad name!, :also bad:"), ["bad", "also"]);
  assert.deepEqual(parseAckEmoji(""), []);
  assert.deepEqual(parseAckEmoji(undefined), []);
  assert.deepEqual(parseAckEmoji(" , ::, !!"), []);
});

test("config store: ack emoji set/get/clear roundtrip, durable read included", async () => {
  const config = createMemoryConfigStore(ORG);
  assert.equal(config.getAckEmoji(ORG), null);
  assert.equal(await config.getAckEmojiDurable(ORG), null);
  config.setAckEmoji(ORG, ["custom_thinking", "custom_ok"]);
  assert.deepEqual(config.getAckEmoji(ORG), ["custom_thinking", "custom_ok"]);
  assert.deepEqual(await config.getAckEmojiDurable(ORG), ["custom_thinking", "custom_ok"]);
  config.setAckEmoji(ORG, null);
  assert.equal(config.getAckEmoji(ORG), null);
  assert.equal(await config.getAckEmojiDurable(ORG), null);
});

function pickerFixture(opts?: { candidatesOverride?: () => readonly string[] | null }) {
  const core = {} as SlackCoreClient;
  const client = { emoji: { list: async () => ({ emoji: { custom_ok: "https://x/a.png" } }) } };
  return { picker: createAckEmojiPicker(core, opts), client };
}

test("ackPickCandidates: a live org override fully replaces the stock candidate set", async () => {
  let names: string[] | null = ["custom_thinking", "custom_ok"];
  const { picker, client } = pickerFixture({ candidatesOverride: () => names });
  assert.deepEqual(picker.ackPickCandidates(client), ["custom_thinking", "custom_ok"]);
  names = null;
  const candidates = picker.ackPickCandidates(client);
  for (const name of [...CURATED_ACK_EMOJI, ...DEFAULT_ACK_REACTIONS]) assert.ok(candidates.includes(name));
});

test("ackPickCandidates: without an override the curated + default sets remain", () => {
  const { picker, client } = pickerFixture();
  const candidates = picker.ackPickCandidates(client);
  for (const name of [...CURATED_ACK_EMOJI, ...DEFAULT_ACK_REACTIONS]) assert.ok(candidates.includes(name));
});

test("ack presenter: fallback reaction draws from the org set when provided", async () => {
  const added: string[] = [];
  const presenter = createAckPresenter({
    postAck: async () => {},
    addReaction: async (name) => {
      added.push(name);
    },
    removeReaction: async () => {},
    emojiCandidates: ["custom_thinking"],
    reactionDelayMs: 1,
  });
  await new Promise((r) => setTimeout(r, 20));
  await presenter.drain();
  assert.deepEqual(added, ["custom_thinking"]);
  await presenter.settle();
});
