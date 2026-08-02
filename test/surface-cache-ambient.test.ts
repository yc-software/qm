import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function listFull(store: any, opts?: any): Promise<any[]> {
  const rows = await store.list(opts);
  return Promise.all(rows.map((r: any) => store.get(r.id)));
}

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-surfcache-"));
  return buildApp(testConfig({ dataDir }));
}

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

test("ingest → ambient judge engages → spawns a smart-model worker that posts to the container", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C1";
    await built.app.setChannelPolicy(container, "!engage !post ambient reply", "U-admin");

    await built.app.ingestSurfaceEvents([
      { container, ts: "100.1", authorId: "U1", text: "did the Q3 launch slip?", createdAt: 1 },
    ]);

    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "the spawned worker posted exactly once");
    assert.match(pending[0].text, /^ambient reply/);
    assert.equal(pending[0].destination.target, container, "a plain post lands top-level in the container");
    const worker = await built.sessions.getByThread(`slack:${container}:ambient:100.1`);
    assert.ok(worker);
    const classifier = (await built.sessions.listLlmRequests(worker!.id)).find((rec) => rec.model === "mock-security");
    assert.match(JSON.stringify(classifier?.promptEnvelope), /did the Q3 launch slip/);
    assert.match(JSON.stringify(classifier?.promptEnvelope), /ambient reply/);
  } finally {
    await built.runtime.stop();
  }
});

test("a prompt-injected ambient judge reason is screened even when the shown messages are benign", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.setChannelPolicy("C-reason-risk", "!engage !security-risk", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container: "C-reason-risk",
        ts: "100.2",
        authorId: "U1",
        text: "ordinary project update",
        createdAt: 1,
      },
    ]);
    await sleep(250);
    assert.equal((await built.deliveries.pending("slack")).length, 0);
    assert.ok((await built.auditLog.events()).some((event) => event.action === "security_posture.quarantine"));
  } finally {
    await built.runtime.stop();
  }
});

test("unaddressed chatter with no standing orders stays silent (silence is the default)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.ingestSurfaceEvents([
      { container: "C-quiet", ts: "1.0", authorId: "U1", text: "lunch anyone?", createdAt: 1 },
    ]);
    const decision = await built.app.judgeAmbientContainer("slack", "C-quiet");
    assert.equal(decision.act, false);
    await sleep(200);
    const pending = (await built.deliveries.pending("slack")) as any[];
    assert.equal(pending.length, 0, "idle chatter produces no proactive post");
  } finally {
    await built.runtime.stop();
  }
});

test("ambientEnabled=false gates the judge: engage-orders channel stays silent until re-enabled", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-off";
    await built.app.setChannelPolicy(container, "!engage !post ambient reply", "U-admin", undefined, undefined, false);
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "U1", text: "did the launch slip?", createdAt: 1 },
    ]);
    const decision = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(decision.act, false, "the judge never runs in a switched-off channel");
    await sleep(200);
    assert.equal(((await built.deliveries.pending("slack")) as any[]).length, 0, "no proactive post");
    await built.app.setChannelPolicy(container, "!engage !post ambient reply", "U-admin", undefined, undefined, true);
    const replay = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(replay.act, false, "messages overheard while off are not replayed");
    await built.app.ingestSurfaceEvents([{ container, ts: "2.0", authorId: "U1", text: "any update?", createdAt: 2 }]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "fresh messages engage again after re-enabling");
  } finally {
    await built.runtime.stop();
  }
});

test("default rule: standing orders opt the room into ambient, regardless of size", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-big";
    await built.app.setChannelPolicy(container, "!engage !post ambient reply", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "1.0",
        authorId: "U1",
        text: "did the launch slip?",
        createdAt: 1,
        members: Array.from({ length: 9 }, (_, i) => `U${i + 1}`),
      },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "a room with standing orders is watched whatever its size");
    assert.match(pending[0].text, /^ambient reply/);
  } finally {
    await built.runtime.stop();
  }
});

