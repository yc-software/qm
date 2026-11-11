import { assert, type Scenario } from "./harness.ts";
import { sleep } from "./slack.ts";

const notFound = (err: Error) => {
  if (/: 404 /.test(err.message)) return null;
  throw err;
};

export const ambientScenarios: Scenario[] = [
  {
    name: "ambient-helper-same-channel",
    lane: "parallel",
    timeoutMs: 10 * 60_000,
    async run(ctx) {
      const { core, qaUserId, botUserId } = ctx.env;
      const fixture = process.env.LIVE_E2E_PRIVATE_CHANNEL;
      const channel = fixture ? await ctx.fixtureChannel(fixture) : await ctx.freshChannel({ isPrivate: true });
      await core.waitForChannelMembership(channel.id, qaUserId);
      const scope = `channel:${channel.id}`;
      const marker = ctx.marker();
      const prior = (await core.ambientPolicy(channel.id)) ?? { orders: "", ambientEnabled: null };
      await core.setAmbientPolicy(channel.id, {
        orders: `Whenever someone here asks for a summary of the fictional Project ${marker} deal note, engage without being mentioned: open a subagent helper in this channel to write a two-line summary of the made-up note (invent it; no real data, no tools), then post the helper's summary here including the code ${marker}.`,
        ambientEnabled: true,
      });
      try {
        assert.equal((await core.ambientPolicy(channel.id))?.ambientEnabled, true, "ambient is on for this channel");
        const root = await channel.say(
          `Could someone summarise the fictional Project ${marker} deal note? Purely made-up, no real company.`,
        );
        const known = new Map<string, { threadRef?: string; scopeId?: string; parentSessionId?: string | null }>();
        let parent: string | undefined;
        let child: { id: string; scopeId?: string } | undefined;
        for (const deadline = Date.now() + 8 * 60_000; Date.now() < deadline && !(parent && child); await sleep(5000)) {
          const { sessions } = await core.listSessions("all");
          for (const s of sessions) {
            if (!known.has(s.id)) {
              const full = await core.getSession(s.id).catch(notFound);
              if (full) known.set(s.id, full.session);
            }
          }
          parent ??= [...known].find(([, s]) => s.threadRef?.includes(`:${channel.id}:ambient:`))?.[0];
          const found = [...known].find(([, s]) => parent && s.parentSessionId === parent);
          if (found) child = { id: found[0], scopeId: found[1].scopeId };
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
        const { items } = await core.getSession(parent);
        assert.ok(
          items.some((item) => {
            const text = JSON.stringify(item);
            return text.includes("subagent-message") && text.includes(child.id);
          }),
          "the helper's returned result reached the ambient worker",
        );
        const { errors } = await core.listErrors();
        const ours = errors.filter((e) => e.sessionId === parent || e.sessionId === child.id);
        assert.deepEqual(ours, [], "no refusal or error recorded for the worker or its helper");
      } finally {
        await core
          .setAmbientPolicy(channel.id, prior)
          .catch((err: Error) => console.error(`ambient policy restore failed for ${channel.id}: ${err.message}`));
      }
    },
  },
];
