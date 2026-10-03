import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

type Built = ReturnType<typeof buildApp>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function listFull(store: any, opts?: any): Promise<any[]> {
  const rows = await store.list(opts);
  return Promise.all(rows.map((r: any) => store.get(r.id)));
}

async function withApp(
  run: (built: Built) => Promise<void>,
  config: Parameters<typeof testConfig>[0] = {},
  start = true,
): Promise<void> {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-surfcache-")), ...config }));
  if (start) built.runtime.start();
  try {
    await run(built);
  } finally {
    await built.runtime.stop();
  }
}

const slackPending = async (built: Built): Promise<any[]> => (await built.deliveries.pending("slack")) as any[];

async function pollDeliveries(
  deliveries: { pending(type: string): Promise<unknown[]> },
  deadlineMs = 5_000,
): Promise<any[]> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const pending = (await deliveries.pending("slack")) as any[];
    if (pending.length) return pending;
    await sleep(50);
  }
  return [];
}

async function wakeText(built: Built, threadRef: string): Promise<string> {
  const sub = await built.sessions.getByThread(threadRef);
  assert.ok(sub, "the ambient worker session exists");
  const entries = await built.sessions.getEntries(sub!.id);
  return (entries.find((e) => e.type === "user" && typeof (e.payload as any)?.text === "string")?.payload as any)
    ?.text as string;
}

test("ingest → ambient judge engages → spawns a smart-model worker that posts to the container", () =>
  withApp(async (built) => {
    const container = "C1";
    await built.app.setChannelPolicy(container, "!engage !post ambient reply", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "100.1",
        authorId: "U1",
        text: "did the Q3 launch slip?",
        createdAt: 1,
        members: Array.from({ length: 9 }, (_, i) => `U${i + 1}`),
      },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "a room with standing orders is watched whatever its size");
    assert.match(pending[0].text, /^ambient reply/);
    assert.equal(pending[0].destination.target, container, "a plain post lands top-level in the container");
    const worker = await built.sessions.getByThread(`slack:${container}:ambient:100.1`);
    assert.ok(worker);
    const classifier = (await built.sessions.listLlmRequests(worker!.id)).find((rec) => rec.model === "mock-security");
    assert.match(JSON.stringify(classifier?.promptEnvelope), /did the Q3 launch slip/);
    assert.match(JSON.stringify(classifier?.promptEnvelope), /ambient reply/);
  }));

test("a prompt-injected ambient judge reason is screened even when the shown messages are benign", () =>
  withApp(async (built) => {
    await built.app.setChannelPolicy("C-reason-risk", "!engage !security-risk", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container: "C-reason-risk", ts: "100.2", authorId: "U1", text: "ordinary project update", createdAt: 1 },
    ]);
    await sleep(250);
    assert.equal((await slackPending(built)).length, 0);
    assert.ok((await built.auditLog.events()).some((event) => event.action === "security_posture.flagged"));
  }));

for (const gate of [
  {
    name: "ambientEnabled=false gates the judge: engage-orders channel stays silent until re-enabled",
    container: "C-off",
    off: (built: Built, c: string) =>
      built.app.setChannelPolicy(c, "!engage !post ambient reply", "U-admin", undefined, undefined, false),
    on: async (built: Built, c: string) => {
      await built.app.setChannelPolicy(c, "!engage !post ambient reply", "U-admin", undefined, undefined, true);
      const replay = await built.app.judgeAmbientContainer("slack", c);
      assert.equal(replay.act, false, "messages overheard while off are not replayed");
    },
  },
  {
    name: "org-wide ambient switch off silences every channel regardless of per-channel settings",
    container: "C-orgoff",
    off: async (built: Built, c: string) => {
      await built.app.setChannelPolicy(c, "!engage !post ambient reply", "U-admin", undefined, undefined, true);
      built.config.setOrgAmbient(false);
    },
    on: async (built: Built) => built.config.setOrgAmbient(true),
  },
]) {
  test(gate.name, () =>
    withApp(async (built) => {
      const container = gate.container;
      await gate.off(built, container);
      await built.app.ingestSurfaceEvents([
        { container, ts: "1.0", authorId: "U1", text: "did the launch slip?", createdAt: 1 },
      ]);
      const decision = await built.app.judgeAmbientContainer("slack", container);
      assert.equal(decision.act, false, "the switch wins over standing orders and a per-channel on");
      await sleep(200);
      assert.equal((await slackPending(built)).length, 0, "no proactive post");
      await gate.on(built, container);
      await built.app.ingestSurfaceEvents([
        { container, ts: "2.0", authorId: "U1", text: "any update?", createdAt: 2 },
      ]);
      const pending = await pollDeliveries(built.deliveries);
      assert.equal(pending.length, 1, "fresh messages engage again after re-enabling");
    }),
  );
}