test("default rule: an action-mode bot entry opts the room in, with no standing orders", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-actionbot";
    await built.app.setChannelPolicy(container, "", "U-admin", { deploybot: { mode: "action" } });
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "1.0",
        authorId: "B1",
        authorName: "deploybot",
        bot: true,
        text: "deploy failed !engage !post fixing it",
        createdAt: 1,
      },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "an action-bot trigger engages without standing orders");
    assert.match(pending[0].text, /^fixing it/);
  } finally {
    await built.runtime.stop();
  }
});

test("default rule: ambientEnabled=true opts the room in, with no standing orders", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-opt";
    await built.app.setChannelPolicy(container, "", "U-admin", undefined, undefined, true);
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "U1", text: "hey can you help? !engage !post on it", createdAt: 1 },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "an explicit on override needs no orders");
    assert.match(pending[0].text, /^on it/);
  } finally {
    await built.runtime.stop();
  }
});

test("org-wide ambient switch off silences every channel regardless of per-channel settings", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-orgoff";
    await built.app.setChannelPolicy(container, "!engage !post ambient reply", "U-admin", undefined, undefined, true);
    built.config.setOrgAmbient(false);
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "U1", text: "did the launch slip?", createdAt: 1 },
    ]);
    const decision = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(decision.act, false, "the org switch wins over an explicit per-channel on");
    await sleep(200);
    assert.equal(((await built.deliveries.pending("slack")) as any[]).length, 0);
    built.config.setOrgAmbient(true);
    await built.app.ingestSurfaceEvents([{ container, ts: "2.0", authorId: "U1", text: "any update?", createdAt: 2 }]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "flipping the org switch back on restores ambient");
  } finally {
    await built.runtime.stop();
  }
});

test("no standing orders → an informal address does NOT engage (mention-only default)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
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
    assert.equal(((await built.deliveries.pending("slack")) as any[]).length, 0, "an unwatched room is mention-only");
    const rows = await built.ambientJudgments!.list({ container });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.decision, "ignore");
    assert.match(rows[0]!.reason ?? "", /defaults off/);
    const replay = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(replay.act, false);
  } finally {
    await built.runtime.stop();
  }
});

test("a formal @mention WITH content is left to the mention turn path (excluded from ambient)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-dedup";
    await built.app.ingestSurfaceEvents(
      [
        {
          container,
          ts: "1.0",
          authorId: "U1",
          text: "@bot please help !engage !post hi",
          mentionsSelf: true,
          createdAt: 1,
        },
      ],
      "slack",
      { name: "bot", mentionId: "UBOT" },
    );
    await sleep(300);
    const pending = (await built.deliveries.pending("slack")) as any[];
    assert.equal(pending.length, 0, "no second, top-level ambient reply for a formal mention+content");
  } finally {
    await built.runtime.stop();
  }
});

test("a BARE @mention is ALSO owned by the direct dispatch path, so the ambient judge excludes it", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-bare";
    await built.app.setChannelPolicy(container, "!engage !post here", "U-admin");
    await built.app.ingestSurfaceEvents(
      [{ container, ts: "1.0", authorId: "U1", text: "@bot", mentionsSelf: true, createdAt: 1 }],
      "slack",
      { name: "bot", mentionId: "UBOT" },
    );
    await sleep(300);
    const pending = (await built.deliveries.pending("slack")) as any[];
    assert.equal(pending.length, 0, "the direct path owns the mention; the ambient judge does not double-reply");
  } finally {
    await built.runtime.stop();
  }
});

test("a message the direct path owns (ingested handled) is excluded from the ambient judge", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-owned";
    await built.app.setChannelPolicy(container, "!engage !post here", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "U1", text: "following up on the thread", handled: true, createdAt: 1 },
    ]);
    await sleep(300);
    const pending = (await built.deliveries.pending("slack")) as any[];
    assert.equal(pending.length, 0, "a born-handled message is owned by the direct path, never the judge");

    await built.app.ingestSurfaceEvents([
      { container, ts: "2.0", authorId: "U1", text: "following up on the thread", createdAt: 2 },
    ]);
    const pending2 = await pollDeliveries(built.deliveries);
    assert.equal(pending2.length, 1, "an un-owned message still engages the judge");
  } finally {
    await built.runtime.stop();
  }
});

