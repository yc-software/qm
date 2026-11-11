import { assert, type Scenario } from "./harness.ts";
import { sleep } from "./slack.ts";

const notFound = (err: Error) => {
  if (/: 404 /.test(err.message)) return null;
  throw err;
};

interface StoredSession {
  threadRef?: string;
  scopeId?: string;
  parentSessionId?: string | null;
  spawnMeta?: { actor?: { id?: string }; origin?: { kind?: string }; unprompted?: boolean };
}

const itemText = (item: unknown): string => {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(item);
  return out.join("\n");
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
      const channelActor = `system:channel:${channel.id}`;
      const marker = ctx.marker();
      const prior = (await core.ambientPolicy(channel.id)) ?? { orders: "", bots: {}, ambientEnabled: null };
      const restore = { orders: prior.orders, bots: prior.bots ?? {}, ambientEnabled: prior.ambientEnabled };
      let failure: unknown;
      try {
        await core.setAmbientPolicy(channel.id, {
          orders: `Whenever a fictional Project ${marker} deal note is posted here, engage without being mentioned: open a subagent helper in this channel to write a two-line summary of the made-up note (no real data, no tools), then post the helper's summary in the note's thread including the code ${marker}.`,
          bots: restore.bots,
          ambientEnabled: true,
        });
        assert.equal((await core.ambientPolicy(channel.id))?.ambientEnabled, true, "ambient is on for this channel");
        const baseline = new Set((await core.listSessions("all")).sessions.map((s) => s.id));
        const root = await channel.say(
          `Fictional Project ${marker} deal note: a made-up seed round for an imaginary bakery, no real company.`,
        );
        const known = new Map<string, StoredSession>();
        let parent: string | undefined;
        let child: string | undefined;
        for (const deadline = Date.now() + 8 * 60_000; Date.now() < deadline && !(parent && child); await sleep(5000)) {
          for (const s of (await core.listSessions("all")).sessions) {
            if (baseline.has(s.id) || known.has(s.id)) continue;
            const full = await core.getSession(s.id).catch(notFound);
            if (full) known.set(s.id, full.session as StoredSession);
          }
          parent ??= [...known].find(([, s]) => s.threadRef === `slack:${channel.id}:ambient:${root}`)?.[0];
          child ??= [...known].find(([, s]) => parent && s.parentSessionId === parent)?.[0];
        }
        assert.ok(parent, "this post started a new ambient worker in the private channel");
        assert.ok(child, "that worker opened a new helper");
        const [worker, helper] = [known.get(parent)!, known.get(child)!];
        assert.deepEqual(
          [worker.spawnMeta?.actor?.id, worker.spawnMeta?.unprompted, worker.spawnMeta?.origin?.kind],
          [channelActor, true, "automation"],
          "the worker ran unprompted as the channel",
        );
        assert.deepEqual(
          [helper.scopeId, helper.spawnMeta?.actor?.id, helper.spawnMeta?.unprompted],
          [`channel:${channel.id}`, channelActor, true],
          "the helper ran in the same channel as the channel, still unprompted",
        );
        const reply = await channel.waitForBotReply(root, { timeoutMs: 6 * 60_000, match: new RegExp(marker) });
        assert.ok(
          reply.user === botUserId && reply.thread_ts === root && reply.text?.includes(marker),
          "the worker replied in the note's thread",
        );
        const childItems = (await core.getSession(child)).items;
        const answer = itemText(
          [...childItems].reverse().find((i) => (i as { kind?: string }).kind === "AgentMessage"),
        ).trim();
        assert.ok(answer, "the helper produced a final answer");
        const returned = (await core.getSession(parent)).items
          .map(itemText)
          .flatMap((t) => [
            ...t.matchAll(
              /<wake reason="subagent"[^>]*sessionId="([^"]+)"[^>]*kind="final_answer"[^>]*>[\s\S]*?<content>([\s\S]*?)<\/content>/g,
            ),
          ])
          .find((m) => m[1] === child);
        assert.ok(returned, "the helper's final answer came back to the worker as a subagent wake");
        assert.equal(
          returned[2]!.trim().slice(0, 120),
          answer.slice(0, 120),
          "the returned content is the helper's answer",
        );
        const ours = (await core.listErrors()).errors.filter((e) => e.sessionId === parent || e.sessionId === child);
        assert.deepEqual(ours, [], "no refusal or error recorded for the worker or its helper");
      } catch (err) {
        failure = err;
      }
      const restoreError = await core
        .setAmbientPolicy(channel.id, restore)
        .then(() => core.ambientPolicy(channel.id))
        .then((back) =>
          assert.deepEqual(
            back && { orders: back.orders, bots: back.bots ?? {}, ambientEnabled: back.ambientEnabled },
            restore,
            "the channel's prior ambient policy was restored exactly",
          ),
        )
        .then(
          () => undefined,
          (err: Error) => err,
        );
      if (failure) {
        if (restoreError) console.error(`ambient policy restore failed for ${channel.id}: ${restoreError.message}`);
        throw failure;
      }
      if (restoreError) throw restoreError;
    },
  },
];