for (const rule of [
  {
    name: "an action-mode bot entry opts the room in, with no standing orders",
    container: "C-actionbot",
    bots: { deploybot: { mode: "action" as const } },
    event: { authorId: "B1", authorName: "deploybot", bot: true, text: "deploy failed !engage !post fixing it" },
    reply: /^fixing it/,
  },
  {
    name: "ambientEnabled=true opts the room in, with no standing orders",
    container: "C-opt",
    enabled: true,
    event: { authorId: "U1", text: "hey can you help? !engage !post on it" },
    reply: /^on it/,
  },
]) {
  test(`default rule: ${rule.name}`, () =>
    withApp(async (built) => {
      const container = rule.container;
      await built.app.setChannelPolicy(container, "", "U-admin", rule.bots, undefined, rule.enabled);
      await built.app.ingestSurfaceEvents([{ container, ts: "1.0", createdAt: 1, ...rule.event }]);
      const pending = await pollDeliveries(built.deliveries);
      assert.equal(pending.length, 1, "the room engages without standing orders");
      assert.match(pending[0].text, rule.reply);
    }));
}

test("no standing orders → an informal address does NOT engage (mention-only default)", () =>
  withApp(async (built) => {
    const container = "C-addr";
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "1.0",
        authorId: "U1",
        text: "hey can you help with the launch? !engage !post on it",
        createdAt: 1,
      },
    ]);
    await sleep(250);
    assert.equal((await slackPending(built)).length, 0, "an unwatched room is mention-only");
    const rows = await built.ambientJudgments!.list({ container });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.decision, "ignore");
    assert.match(rows[0]!.reason ?? "", /defaults off/);
    const replay = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(replay.act, false);
  }));

for (const mention of [
  {
    name: "a formal @mention WITH content is left to the mention turn path (excluded from ambient)",
    container: "C-dedup",
    text: "@bot please help !engage !post hi",
  },
  {
    name: "a BARE @mention is ALSO owned by the direct dispatch path, so the ambient judge excludes it",
    container: "C-bare",
    text: "@bot",
  },
]) {
  test(mention.name, () =>
    withApp(async (built) => {
      const container = mention.container;
      await built.app.setChannelPolicy(container, "!engage !post here", "U-admin");
      await built.app.ingestSurfaceEvents(
        [{ container, ts: "1.0", authorId: "U1", text: mention.text, mentionsSelf: true, createdAt: 1 }],
        "slack",
        { name: "bot", mentionId: "UBOT" },
      );
      await sleep(300);
      assert.equal((await slackPending(built)).length, 0, "the direct path owns the mention; no ambient double-reply");
    }),
  );
}

test("a message the direct path owns (ingested handled) is excluded from the ambient judge", () =>
  withApp(async (built) => {
    const container = "C-owned";
    await built.app.setChannelPolicy(container, "!engage !post here", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "U1", text: "following up on the thread", handled: true, createdAt: 1 },
    ]);
    await sleep(300);
    assert.equal((await slackPending(built)).length, 0, "a born-handled message is owned by the direct path");
    await built.app.ingestSurfaceEvents([
      { container, ts: "2.0", authorId: "U1", text: "following up on the thread", createdAt: 2 },
    ]);
    const pending2 = await pollDeliveries(built.deliveries);
    assert.equal(pending2.length, 1, "an un-owned message still engages the judge");
  }));

