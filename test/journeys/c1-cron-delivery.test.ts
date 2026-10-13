import assert from "node:assert/strict";
import { test } from "node:test";
import type { Receiver } from "@slack/bolt";
import { startSlackPlugin } from "../../src/slack/index.ts";
import { principalDestination } from "../../src/reach/reach.ts";
import { scopeId as makeScopeId } from "../../src/types.ts";
import type { Cron, CronFireLogEntry } from "../../src/types.ts";
import { journeyTestOptions, startJourneyApp, waitFor, type JourneyApp } from "./support/journey-app.ts";
import { startFakeSlack, type FakeSlack } from "./support/fake-slack.ts";

const OWNER = "U1OWNER";
const TEAMMATE = "U2MATE";
const CHANNEL = "C1REPORTS";
const ARCHIVED = "C2ARCHIVED";
const OWNER_DM = "D1OWNER";

const noopReceiver = (): Receiver => ({
  init() {},
  start: async () => {},
  stop: async () => {},
});

interface Harness {
  app: JourneyApp;
  slack: FakeSlack;
  stop(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const slack = await startFakeSlack();
  slack.users.set(OWNER, { id: OWNER, name: "owner", email: "owner@example.com" });
  slack.users.set(TEAMMATE, { id: TEAMMATE, name: "mate", email: "mate@example.com" });
  slack.channels.set(CHANNEL, { id: CHANNEL, name: "reports" });
  slack.channels.set(ARCHIVED, { id: ARCHIVED, name: "old-reports", is_archived: true });
  slack.channels.set(OWNER_DM, { id: OWNER_DM, name: "", is_im: true });
  slack.dmFor.set(OWNER, OWNER_DM);
  const app = await startJourneyApp(
    { maxRequestBytes: 10 * 1024 * 1024, contextWindowTokens: 200_000, maxOutputTokens: 16_000 },
    { securityScreen: "off" },
  );
  app.gateway.respond = (req) => {
    const prompt = JSON.stringify(req.messages.at(-1)?.content ?? "");
    const marker = /REPORT-[a-z0-9-]+/i.exec(prompt)?.[0] ?? "no-marker";
    return { text: `Daily numbers: ${marker}` };
  };
  const plugin = await startSlackPlugin(
    {
      botToken: "xoxb-journey",
      apiUrl: slack.url,
      identityEmail: "0",
      receiverFactory: noopReceiver,
    },
    app.built.slackCore,
  );
  const webUi = setInterval(() => {
    void app.built.app
      .pendingDeliveries("web")
      .then((rows) => Promise.all(rows.map((d) => app.built.app.ackDelivery(d.id))))
      .catch(() => undefined);
  }, 250);
  app.built.scheduler.start(250);
  await app.built.scheduler.ready();
  return {
    app,
    slack,
    async stop() {
      clearInterval(webUi);
      await plugin.stop();
      await app.stop();
      await slack.close();
    },
  };
}

function createCron(
  h: Harness,
  input: { destination: Cron["destination"]; marker: string; title: string },
): Promise<Cron> {
  return h.app.built.crons.create({
    owner: OWNER,
    createdBy: OWNER,
    ownerScopeId: makeScopeId("personal", OWNER),
    title: input.title,
    action: `Post the daily numbers. Include the token ${input.marker} verbatim.`,
    schedule: { firstFireAt: Date.now() + 300 },
    destination: input.destination,
    ownerConsentedAt: Date.now(),
  });
}

async function latestFire(h: Harness, cronId: string): Promise<CronFireLogEntry | undefined> {
  const { runs } = await h.app.built.crons.listFires(cronId);
  return runs.at(-1);
}

async function settledFire(h: Harness, cronId: string): Promise<CronFireLogEntry> {
  return waitFor(async () => {
    const fire = await latestFire(h, cronId);
    return fire && fire.status !== "running" && fire.status !== "delivering" ? fire : undefined;
  }, `cron ${cronId} to settle`);
}

test(
  "C1: a cron fire lands in its Slack channel exactly once, and is only ok once the post succeeded",
  journeyTestOptions(120_000),
  async () => {
    const h = await startHarness();
    try {
      const marker = `REPORT-${Date.now().toString(36)}`;
      let releasePost!: () => void;
      h.slack.holdPosts = new Promise<void>((resolve) => (releasePost = resolve));
      const cron = await createCron(h, {
        title: "Daily numbers",
        marker,
        destination: { type: "slack", target: CHANNEL, audienceScopeId: makeScopeId("channel", CHANNEL) },
      });
      const postAttempt = await waitFor(
        async () => h.slack.calls.find((c) => c.method === "chat.postMessage" && String(c.args.text).includes(marker)),
        "the Slack post attempt",
      );
      assert.equal(postAttempt.args.channel, CHANNEL);
      const whileHeld = await latestFire(h, cron.id);
      assert.equal(whileHeld?.status, "delivering", "the fire is not ok while the post is still in flight");
      releasePost();
      const fire = await settledFire(h, cron.id);
      assert.equal(fire.status, "ok", fire.note);
      const posts = h.slack.posts.filter((p) => p.channel === CHANNEL && p.text?.includes(marker));
      assert.equal(posts.length, 1, "exactly one delivery");
    } finally {
      await h.stop();
    }
  },
);

test("C1: two crons due in the same minute in one DM both deliver", journeyTestOptions(120_000), async () => {
  const h = await startHarness();
  try {
    const markers = [`REPORT-a${Date.now().toString(36)}`, `REPORT-b${Date.now().toString(36)}`];
    const crons = await Promise.all(
      markers.map((marker, i) =>
        createCron(h, {
          title: `Reminder ${i + 1}`,
          marker,
          destination: { type: "slack", target: OWNER_DM, audienceScopeId: makeScopeId("personal", OWNER) },
        }),
      ),
    );
    const fires = await Promise.all(crons.map((cron) => settledFire(h, cron.id)));
    assert.deepEqual(
      fires.map((f) => f.status),
      ["ok", "ok"],
      fires.map((f) => f.note).join(" | "),
    );
    for (const marker of markers) {
      const posts = await waitFor(async () => {
        const hits = h.slack.posts.filter((p) => p.channel === OWNER_DM && p.text?.includes(marker));
        return hits.length ? hits : undefined;
      }, `delivery of ${marker}`);
      assert.equal(posts.length, 1, `exactly one delivery of ${marker}`);
    }
  } finally {
    await h.stop();
  }
});

test("C1: a cron aimed at an archived channel is not reported ok", journeyTestOptions(120_000), async () => {
  const h = await startHarness();
  try {
    const marker = `REPORT-arch${Date.now().toString(36)}`;
    const cron = await createCron(h, {
      title: "Archived report",
      marker,
      destination: { type: "slack", target: ARCHIVED, audienceScopeId: makeScopeId("channel", ARCHIVED) },
    });
    const fire = await settledFire(h, cron.id);
    assert.equal(fire.status, "failed");
    assert.match(fire.note ?? "", /is_archived/);
    assert.equal(h.slack.posts.filter((p) => p.text?.includes(marker)).length, 0);
  } finally {
    await h.stop();
  }
});

test("C1: a cron aimed at a person Slack cannot resolve is not reported ok", journeyTestOptions(120_000), async () => {
  const h = await startHarness();
  try {
    const marker = `REPORT-gone${Date.now().toString(36)}`;
    const cron = await createCron(h, {
      title: "DM to departed teammate",
      marker,
      destination: principalDestination(TEAMMATE, OWNER),
    });
    const fire = await settledFire(h, cron.id);
    assert.equal(fire.status, "failed");
    assert.match(fire.note ?? "", /user_not_found/);
    assert.equal(h.slack.posts.filter((p) => p.text?.includes(marker)).length, 0);
  } finally {
    await h.stop();
  }
});

test(
  "C1: a cron aimed at a web thread lands in that thread's transcript exactly once",
  journeyTestOptions(120_000),
  async () => {
    const h = await startHarness();
    try {
      const actor = "owner@example.com";
      const threadRef = `web:${actor}:numbers-${Date.now()}`;
      await h.app.webTurn(actor, threadRef, "Keep the daily numbers here.");
      const marker = `REPORT-web${Date.now().toString(36)}`;
      const cron = await h.app.built.crons.create({
        owner: actor,
        createdBy: actor,
        ownerScopeId: makeScopeId("personal", actor),
        title: "Daily numbers (web)",
        action: `Post the daily numbers. Include the token ${marker} verbatim.`,
        schedule: { firstFireAt: Date.now() + 300 },
        destination: { type: "web", target: threadRef, audienceScopeId: makeScopeId("personal", actor) },
        ownerConsentedAt: Date.now(),
      });
      const fire = await settledFire(h, cron.id);
      assert.equal(fire.status, "ok", fire.note);
      const session = await h.app.built.sessions.getByThread(threadRef);
      const entries = (await h.app.built.sessions.getContextWindow(session!.id)).entries;
      const landed = entries.filter((e) => e.type === "assistant" && JSON.stringify(e.payload).includes(marker));
      assert.equal(landed.length, 1, "exactly one transcript delivery");
    } finally {
      await h.stop();
    }
  },
);
