import { startEventPump, TwinAdmin } from "../../test/live-slack/arga.ts";
import { SlackClient, sleep } from "../../test/live-slack/slack.ts";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required`);
  return v;
}

interface Twin {
  label: string;
  baseUrl: string;
  botToken: string;
  signingSecret: string;
  adminUrl: string;
  proxyToken: string;
  qaToken: string;
  actors: Record<string, string>;
  eventsPort: number;
}

function twinFromEnv(prefix: string, label: string, eventsPort: number): Twin {
  return {
    label,
    baseUrl: req(`${prefix}SLACK_API_URL`),
    botToken: req(`${prefix}SLACK_BOT_TOKEN`),
    signingSecret: req(`${prefix}SLACK_SIGNING_SECRET`),
    adminUrl: req(`${prefix}ARGA_TWIN_ADMIN_URL`),
    proxyToken: req(`${prefix}ARGA_TWIN_PROXY_TOKEN`),
    qaToken: req(`${prefix}SLACK_QA_USER_TOKEN`),
    actors: JSON.parse(req(`${prefix}LIVE_E2E_ACTOR_TOKENS`)) as Record<string, string>,
    eventsPort,
  };
}

async function botReplyAfter(client: SlackClient, channel: string, afterTs: string, botUserId: string, waitMs: number) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const msgs = await client.history(channel, afterTs);
    const reply = msgs.find(
      (m) =>
        m.user === botUserId &&
        Number(m.ts) > Number(afterTs) &&
        m.text &&
        !m.text.includes("Working…") &&
        !m.text.includes("⏳") &&
        !m.text.endsWith("▌"),
    );
    if (reply) return reply;
    await sleep(2000);
  }
  return undefined;
}

async function main(): Promise<void> {
  const a = twinFromEnv("", "primary", Number(process.env.SLACK_EVENTS_PORT ?? "8182"));
  const b = twinFromEnv("B_", "batch", Number(req("B_SLACK_EVENTS_PORT")));

  const results: string[] = [];
  const pumps: Array<{ stop(): void }> = [];
  try {
    for (const t of [a, b]) {
      const bot = await new SlackClient(t.botToken, t.baseUrl).authTest();
      const admin = new TwinAdmin(t.adminUrl, t.proxyToken);
      pumps.push(
        startEventPump({
          admin,
          signingSecret: t.signingSecret,
          targetUrl: `http://127.0.0.1:${t.eventsPort}/slack/events`,
          botUserId: bot.userId,
        }),
      );
      console.log(`pump ${t.label} → :${t.eventsPort} (bot ${bot.userId})`);
    }

    const botA = await new SlackClient(a.botToken, a.baseUrl).authTest();
    const qaA = new SlackClient(a.qaToken, a.baseUrl);
    const chA = await qaA.createChannel(`multiws-a-${Math.floor(Date.now() / 1000)}`);
    await qaA.invite(chA, botA.userId);
    const tsA = await qaA.post(chA, `<@${botA.userId}> reply with exactly the word pong`);
    const replyA = await botReplyAfter(qaA, chA, tsA, botA.userId, 90_000);
    results.push(`primary-workspace mention answered: ${replyA ? `PASS ("${replyA.text?.slice(0, 60)}")` : "FAIL"}`);

    const botB = await new SlackClient(b.botToken, b.baseUrl).authTest();
    const alice = new SlackClient(b.actors.alice!, b.baseUrl);
    const bob = new SlackClient(b.actors.bob!, b.baseUrl);
    const qaB = new SlackClient(b.qaToken, b.baseUrl);
    const chB = await qaB.createChannel(`multiws-b-${Math.floor(Date.now() / 1000)}`);
    const aliceId = (await alice.authTest()).userId;
    const bobId = (await bob.authTest()).userId;
    await qaB.invite(chB, `${botB.userId},${aliceId},${bobId}`);

    const tsStaff = await alice.post(chB, `<@${botB.userId}> reply with exactly the word pong`);
    const replyStaff = await botReplyAfter(alice, chB, tsStaff, botB.userId, 90_000);
    results.push(
      `batch-workspace staff (allowFrom match) answered: ${replyStaff ? `PASS ("${replyStaff.text?.slice(0, 60)}")` : "FAIL"}`,
    );

    const tsFounder = await bob.post(chB, `<@${botB.userId}> reply with exactly the word pong`);
    const replyFounder = await botReplyAfter(bob, chB, tsFounder, botB.userId, 45_000);
    results.push(
      `batch-workspace non-staff silently ignored: ${replyFounder ? `FAIL ("${replyFounder.text}")` : "PASS"}`,
    );
  } finally {
    for (const p of pumps) p.stop();
  }
  console.log("\n=== multi-workspace live results ===");
  for (const r of results) console.log(r);
  if (results.some((r) => r.includes("FAIL"))) process.exit(1);
}

await main();