test("a message that @mentions ANOTHER person (not the bot) is judged normally, never excluded", () =>
  withApp(async (built) => {
    const container = "C-other";
    await built.app.setChannelPolicy(container, "", "U-admin", undefined, undefined, true);
    await built.app.ingestSurfaceEvents(
      [{ container, ts: "1.0", authorId: "U1", text: "@jordan can you send those emails?", createdAt: 1 }],
      "slack",
      { name: "bot", mentionId: "UBOT" },
    );
    await sleep(300);
    const rows = await listFull(built.ambientJudgments!, { container });
    assert.ok(
      rows.some((r: any) => r.decision === "ignore" && r.prompt),
      "the other-person mention was judged, not excluded",
    );
    assert.ok(!rows.some((r: any) => r.decision === "fastlane"), "it is not treated as a formal self-mention");
    assert.equal((await slackPending(built)).length, 0, "and with no engaging order, nothing is posted");
  }));

test("the ambient watermark advances so a batch is judged once, not re-judged every tick", () =>
  withApp(
    async (built) => {
      const container = "C-once";
      await built.app.setChannelPolicy(container, "flag launch talk", "U-admin");
      await built.app.ingestSurfaceEvents([
        { container, ts: "1.0", authorId: "U1", text: "not a match", createdAt: 1 },
      ]);
      await built.app.judgeAmbientContainer("slack", container);
      const again = await built.app.judgeAmbientContainer("slack", container);
      assert.equal(again.act, false, "an already-judged batch is not re-judged into acting");
    },
    {},
    false,
  ));

test("mirror read interface: ingest is queryable by search + readMessages + activeThreads", () =>
  withApp(
    async (built) => {
      await built.app.ingestSurfaceEvents([
        { container: "C1", ts: "1.0", authorId: "U1", text: "the deploy is green", createdAt: 1 },
        { container: "C1", ts: "2.0", authorId: "U2", sub: "T1", text: "thread reply about the deploy", createdAt: 2 },
      ]);
      const found = await built.app.searchSurface("deploy");
      assert.equal(found.length, 2, "both messages match the search");
      const msgs = await built.app.readSurfaceMessages("C1");
      assert.equal(msgs.length, 2);
      const threads = await built.app.activeSurfaceThreads({ container: "C1" });
      assert.equal(threads.length, 1);
      assert.equal(threads[0]!.sub, "T1");
    },
    {},
    false,
  ));

for (const surfaceDebugFooter of [true, false]) {
  test(
    surfaceDebugFooter
      ? "dev debug footer: a surfaceTools reply carries an admin session deep-link (SURFACE_DEBUG_FOOTER)"
      : "no debug footer when SURFACE_DEBUG_FOOTER is off (prod default)",
    () =>
      withApp(
        async (built) => {
          const container = "C-footer";
          await built.app.setChannelPolicy(container, "", "U-admin", undefined, undefined, true);
          await built.app.ingestSurfaceEvents([
            { container, ts: "1.0", authorId: "U1", text: "hey help !engage !post ahoy", createdAt: 1 },
          ]);
          const pending = await pollDeliveries(built.deliveries);
          assert.equal(pending.length, 1);
          const footer = pending[0].destination.debugFooter as string | undefined;
          if (!surfaceDebugFooter) return assert.equal(footer, undefined, "no footer in the default (prod) config");
          assert.ok(footer, "the reply carries a debug footer when the flag is on");
          assert.match(footer, /<https:\/\/portal\.test\/admin\/history\/s\/[^|?]+\|session>/);
          assert.match(footer, /<https:\/\/portal\.test\/admin\/history\/s\/[^|?]+\?turn=\d+\|context>/);
        },
        { publicWebUrl: "https://portal.test", ...(surfaceDebugFooter ? { surfaceDebugFooter } : {}) },
      ),
  );
}

test("the worker DECIDES where to post: a thread_ts roots the reply under the message it chose", () =>
  withApp(async (built) => {
    const container = "C-choose";
    await built.app.setChannelPolicy(container, "!engage !postthread 200.1 ahoy matey", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "200.1", authorId: "U1", text: "a fresh tweet link", createdAt: 1 },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].destination.target, `${container}:200.1`, "reply threaded exactly where the agent chose");
    assert.match(pending[0].text, /^ahoy matey/);
  }));