test("a message that @mentions ANOTHER person (not the bot) is judged normally, never excluded", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
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
    const pending = (await built.deliveries.pending("slack")) as any[];
    assert.equal(pending.length, 0, "and with no engaging order, nothing is posted");
  } finally {
    await built.runtime.stop();
  }
});

test("the ambient watermark advances so a batch is judged once, not re-judged every tick", async () => {
  const built = freshApp();
  try {
    const container = "C-once";
    await built.app.setChannelPolicy(container, "flag launch talk", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "1.0", authorId: "U1", text: "not a match", createdAt: 1 }]);
    await built.app.judgeAmbientContainer("slack", container);
    const again = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(again.act, false, "an already-judged batch is not re-judged into acting");
  } finally {
    await built.runtime.stop();
  }
});

test("mirror read interface: ingest is queryable by search + readMessages + activeThreads", async () => {
  const built = freshApp();
  try {
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
  } finally {
    await built.runtime.stop();
  }
});

test("dev debug footer: a surfaceTools reply carries an admin session deep-link (SURFACE_DEBUG_FOOTER)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-footer-"));
  const built = buildApp(testConfig({ dataDir, surfaceDebugFooter: true, publicWebUrl: "https://portal.test" }));
  built.runtime.start();
  try {
    const container = "C-footer";
    await built.app.setChannelPolicy(container, "", "U-admin", undefined, undefined, true);
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "U1", text: "hey help !engage !post ahoy", createdAt: 1 },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1);
    const footer = pending[0].destination.debugFooter as string;
    assert.ok(footer, "the reply carries a debug footer when the flag is on");
    assert.match(footer, /<https:\/\/portal\.test\/admin\/history\?scope=org%3Adefault-org&session=[^|]+\|session>/);
    assert.match(
      footer,
      /<https:\/\/portal\.test\/admin\/history\?scope=org%3Adefault-org&session=[^|]+&turn=\d+\|context>/,
    );
  } finally {
    await built.runtime.stop();
  }
});

test("no debug footer when SURFACE_DEBUG_FOOTER is off (prod default)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-nofooter-"));
  const built = buildApp(testConfig({ dataDir, publicWebUrl: "https://portal.test" }));
  built.runtime.start();
  try {
    await built.app.setChannelPolicy("C-nf", "", "U-admin", undefined, undefined, true);
    await built.app.ingestSurfaceEvents([
      { container: "C-nf", ts: "1.0", authorId: "U1", text: "hey help !engage !post ahoy", createdAt: 1 },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].destination.debugFooter, undefined, "no footer in the default (prod) config");
  } finally {
    await built.runtime.stop();
  }
});

test("the worker DECIDES where to post: a thread_ts roots the reply under the message it chose", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-choose";
    await built.app.setChannelPolicy(container, "!engage !postthread 200.1 ahoy matey", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "200.1", authorId: "U1", text: "a fresh tweet link", createdAt: 1 },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].destination.target, `${container}:200.1`, "reply threaded exactly where the agent chose");
    assert.match(pending[0].text, /^ahoy matey/);
  } finally {
    await built.runtime.stop();
  }
});

test("the ambient wake prompt is structured XML (<wake>/<message trigger>), untrusted body escaped", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-xml";
    await built.app.setChannelPolicy(container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "300.1", authorId: "U1", authorName: "Ann", text: "check <https://x.com/foo>", createdAt: 1 },
    ]);
    await pollDeliveries(built.deliveries);
    const sub = await built.sessions.getByThread(`slack:${container}:ambient:300.1`);
    assert.ok(sub, "the ambient worker session exists");
    const entries = await built.sessions.getEntries(sub!.id);
    const wake = (
      entries.find((e) => e.type === "user" && typeof (e.payload as any)?.text === "string")?.payload as any
    )?.text as string;
    assert.ok(wake, "the worker's wake prompt was recorded");
    assert.match(wake, /^<wake reason="ambient" surface="slack" channel="C-xml"/);
    assert.match(wake, /<message [^>]*id="300\.1"[^>]*trigger="true"[^>]*>/);
    assert.match(wake, /check &lt;https:\/\/x\.com\/foo&gt;/);
  } finally {
    await built.runtime.stop();
  }
});

