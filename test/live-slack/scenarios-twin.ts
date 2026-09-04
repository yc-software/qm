import { assert, type Scenario } from "./harness.ts";
import { sleep } from "./slack.ts";
import { redeliverChannelMessage, type TwinAdmin } from "./arga.ts";

function pumpTarget(): { signingSecret: string; targetUrl: string } {
  return {
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
    targetUrl: `http://127.0.0.1:${process.env.SLACK_EVENTS_PORT ?? "8182"}/slack/events`,
  };
}

async function patchBotScopes(twin: TwinAdmin, mutate: (scopes: string[]) => string[]): Promise<() => Promise<void>> {
  const config = await twin.getConfig();
  const original = (config.tokens ?? []) as Array<{ token: string; is_bot?: boolean; scopes: string[] }>;
  const patched = original.map((t) => (t.is_bot ? { ...t, scopes: mutate([...t.scopes]) } : t));
  await twin.patchConfig({ tokens: patched });
  return async () => {
    await twin.patchConfig({ tokens: original });
  };
}

export const twinScenarios: Scenario[] = [
  {
    name: "twin-event-redelivery-idempotent",
    lane: "parallel",
    tags: ["twin"],
    timeoutMs: 5 * 60_000,
    async run(ctx) {
      const ch = await ctx.freshChannel();
      const marker = ctx.marker();
      const root = await ch.mention(`Include the exact token ${marker} in your reply.`);
      await ch.waitForBotReply(root);
      const before = (await ch.botMessagesInThread(root)).length;
      const redelivered = await redeliverChannelMessage({
        admin: ctx.env.twin!,
        botUserId: ctx.env.botUserId,
        channel: ch.id,
        ts: root,
        ...pumpTarget(),
      });
      assert.ok(redelivered, "original mention event not found in the twin event log");
      await sleep(45_000);
      const after = (await ch.botMessagesInThread(root)).length;
      assert.equal(after, before, `redelivered event produced ${after - before} extra bot reply/replies`);
    },
  },
  {
    name: "twin-missing-scope-reaction-ack",
    lane: "exclusive",
    tags: ["twin"],
    async run(ctx) {
      const restore = await patchBotScopes(ctx.env.twin!, (scopes) =>
        scopes.filter((s) => s !== "reactions:write" && s !== "reactions:read"),
      );
      try {
        const ch = await ctx.freshChannel();
        const marker = ctx.marker();
        const root = await ch.mention(`Include the exact token ${marker} in your reply.`);
        const reply = await ch.waitForBotReply(root);
        assert.ok(reply.text?.includes(marker), `reply missing token ${marker}: ${reply.text?.slice(0, 300)}`);
      } finally {
        await restore();
      }
    },
  },
  {
    name: "twin-rate-limited-reply-still-lands",
    lane: "exclusive",
    tags: ["twin", "quarantine"],
    timeoutMs: 5 * 60_000,
    async run(ctx) {
      const twin = ctx.env.twin!;
      const config = await twin.getConfig();
      const originalLimits = { rate_limiting_enabled: config.rate_limiting_enabled, rate_limits: config.rate_limits };
      const ch = await ctx.freshChannel();
      const marker = ctx.marker();
      try {
        await twin.patchConfig({
          rate_limiting_enabled: true,
          rate_limits: { "chat.postMessage": { window_seconds: 30, max_requests: 4, retry_after_seconds: 5 } },
        });
        const root = await ch.mention(`Include the exact token ${marker} in your reply.`);
        const reply = await ch.waitForBotReply(root, { timeoutMs: 4 * 60_000 });
        assert.ok(reply.text?.includes(marker), `reply missing token ${marker}: ${reply.text?.slice(0, 300)}`);
      } finally {
        await twin.patchConfig(originalLimits);
      }
    },
  },
];