test("the ambient wake prompt is structured XML (<wake>/<message trigger>), untrusted body escaped", () =>
  withApp(async (built) => {
    const container = "C-xml";
    await built.app.setChannelPolicy(container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "300.1", authorId: "U1", authorName: "Ann", text: "check <https://x.com/foo>", createdAt: 1 },
    ]);
    await pollDeliveries(built.deliveries);
    const wake = await wakeText(built, `slack:${container}:ambient:300.1`);
    assert.ok(wake, "the worker's wake prompt was recorded");
    assert.match(wake, /^<wake reason="ambient" surface="slack" channel="C-xml"/);
    assert.match(wake, /<message [^>]*id="300\.1"[^>]*trigger="true"[^>]*>/);
    assert.match(wake, /check &lt;https:\/\/x\.com\/foo&gt;/);
  }));

test("ambient judge: backdrop renders before NEW MESSAGES, absent on the first judgment (§2.1)", () =>
  withApp(async (built) => {
    const container = "C-bd";
    await built.app.setChannelPolicy(container, "watch this channel", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "Alice", text: "first message", createdAt: 1 },
    ]);
    await built.app.judgeAmbientContainer("slack", container);
    await built.app.ingestSurfaceEvents([
      { container, ts: "2.0", authorId: "Bob", text: "second message", createdAt: 2 },
    ]);
    await built.app.judgeAmbientContainer("slack", container);
    const rows = await listFull(built.ambientJudgments!, { container });
    const second = rows.find((r: any) => r.prompt?.includes("second message"))!;
    const first = rows.find((r: any) => r.prompt?.includes("first message") && !r.prompt?.includes("second message"))!;
    assert.ok(first && !first.prompt!.includes("EARLIER CONTEXT"), "the first judgment has no backdrop");
    assert.ok(second.prompt!.includes("EARLIER CONTEXT"), "the second judgment shows the backdrop section");
    assert.ok(
      second.prompt!.indexOf("EARLIER CONTEXT") < second.prompt!.indexOf("NEW MESSAGES"),
      "backdrop is rendered before NEW MESSAGES",
    );
    assert.ok(second.prompt!.includes("Alice: first message"), "the earlier message is the backdrop");
  }));

test("ambient judge: backdrop is capped at the last 10 (§2.1)", () =>
  withApp(async (built) => {
    const container = "C-bdcap";
    await built.app.setChannelPolicy(container, "watch", "U-admin");
    await built.app.ingestSurfaceEvents(
      Array.from({ length: 12 }, (_v, i) => ({
        container,
        ts: `${1000 + i}.0`,
        authorId: `U${i + 1}`,
        text: `m${i + 1}`,
        createdAt: i + 1,
      })),
    );
    await sleep(300);
    await built.app.ingestSurfaceEvents([{ container, ts: "1013.0", authorId: "U13", text: "m13", createdAt: 13 }]);
    await sleep(300);
    const rows = await listFull(built.ambientJudgments!, { container });
    const last = rows.find((r: any) => r.prompt?.includes("m13") && r.prompt?.includes("EARLIER CONTEXT"))!;
    const backdrop = last.prompt!.slice(last.prompt!.indexOf("EARLIER CONTEXT"), last.prompt!.indexOf("NEW MESSAGES"));
    const backdropCount = (backdrop.match(/^U\d+: m\d+$/gm) ?? []).length;
    assert.equal(backdropCount, 10, "backdrop capped at the last 10");
    assert.ok(!/: m1$/m.test(backdrop) && !/: m2$/m.test(backdrop), "the oldest messages fell off the cap");
  }));

async function judgeOnce(built: Built, container: string): Promise<any[]> {
  await built.app.setChannelPolicy(container, "!engage !post ahoy", "U-admin");
  await built.app.ingestSurfaceEvents([{ container, ts: "5.0", authorId: "U1", text: "need help", createdAt: 5 }]);
  await pollDeliveries(built.deliveries);
  const rows = await listFull(built.ambientJudgments!, { container });
  assert.equal(rows.length, 1, "one row for the judged batch");
  return rows;
}