test("ambient judge: backdrop renders before NEW MESSAGES, absent on the first judgment (§2.1)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
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
  } finally {
    await built.runtime.stop();
  }
});

test("ambient judge: backdrop is capped at the last 10 (§2.1)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
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
  } finally {
    await built.runtime.stop();
  }
});

test("a judged batch records a durable judgment row: prompt, decision, model, ts range (§2.2)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-row";
    await built.app.setChannelPolicy(container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "5.0", authorId: "U1", text: "need help", createdAt: 5 }]);
    await pollDeliveries(built.deliveries);
    const rows = await listFull(built.ambientJudgments!, { container });
    assert.equal(rows.length, 1, "one row for the judged batch");
    assert.equal(rows[0]!.decision, "act");
    assert.ok(rows[0]!.prompt && rows[0]!.prompt.includes("NEW MESSAGES"));
    assert.equal(rows[0]!.model, "claude-haiku-4-5", "the resolved judge model is recorded (default Haiku)");
    assert.equal(rows[0]!.tsFrom, "5.0");
    assert.equal(rows[0]!.tsTo, "5.0");
    assert.ok(typeof rows[0]!.latencyMs === "number");
  } finally {
    await built.runtime.stop();
  }
});

test("the ambient judge model is independent of the detect model (PI_JUDGE_MODEL)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-surfcache-"));
  const built = buildApp(testConfig({ dataDir, detectModelId: "claude-opus-4-8", judgeModelId: "claude-sonnet-5" }));
  built.runtime.start();
  try {
    const container = "C-judgemodel";
    await built.app.setChannelPolicy(container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "5.0", authorId: "U1", text: "need help", createdAt: 5 }]);
    await pollDeliveries(built.deliveries);
    const rows = await listFull(built.ambientJudgments!, { container });
    assert.equal(rows.length, 1, "one row for the judged batch");
    assert.equal(rows[0]!.model, "claude-sonnet-5", "the judge model is recorded, not the detect model");
  } finally {
    await built.runtime.stop();
  }
});

test("an OpenAI-only deployment judges with an OpenAI auxiliary model, not Haiku", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-surfcache-"));
  const built = buildApp(testConfig({ dataDir, modelId: "gpt-5.6-sol", openaiApiKey: "sk-openai-test" }));
  built.runtime.start();
  try {
    const container = "C-openai-judge";
    await built.app.setChannelPolicy(container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "5.0", authorId: "U1", text: "need help", createdAt: 5 }]);
    await pollDeliveries(built.deliveries);
    const rows = await listFull(built.ambientJudgments!, { container });
    assert.equal(rows.length, 1, "one row for the judged batch");
    assert.equal(rows[0]!.model, "gpt-5.6-luna", "the auxiliary follows the configured base model's provider");
  } finally {
    await built.runtime.stop();
  }
});

test("an admin-set org base model drives the auxiliary, not just the PI_MODEL env", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-surfcache-"));
  const built = buildApp(testConfig({ dataDir, openaiApiKey: "sk-openai-test" }));
  built.config.setBaseModel("org:default-org", "gpt-5.6-sol");
  built.runtime.start();
  try {
    const container = "C-admin-base";
    await built.app.setChannelPolicy(container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "5.0", authorId: "U1", text: "need help", createdAt: 5 }]);
    await pollDeliveries(built.deliveries);
    const rows = await listFull(built.ambientJudgments!, { container });
    assert.equal(rows.length, 1, "one row for the judged batch");
    assert.equal(
      rows[0]!.model,
      "gpt-5.6-luna",
      "onboarding through the admin UI, not PI_MODEL, still moves the auxiliary",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a formal-mention fastlane records a fastlane row (§2.2)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
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
  } finally {
    await built.runtime.stop();
  }
});

