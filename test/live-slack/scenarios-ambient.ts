import {
  assertAmbientRoundTrip,
  assertPolicyRestored,
  newAmbientRun,
  type StoredSession,
  type TranscriptItem,
} from "./ambient-evidence.ts";
import { assert, type Scenario } from "./harness.ts";
import { sleep } from "./slack.ts";

const notFound = (err: Error & { status?: number }) => {
  if (err.status === 404) return null;
  throw err;
};

export const ambientScenarios: Scenario[] = [
  {
    name: "ambient-helper-same-channel",
    lane: "parallel",
    tags: ["named-only"],
    timeoutMs: 10 * 60_000,
    async run(ctx) {
      const { core, qaUserId, botUserId } = ctx.env;
      const fixture = process.env.LIVE_E2E_PRIVATE_CHANNEL;
      const channel = fixture ? await ctx.fixtureChannel(fixture) : await ctx.freshChannel({ isPrivate: true });
      await core.waitForChannelMembership(channel.id, qaUserId);
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
        const evidence = {
          channelId: channel.id,
          rootTs: root,
          marker,
          botUserId,
          baseline: [...baseline],
          sessions: [] as Array<{ id: string; session: StoredSession; items: TranscriptItem[] }>,
          reply: undefined as { user?: string; thread_ts?: string; text?: string } | undefined,
          errors: [] as Array<{ sessionId?: string }>,
        };
        let found: { parent?: string; child?: string } = {};
        for (const deadline = Date.now() + 8 * 60_000; Date.now() < deadline && !found.child; await sleep(5000)) {
          for (const s of (await core.listSessions("all")).sessions) {
            if (baseline.has(s.id) || known.has(s.id)) continue;
            const full = await core.getSession(s.id).catch(notFound);
            if (full) known.set(s.id, full.session as StoredSession);
          }
          evidence.sessions = [...known].map(([id, session]) => ({ id, session, items: [] }));
          found = newAmbientRun(evidence);
        }
        evidence.reply = await channel.waitForBotReply(root, { timeoutMs: 6 * 60_000, match: new RegExp(marker) });
        evidence.sessions = await Promise.all(
          [...known].map(async ([id, session]) => ({
            id,
            session,
            items:
              id === found.parent || id === found.child ? ((await core.getSession(id)).items as TranscriptItem[]) : [],
          })),
        );
        evidence.errors = (await core.listErrors()).errors;
        assertAmbientRoundTrip(evidence);
      } catch (err) {
        failure = err;
      }
      const restoreError = await core
        .setAmbientPolicy(channel.id, restore)
        .then(() => core.ambientPolicy(channel.id))
        .then((back) => assertPolicyRestored(restore, back))
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