test("a judged batch records a durable judgment row: prompt, decision, model, ts range (§2.2)", () =>
  withApp(async (built) => {
    const [row] = await judgeOnce(built, "C-row");
    assert.equal(row.decision, "act");
    assert.ok(row.prompt && row.prompt.includes("NEW MESSAGES"));
    assert.equal(row.model, "claude-haiku-4-5", "the resolved judge model is recorded (default Haiku)");
    assert.equal(row.tsFrom, "5.0");
    assert.equal(row.tsTo, "5.0");
    assert.ok(typeof row.latencyMs === "number");
  }));

for (const judge of [
  {
    name: "the ambient judge model is independent of the detect model (PI_JUDGE_MODEL)",
    config: { detectModelId: "claude-opus-4-8", judgeModelId: "claude-sonnet-5" },
    model: "claude-sonnet-5",
  },
  {
    name: "an OpenAI-only deployment judges with an OpenAI auxiliary model, not Haiku",
    config: { modelId: "gpt-5.6-sol", openaiApiKey: "sk-openai-test" },
    model: "gpt-5.6-luna",
  },
  {
    name: "an admin-set org base model drives the auxiliary, not just the PI_MODEL env",
    config: { openaiApiKey: "sk-openai-test" },
    baseModel: "gpt-5.6-sol",
    model: "gpt-5.6-luna",
  },
]) {
  test(judge.name, () =>
    withApp(async (built) => {
      if (judge.baseModel) built.config.setBaseModel("org:default-org", judge.baseModel);
      const [row] = await judgeOnce(built, "C-judgemodel");
      assert.equal(row.model, judge.model, "the configured judge model is recorded");
    }, judge.config),
  );
}

test("a formal-mention fastlane records a fastlane row (§2.2)", () =>
  withApp(async (built) => {
    const container = "C-fast";
    await built.app.setChannelPolicy(container, "", "U-admin", undefined, undefined, true);
    await built.app.ingestSurfaceEvents(
      [{ container, ts: "6.0", authorId: "U1", text: "@bot please help", mentionsSelf: true, createdAt: 6 }],
      "slack",
      { name: "bot", mentionId: "UBOT" },
    );
    await sleep(300);
    const rows = await listFull(built.ambientJudgments!, { container });
    assert.ok(
      rows.some((r: any) => r.decision === "fastlane"),
      "the mention-routed batch recorded a fastlane row",
    );
    assert.ok(!rows.some((r: any) => r.decision === "fastlane" && r.prompt), "a fastlane row carries no prompt");
  }));

test("worker seed is the trigger plus the 3 messages before it (§2.4)", () =>
  withApp(async (built) => {
    const container = "C-seed";
    await built.app.setChannelPolicy(container, "watch", "U-admin");
    await built.app.ingestSurfaceEvents([
      ...Array.from({ length: 5 }, (_v, i) => ({
        container,
        ts: `40${i + 1}.0`,
        authorId: `U${i + 1}`,
        text: `msg ${i + 1}`,
        createdAt: i + 1,
      })),
      { container, ts: "406.0", authorId: "U6", text: "trigger !engage !post reply", createdAt: 6 },
    ]);
    await pollDeliveries(built.deliveries);
    const wake = await wakeText(built, `slack:${container}:ambient:406.0`);
    assert.ok(wake.includes(`id="406.0"`) && wake.includes(`id="403.0"`), "the trigger and the 3 before it are seeded");
    assert.ok(!wake.includes(`id="402.0"`), "the 4th-back message is not seeded (seed is trigger + 3)");
    assert.ok(
      wake.includes("read_thread") && wake.includes("search"),
      "the instructions point at read_thread/search for more context",
    );
  }));

test("bot ledger — ignore: an ignored-bot-only delta never wakes the judge and records no row (§3.3)", () =>
  withApp(async (built) => {
    const container = "C-botignore";
    await built.app.setChannelPolicy(container, "watch", "U-admin", { newsbot: { mode: "ignore" } });
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorName: "NewsBot", text: "big news !engage !post go", bot: true, createdAt: 1 },
    ]);
    await sleep(300);
    assert.equal((await slackPending(built)).length, 0, "an ignored bot never triggers a post");
    assert.equal(
      (await built.ambientJudgments!.list({ container })).length,
      0,
      "an ignored-bot-only delta records no judgment row",
    );
  }));

