import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { provisionSlackTwin, seedTwinUsers, teardownTwin, TwinAdmin } from "./arga.ts";
import { SlackClient } from "./slack.ts";

const ACTOR_NAMES = ["alice", "bob", "carol"];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const SECRET_KEYS = new Set([
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_QA_USER_TOKEN",
  "LIVE_E2E_ACTOR_TOKENS",
  "ARGA_TWIN_PROXY_TOKEN",
]);

function emitEnv(pairs: Record<string, string>): void {
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${v}`);
  if (process.env.GITHUB_ENV) {
    for (const [k, v] of Object.entries(pairs)) if (SECRET_KEYS.has(k)) console.log(`::add-mask::${v}`);
    appendFileSync(process.env.GITHUB_ENV, lines.join("\n") + "\n");
    console.log(`wrote ${lines.length} vars to GITHUB_ENV`);
  } else {
    for (const [k, v] of Object.entries(pairs)) console.log(`export ${k}=${JSON.stringify(v)}`);
  }
}

export async function provisionTwinEnvironment(defaultTtl = 60): Promise<Record<string, string>> {
  const apiKey = requireEnv("ARGA_API_KEY");
  const ttl = Number(process.env.ARGA_TWIN_TTL_MINUTES) || defaultTtl;
  let session;
  try {
    session = await provisionSlackTwin(apiKey, ttl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ttl > 10 && msg.includes("up to 10 minutes")) {
      console.log("plan caps twin TTL at 10 minutes — retrying with ttl=10");
      session = await provisionSlackTwin(apiKey, 10);
    } else throw err;
  }
  console.log(`twin ready: ${session.baseUrl} (run ${session.runId})`);

  try {
    const admin = new TwinAdmin(session.adminUrl, session.proxyToken);
    const seeded = await seedTwinUsers(admin, session, ["qa", ...ACTOR_NAMES]);
    const qa = seeded.get("qa")!;

    const qaClient = new SlackClient(qa.token, session.baseUrl);
    const botAuth = await new SlackClient(session.botToken, session.baseUrl).authTest();
    const targetChannel = await qaClient.createChannel(`ci-target-${Math.floor(Date.now() / 1000)}`);
    await qaClient.invite(targetChannel, botAuth.userId);
    console.log(
      `seeded users: ${[...seeded.keys()].join(", ")}; target channel ${targetChannel}; bot <@${botAuth.userId}>`,
    );

    const actorTokens = Object.fromEntries(ACTOR_NAMES.map((n) => [n, seeded.get(n)!.token]));
    return {
      SLACK_API_URL: session.baseUrl,
      SLACK_BOT_TOKEN: session.botToken,
      SLACK_SIGNING_SECRET: session.signingSecret,
      SLACK_EVENTS_MODE: "http",
      SLACK_EVENTS_PORT: process.env.SLACK_EVENTS_PORT ?? "8182",
      SLACK_IDENTITY_EMAIL: "0",
      SLACK_QA_USER_TOKEN: qa.token,
      LIVE_E2E_ACTOR_TOKENS: JSON.stringify(actorTokens),
      LIVE_E2E_TARGET_CHANNEL: targetChannel,
      ARGA_TWIN_RUN_ID: session.runId,
      ARGA_TWIN_ADMIN_URL: session.adminUrl,
      ARGA_TWIN_PROXY_TOKEN: session.proxyToken,
    };
  } catch (err) {
    await teardownTwin(apiKey, session.runId).catch(() => {});
    throw err;
  }
}

export async function teardownTwinEnvironment(
  apiKey = requireEnv("ARGA_API_KEY"),
  runId = process.env.ARGA_TWIN_RUN_ID,
): Promise<void> {
  if (!runId) {
    console.log("no ARGA_TWIN_RUN_ID — nothing to tear down");
    return;
  }
  await teardownTwin(apiKey, runId);
  console.log(`twin ${runId} torn down`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "up") emitEnv(await provisionTwinEnvironment());
  else if (cmd === "down") await teardownTwinEnvironment();
  else {
    console.error("usage: node test/live-slack/arga-provision.ts up|down");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
