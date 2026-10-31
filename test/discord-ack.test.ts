import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createDiscordAck } from "../src/discord/ack.ts";
import { ACK_REACTION_DELAY_MS } from "../src/surfaces/ack-presenter.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());
const flush = () => new Promise((r) => setImmediate(r));

const trigger = { channelId: "c1", messageId: "m1" };

function recorder() {
  const log: string[] = [];
  return {
    log,
    sender: {
      react: async (c: string, m: string, e: string) => void log.push(`react:${c}:${m}:${e}`),
      unreact: async (c: string, m: string, e: string) => void log.push(`unreact:${c}:${m}:${e}`),
    },
  };
}

test("after the delay the trigger gets one of the default ack emoji and settle removes that same emoji", async () => {
  const { log, sender } = recorder();
  const ack = createDiscordAck(sender, trigger);
  mock.timers.tick(ACK_REACTION_DELAY_MS);
  await flush();
  await ack.settle();
  assert.equal(log.length, 2);
  const emoji = log[0]!.replace("react:c1:m1:", "");
  assert.ok(["👀", "🔍", "⏳", "🔭", "🫡"].includes(emoji));
  assert.equal(log[1], `unreact:c1:m1:${emoji}`);
});

test("settling before the delay never reacts", async () => {
  const { log, sender } = recorder();
  const ack = createDiscordAck(sender, trigger);
  await ack.settle();
  mock.timers.tick(ACK_REACTION_DELAY_MS);
  await flush();
  assert.deepEqual(log, []);
});

test("a first streamed block sends nothing to Discord because it has no text ack", async () => {
  const { log, sender } = recorder();
  const ack = createDiscordAck(sender, trigger);
  ack.onFirstBlock("Looking into it");
  await ack.settle();
  assert.deepEqual(log, []);
});