test("bot ledger — action tags the bot as a trigger; user sheds the (bot) tag; unlisted bots keep it (§3.3)", () =>
  withApp(async (built) => {
    await built.app.setChannelPolicy("C-botact", "watch", "U-admin", { deploybot: { mode: "action" } });
    await built.app.ingestSurfaceEvents([
      { container: "C-botact", ts: "1.0", authorName: "DeployBot", text: "deploy finished", bot: true, createdAt: 1 },
    ]);
    await built.app.setChannelPolicy("C-botuser", "watch", "U-admin", { helperbot: { mode: "user" } });
    await built.app.ingestSurfaceEvents([
      { container: "C-botuser", ts: "1.0", authorName: "HelperBot", text: "hello team", bot: true, createdAt: 1 },
    ]);
    await built.app.setChannelPolicy("C-botunlisted", "watch", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container: "C-botunlisted", ts: "1.0", authorName: "RandomBot", text: "beep boop", bot: true, createdAt: 1 },
    ]);
    await sleep(400);
    const act = (await listFull(built.ambientJudgments!, { container: "C-botact" }))[0]!;
    assert.ok(
      act.prompt!.includes('Posts from bot "DeployBot" are triggers you should act on.'),
      "action bot is tagged as a trigger",
    );
    assert.ok(
      act.prompt!.includes("DeployBot (bot): deploy finished"),
      "action bot still renders with the (bot) suffix",
    );
    const user = (await listFull(built.ambientJudgments!, { container: "C-botuser" }))[0]!;
    assert.ok(user.prompt!.includes("HelperBot: hello team"), "a user-mode bot renders like a person");
    assert.ok(!user.prompt!.includes("HelperBot (bot)"), "a user-mode bot sheds the (bot) suffix");
    const unlisted = (await listFull(built.ambientJudgments!, { container: "C-botunlisted" }))[0]!;
    assert.ok(unlisted.prompt!.includes("RandomBot (bot): beep boop"), "an unlisted bot keeps the (bot) suffix");
  }));

test("bot ledger — rollup holds a rollup-only delta within the window (cursor unadvanced), a human lifts it (§3.3)", () =>
  withApp(async (built) => {
    const container = "C-botrollup";
    await built.app.setChannelPolicy(container, "watch", "U-admin", { newsbot: { mode: "rollup", rollupHours: 6 } });
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorName: "NewsBot", text: "item 1", bot: true, createdAt: 1 },
    ]);
    await sleep(300);
    assert.equal((await built.ambientJudgments!.list({ container })).length, 1, "the first rollup post is judged");
    await built.app.ingestSurfaceEvents([
      { container, ts: "2.0", authorName: "NewsBot", text: "item 2", bot: true, createdAt: 2 },
    ]);
    await sleep(300);
    assert.equal(
      (await built.ambientJudgments!.list({ container })).length,
      1,
      "a rollup-only delta within the window is held (no new row)",
    );
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "3.0",
        authorId: "U1",
        authorName: "Alice",
        text: "any updates? !engage !post here",
        createdAt: 3,
      },
    ]);
    const posted = await pollDeliveries(built.deliveries);
    assert.ok(posted.length >= 1, "a human message lifts the rollup hold and the batch engages");
    const engaged = (await listFull(built.ambientJudgments!, { container })).find((r: any) => r.decision === "act")!;
    assert.ok(engaged.prompt!.includes("item 2"), "the previously-held bot post is re-judged with the human message");
  }));

test("scheduled check-in: empty delta is still judged and renders the scheduled line; cursor untouched (§6.2)", () =>
  withApp(async (built) => {
    const container = "C-sched";
    await built.app.setChannelPolicy(container, "follow up on unanswered questions", "U-admin");
    const decision = await built.app.judgeAmbientContainer("slack", container, { reason: "scheduled" });
    assert.equal(decision.act, false, "no !engage marker, so the mock judge stays silent");
    const rows = await listFull(built.ambientJudgments!, { container });
    assert.equal(rows.length, 1, "the scheduled check-in judged despite an empty delta");
    assert.ok(rows[0]!.prompt!.includes("scheduled check-in"), "the scheduled line renders in the prompt");
    await built.app.ingestSurfaceEvents([
      { container, ts: "700.0", authorId: "U1", text: "later !engage !post hi", createdAt: 700 },
    ]);
    const posted = await pollDeliveries(built.deliveries);
    assert.ok(
      posted.length >= 1,
      "a message after the scheduled check-in is still judged fresh (cursor wasn't advanced)",
    );
  }));