test("worker seed is the trigger plus the 3 messages before it (§2.4)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
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
    const sub = await built.sessions.getByThread(`slack:${container}:ambient:406.0`);
    assert.ok(sub, "the ambient worker session exists");
    const entries = await built.sessions.getEntries(sub!.id);
    const wake = (
      entries.find((e) => e.type === "user" && typeof (e.payload as any)?.text === "string")?.payload as any
    )?.text as string;
    assert.ok(wake.includes(`id="406.0"`) && wake.includes(`id="403.0"`), "the trigger and the 3 before it are seeded");
    assert.ok(!wake.includes(`id="402.0"`), "the 4th-back message is not seeded (seed is trigger + 3)");
    assert.ok(
      wake.includes("read_thread") && wake.includes("search"),
      "the instructions point at read_thread/search for more context",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("bot ledger — ignore: an ignored-bot-only delta never wakes the judge and records no row (§3.3)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-botignore";
    await built.app.setChannelPolicy(container, "watch", "U-admin", { newsbot: { mode: "ignore" } });
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorName: "NewsBot", text: "big news !engage !post go", bot: true, createdAt: 1 },
    ]);
    await sleep(300);
    assert.equal(
      ((await built.deliveries.pending("slack")) as any[]).length,
      0,
      "an ignored bot never triggers a post",
    );
    assert.equal(
      (await built.ambientJudgments!.list({ container })).length,
      0,
      "an ignored-bot-only delta records no judgment row",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("bot ledger — action tags the bot as a trigger; user sheds the (bot) tag; unlisted bots keep it (§3.3)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
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
  } finally {
    await built.runtime.stop();
  }
});

test("bot ledger — rollup holds a rollup-only delta within the window (cursor unadvanced), a human lifts it (§3.3)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
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
  } finally {
    await built.runtime.stop();
  }
});

test("scheduled check-in: empty delta is still judged and renders the scheduled line; cursor untouched (§6.2)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
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
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited ambient wake runs as the asking person, not the system actor", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-solicited";
    await built.directory.replace([
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U1" },
    ]);
    await built.directory.replaceChannels([{ channelId: container, name: "solicited-chan", isPrivate: false }]);
    await built.app.setChannelPolicy(container, "!engage-asked", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "300.1", authorId: "U1", authorName: "Alice", text: "!post solicited reply", createdAt: 1 },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "the solicited worker posted exactly once");
    assert.match(pending[0].text, /^solicited reply/);
    const session = await built.sessions.getByThread(`slack:${container}:ambient:300.1`);
    assert.ok(session, "the worker session exists");
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, ["alice@acme.com"], "the turn ran as the asking person");
    const rows = await built.ambientJudgments!.list({ container });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.askedBy, "300.1", "asked_by is a first-class judgment field");
    assert.ok(!(rows[0]!.reason ?? "").includes("[asked_by"), "the reason carries no asked_by splice");
  } finally {
    await built.runtime.stop();
  }
});

