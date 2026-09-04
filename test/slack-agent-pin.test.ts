import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSlackEvents } from "../src/slack/events.ts";
import { createDeduper } from "../src/slack/lib.ts";
import type { TurnHandler } from "../src/slack/turn-handler.ts";

function fakeApp() {
  const events = new Map<string, (args: any) => Promise<void>>();
  const messages: Array<(args: any) => Promise<void>> = [];
  return {
    app: {
      event: (name: string, h: (args: any) => Promise<void>) => void events.set(name, h),
      message: (h: (args: any) => Promise<void>) => void messages.push(h),
    },
    fire: (name: string, event: unknown) => events.get(name)!({ event, body: {}, client: {}, context: {} }),
    hasEvent: (name: string) => events.has(name),
    im: (message: Record<string, unknown>) =>
      messages[0]!({ message: { channel_type: "im", ...message }, body: {}, client: {}, context: {} }),
  };
}

test("assistant events are acknowledged as no-ops and pane messages dispatch as plain DM turns", async () => {
  const dispatched: any[] = [];
  const app = fakeApp();
  registerSlackEvents(app.app, {
    handler: {
      dispatch: async (_key: string, inc: any) => void dispatched.push(inc),
      handleReactionEvent: async () => {},
      botHasStakeInThread: async () => false,
    } as unknown as TurnHandler,
    mirror: { mirrorMessageEvent: async () => {}, pushSurfaceEvents: async () => {} } as any,
    directory: { syncForUnseenGroup: () => {}, forceDirectorySync: async () => {} } as any,
    ids: { botUserId: "UBOT", ownBotId: "BBOT" } as any,
    deduper: createDeduper(),
  });
  assert.equal(app.hasEvent("assistant_thread_started"), true);
  assert.equal(app.hasEvent("assistant_thread_context_changed"), true);
  await app.fire("assistant_thread_started", { assistant_thread: { channel_id: "D111", thread_ts: "100.1" } });
  await app.im({ channel: "D111", user: "U1", text: "hello", ts: "100.2", thread_ts: "100.1" });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].kind, "dm");
  assert.equal(dispatched[0].threadTs, "100.1");
  assert.equal(dispatched[0].contextNote, undefined);
});
