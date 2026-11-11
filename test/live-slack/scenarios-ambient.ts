import { assert, type Scenario } from "./harness.ts";
import { sleep } from "./slack.ts";

export const ambientScenarios: Scenario[] = [
  {
    name: "ambient-helper-same-channel",
    lane: "parallel",
    timeoutMs: 10 * 60_000,
    async run(ctx) {
      const { core, qaUserId, botUserId } = ctx.env;
      const channel = await ctx.freshChannel({ isPrivate: true });
      await core.waitForChannelMembership(channel.id, qaUserId);
      const scope = `channel:${channel.id}`;
      const marker = ctx.marker();
      await core.setAmbientPolicy(
        channel.id,
        `Whenever someone here asks for a summary of the fictional Project ${marker} deal note, engage without being mentioned: open a subagent helper in this channel to write a two-line summary of the made-up note (invent it; no real data, no tools), then post the helper's summary here including the code ${marker}.`,
        true,
      );
      try {
        const written = await core.scopeConfig(scope);
        assert.equal(written.ambientPolicy?.ambientEnabled, true, "ambient is enabled only on the fixture channel");
        const root = await channel.say(
          `Could someone summarise the fictional Project ${marker} deal note? Purely made-up, no real company.`,
        );
        let parent: { id: string; items: unknown[] } | undefined;
        let child: { id: string; scopeId?: string; items: unknown[] } | undefined;
        for (const deadline = Date.now() + 8 * 60_000; Date.now() < deadline && !(parent && child); await sleep(5000)) {
          const { sessions } = await core.listSessions("all");
          for (const s of sessions) {
            const full = await core.getSession(s.id).catch(() => null);
            if (!full) continue;
            if (full.session.threadRef?.includes(`:${channel.id}:ambient:`)) parent = { id: s.id, items: full.items };
            else if (parent && full.session.parentSessionId === parent.id)
              child = { id: s.id, scopeId: full.session.scopeId, items: full.items };
          }
        }
        assert.ok(parent, "an unmentioned message started an ambient worker in the private channel");
        assert.ok(child, "the ambient worker opened a helper session");
        assert.equal(child.scopeId, scope, "the helper runs in the same private channel's scope");
        const reply = await channel.waitForBotReply(root, {
          includeChannel: true,
          timeoutMs: 6 * 60_000,
          match: new RegExp(marker),
        });
        assert.ok(reply.user === botUserId && reply.text?.includes(marker), "the worker's reply lands in the channel");
        const finalParent = await core.getSession(parent.id);
        assert.ok(
          finalParent.items.some((item) => {
            const text = JSON.stringify(item);
            return text.includes("subagent-message") && text.includes(child.id);
          }),
          "the helper's returned result reached the ambient worker",
        );
        const { errors } = await core.listErrors();
        const ours = errors.filter((e) => e.sessionId === parent.id || e.sessionId === child.id);
        assert.deepEqual(ours, [], "no refusal or error recorded for the worker or its helper");
      } finally {
        await core.setAmbientPolicy(channel.id, "", null).catch(() => {});
      }
    },
  },
];