const alice = { principalId: "alice@acme.com", displayName: "Alice", type: "internal" as const, slackId: "U1" };
const mallory = { principalId: "mallory@acme.com", displayName: "Mallory", type: "internal" as const };

for (const ask of [
  {
    name: "a solicited ambient wake runs as the asking person, not the system actor",
    container: "C-solicited",
    setup: async (built: Built, c: string) => {
      await built.directory.replace([alice]);
      await built.directory.replaceChannels(
        [{ channelId: c, name: "solicited-chan", isPrivate: false }],
        [{ channelId: c, principalId: alice.principalId }],
      );
    },
    orders: "!engage-asked",
    events: [{ ts: "300.1", authorId: "U1", authorName: "Alice", text: "!post solicited reply" }],
    ts: "300.1",
    reply: /^solicited reply/,
    participants: ["alice@acme.com"],
    askedBy: "300.1",
  },
  {
    name: "a solicited wake in a private channel requires the asker in the pre-pushed membership",
    container: "C-private",
    setup: async (built: Built, c: string) => {
      await built.directory.replace([alice]);
      await built.directory.replaceChannels(
        [{ channelId: c, name: "private-chan", isPrivate: true }],
        [{ channelId: c, principalId: alice.principalId }],
      );
    },
    orders: "!engage-asked",
    events: [{ ts: "600.1", authorId: "U1", authorName: "Alice", text: "!post private reply" }],
    ts: "600.1",
    reply: /^private reply/,
    participants: ["alice@acme.com"],
  },
  {
    name: "an ambient worker in a group DM runs at the group scope, not a fabricated channel scope",
    container: "C-mpim",
    orders: "!engage !post group reply",
    events: [
      { ts: "400.1", authorId: "U1", authorName: "Alice", text: "who owns the deploy?", kind: "group" as const },
    ],
    ts: "400.1",
    group: true,
  },
  {
    name: "a solicited ask in a group DM runs as the asking person via group-membership attestation",
    container: "C-mpim-solicited",
    setup: async (built: Built, c: string) => {
      await built.directory.replace([alice]);
      await built.directory.replaceGroups([{ groupId: c, principalId: alice.principalId }]);
    },
    orders: "!engage-asked",
    events: [
      { ts: "500.1", authorId: "U1", authorName: "Alice", text: "!post group solicited reply", kind: "group" as const },
    ],
    ts: "500.1",
    reply: /^group solicited reply/,
    group: true,
    participants: ["alice@acme.com"],
  },
  {
    name: "a solicited ask in a group DM whose author is NOT a pushed member degrades to proactive",
    container: "C-mpim-nonmember",
    setup: (built: Built) => built.directory.replace([{ ...mallory, slackId: "U9" }]),
    orders: "!engage-asked !post proactive fallback",
    events: [
      { ts: "600.1", authorId: "U9", authorName: "Mallory", text: "can you check this?", kind: "group" as const },
    ],
    ts: "600.1",
    group: true,
    participants: [],
  },
  {
    name: "a solicited verdict for a message that isn't the newest speaker's degrades to proactive",
    container: "C-disarmed",
    setup: async (built: Built, c: string) => {
      await built.directory.replace([alice, { ...mallory, slackId: "U2" }]);
      await built.directory.replaceChannels([{ channelId: c, name: "disarmed-chan", isPrivate: false }]);
    },
    orders: "!engage-asked !post disarmed reply",
    events: [
      { ts: "500.1", authorId: "U1", authorName: "Alice", text: "qm can you check the deploy?" },
      { ts: "500.2", authorId: "U2", authorName: "Mallory", text: "unrelated chatter" },
    ],
    ts: "500.2",
    reply: /^disarmed reply/,
    participants: [],
  },
  {
    name: "a solicited wake whose author isn't in the directory degrades to the proactive system actor",
    container: "C-unknown-asker",
    orders: "!engage-asked !post fallback reply",
    events: [{ ts: "400.1", authorId: "U-stranger", authorName: "Stranger", text: "qm can you check something?" }],
    ts: "400.1",
    reply: /^fallback reply/,
    participants: [],
  },
]) {
  test(ask.name, () =>
    withApp(async (built) => {
      const container = ask.container;
      await ask.setup?.(built, container);
      await built.app.setChannelPolicy(container, ask.orders, "U-admin");
      await built.app.ingestSurfaceEvents(ask.events.map((e, i) => ({ container, createdAt: i + 1, ...e })));
      const pending = await pollDeliveries(built.deliveries);
      assert.equal(pending.length, 1, "the worker posted exactly once");
      if (ask.reply) assert.match(pending[0].text, ask.reply);
      const session = await built.sessions.getByThread(`slack:${container}:ambient:${ask.ts}`);
      assert.ok(session, "the worker session exists, keyed on the batch's latest ts");
      if (ask.group) {
        assert.equal(session!.type, "group", "the session is group-typed");
        assert.equal(session!.scopeId, `group:${container}`, "the worker acts at the group's own scope");
      }
      if (ask.participants) {
        const participants = await built.sessions.participantsOf(session!.id);
        assert.deepEqual(participants, ask.participants, "authority is the attested asker's or nobody's");
      }
      if (ask.askedBy) {
        const rows = await built.ambientJudgments!.list({ container });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.askedBy, ask.askedBy, "asked_by is a first-class judgment field");
        assert.ok(!(rows[0]!.reason ?? "").includes("[asked_by"), "the reason carries no asked_by splice");
      }
    }),
  );
}