test("an ambient worker in a group DM runs at the group scope, not a fabricated channel scope", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-mpim";
    await built.app.setChannelPolicy(container, "!engage !post group reply", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "400.1",
        authorId: "U1",
        authorName: "Alice",
        text: "who owns the deploy?",
        kind: "group",
        createdAt: 1,
      },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "the spawned worker posted");
    const session = await built.sessions.getByThread(`slack:${container}:ambient:400.1`);
    assert.ok(session, "the worker session exists");
    assert.equal(session!.type, "group", "the session is group-typed");
    assert.equal(session!.scopeId, `group:${container}`, "the worker acts at the group's own scope");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited ask in a group DM runs as the asking person via group-membership attestation", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-mpim-solicited";
    await built.directory.replace([
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U1" },
    ]);
    await built.directory.replaceGroups([{ groupId: container, principalId: "alice@acme.com" }]);
    await built.app.setChannelPolicy(container, "!engage-asked", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "500.1",
        authorId: "U1",
        authorName: "Alice",
        text: "!post group solicited reply",
        kind: "group",
        createdAt: 1,
      },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "the solicited worker posted exactly once");
    assert.match(pending[0].text, /^group solicited reply/);
    const session = await built.sessions.getByThread(`slack:${container}:ambient:500.1`);
    assert.ok(session, "the worker session exists");
    assert.equal(session!.scopeId, `group:${container}`, "and it lives at the group scope");
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, ["alice@acme.com"], "the turn ran as the asking person, not the system actor");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited ask in a group DM whose author is NOT a pushed member degrades to proactive", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-mpim-nonmember";
    await built.directory.replace([
      { principalId: "mallory@acme.com", displayName: "Mallory", type: "internal", slackId: "U9" },
    ]);
    await built.app.setChannelPolicy(container, "!engage-asked !post proactive fallback", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "600.1",
        authorId: "U9",
        authorName: "Mallory",
        text: "can you check this?",
        kind: "group",
        createdAt: 1,
      },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "the wake still engages (proactively)");
    const session = await built.sessions.getByThread(`slack:${container}:ambient:600.1`);
    assert.ok(session, "the worker session exists");
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, [], "degraded to the system actor — no person's authority conferred");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited verdict for a message that isn't the newest speaker's degrades to proactive", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-disarmed";
    await built.directory.replace([
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U1" },
      { principalId: "mallory@acme.com", displayName: "Mallory", type: "internal", slackId: "U2" },
    ]);
    await built.directory.replaceChannels([{ channelId: container, name: "disarmed-chan", isPrivate: false }]);
    await built.app.setChannelPolicy(container, "!engage-asked !post disarmed reply", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "500.1",
        authorId: "U1",
        authorName: "Alice",
        text: "qm can you check the deploy?",
        createdAt: 1,
      },
      { container, ts: "500.2", authorId: "U2", authorName: "Mallory", text: "unrelated chatter", createdAt: 2 },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "the wake still engaged, proactively");
    assert.match(pending[0].text, /^disarmed reply/);
    const session = await built.sessions.getByThread(`slack:${container}:ambient:500.2`);
    assert.ok(session, "the worker session exists, keyed on the batch's latest ts");
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, [], "no person's authority was borrowed");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited wake in a private channel requires the asker in the pre-pushed membership", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-private";
    await built.directory.replace([
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U1" },
    ]);
    await built.directory.replaceChannels(
      [{ channelId: container, name: "private-chan", isPrivate: true }],
      [{ channelId: container, principalId: "alice@acme.com" }],
    );
    await built.app.setChannelPolicy(container, "!engage-asked", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "600.1", authorId: "U1", authorName: "Alice", text: "!post private reply", createdAt: 1 },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1);
    assert.match(pending[0].text, /^private reply/);
    const session = await built.sessions.getByThread(`slack:${container}:ambient:600.1`);
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, ["alice@acme.com"], "attested private room confers the asker's authority");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited wake whose author isn't in the directory degrades to the proactive system actor", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-unknown-asker";
    await built.app.setChannelPolicy(container, "!engage-asked !post fallback reply", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "400.1",
        authorId: "U-stranger",
        authorName: "Stranger",
        text: "qm can you check something?",
        createdAt: 1,
      },
    ]);
    const pending = await pollDeliveries(built.deliveries);
    assert.equal(pending.length, 1, "the fallback worker still posted");
    assert.match(pending[0].text, /^fallback reply/);
    const session = await built.sessions.getByThread(`slack:${container}:ambient:400.1`);
    assert.ok(session, "the worker session exists");
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, [], "no person was impersonated — the system actor ran the turn");
  } finally {
    await built.runtime.stop();
  }
});

test("a second ambient wake while the first worker is LIVE steers into it instead of forking a sibling reply", async () => {
  const built = freshApp();
  const container = "C-coalesce";
  await built.app.setChannelPolicy(container, "!engage !post tag the team", "U-admin");

  await built.app.ingestSurfaceEvents([
    { container, ts: "100.1", authorId: "U1", text: "events site is down", createdAt: 1 },
  ]);
  await built.app.judgeAmbientContainer("slack", container);
  const firstRef = `slack:${container}:ambient:100.1`;
  const live = await built.runs.activeForThread(firstRef);
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
});