test("a solicited ambient wake carries the complete channel roster", () =>
  withApp(async (built) => {
    const container = "C-solicited-roster";
    await built.directory.replace([
      alice,
      { ...mallory, principalId: "bob@acme.com", displayName: "Bob", slackId: "U2" },
    ]);
    await built.directory.replaceChannels(
      [{ channelId: container, name: "solicited-roster", isPrivate: false }],
      [
        { channelId: container, principalId: "alice@acme.com" },
        { channelId: container, principalId: "bob@acme.com" },
      ],
    );
    await built.app.setChannelPolicy(container, "!engage-asked", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "350.1", authorId: "U1", authorName: "Alice", text: "!sysprompt", createdAt: 1 },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1);
    assert.match(pending[0].text, /Alice \(alice@acme\.com\)/);
    assert.match(pending[0].text, /Bob \(bob@acme\.com\)/);
  }));

test("a second ambient wake while the first worker is LIVE steers into it instead of forking a sibling reply", () =>
  withApp(
    async (built) => {
      const container = "C-coalesce";
      await built.app.setChannelPolicy(container, "!engage !post tag the team", "U-admin");
      await built.app.ingestSurfaceEvents([
        { container, ts: "100.1", authorId: "U1", text: "events site is down", createdAt: 1 },
      ]);
      await built.app.judgeAmbientContainer("slack", container);
      const live = await built.runs.activeForThread(`slack:${container}:ambient:100.1`);
      assert.ok(live, "first wake spawned a live worker run");
      await built.app.ingestSurfaceEvents([
        { container, ts: "100.2", authorId: "U2", text: "same here, meetup page too", createdAt: 2 },
      ]);
      let signals: any[] = [];
      for (const deadline = Date.now() + 5_000; !signals.length && Date.now() < deadline;) {
        signals = await built.signals.takePending(live!.id);
        if (!signals.length) await sleep(50);
      }
      assert.equal(signals.length, 1, "the second wake steered the live run");
      assert.equal(signals[0]!.kind, "steer");
      assert.match(signals[0]!.text!, /meetup page too/);
      assert.ok(signals[0]!.request, "the steer carries its request for terminal-drain replay");
      const runs = await built.runs.list();
      assert.equal(
        runs.filter((r) => r.sessionId.startsWith(`slack:${container}:ambient:`)).length,
        1,
        "no sibling worker run was enqueued",
      );
    },
    {},
    false,
  ));
