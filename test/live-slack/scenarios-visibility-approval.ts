import { createHmac } from "node:crypto";
import { assert, type Actor, type Ctx, type Env, type Scenario } from "./harness.ts";
import { sleep, type SlackMessage } from "./slack.ts";

const EVENTS_URL = () =>
  process.env.SLACK_EVENTS_TARGET_URL ?? `http://127.0.0.1:${process.env.SLACK_EVENTS_PORT ?? "8182"}/slack/events`;

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 360_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const buttons = (m: SlackMessage): Array<{ action_id: string; value: string; block_id?: string }> => {
  const block = (m.blocks ?? []).find((b) => b.type === "actions") as
    { block_id?: string; elements?: Array<{ action_id: string; value: string }> } | undefined;
  return (block?.elements ?? []).map((e) => ({ ...e, block_id: block?.block_id }));
};

const isCard = (env: Env, app: string) => (m: SlackMessage) =>
  m.user === env.botUserId &&
  buttons(m).some((b) => b.action_id === "hilo_allow_once") &&
  (JSON.stringify(m.blocks ?? []) + (m.text ?? "")).includes(app);

async function click(env: Env, clicker: Actor, channel: string, card: SlackMessage): Promise<void> {
  const action = buttons(card).find((a) => a.action_id === "hilo_allow_once")!;
  const body = `payload=${encodeURIComponent(
    JSON.stringify({
      type: "block_actions",
      team: { id: env.teamId, domain: "e2e" },
      user: { id: clicker.userId, username: clicker.handle, team_id: env.teamId },
      api_app_id: "AE2E",
      container: {
        type: "message",
        message_ts: card.ts,
        channel_id: channel,
        is_ephemeral: false,
        ...(card.thread_ts ? { thread_ts: card.thread_ts } : {}),
      },
      channel: { id: channel, name: "c" },
      message: { type: "message", ts: card.ts, text: card.text, user: env.botUserId, thread_ts: card.thread_ts },
      actions: [{ ...action, type: "button", action_ts: `${Date.now() / 1000}` }],
    }),
  )}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", process.env.SLACK_SIGNING_SECRET ?? "")
    .update(`v0:${ts}:${body}`)
    .digest("hex")}`;
  const res = await fetch(EVENTS_URL(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": signature,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(res.status, 200);
}

async function messages(client: Actor["client"], channel: string, root?: string): Promise<SlackMessage[]> {
  return root
    ? [...(await client.replies(channel, root)), ...(await client.history(channel, root))]
    : client.history(channel, "0");
}

const appPrompt = (name: string) =>
  `Publish a tiny app named "${name}": a Node server.js that answers "ok" on $PORT, entrypoint "node server.js". Then make it public so anyone with the link can open it. Once it is actually public, post a message containing exactly VIS_DONE and nothing else; never write that token otherwise.`;

const MODES = ["thread", "dm", "subagent", "cron"] as const;
const ACTOR = { thread: "alice", dm: "bob", subagent: "carol", cron: "alice" } as const;

export const visibilityApprovalScenarios: Scenario[] = MODES.map((mode) => ({
  name: `visibility-approval-card-${mode}`,
  lane: "parallel",
  tags: ["twin", "apps"],
  actors: [ACTOR[mode]],
  timeoutMs: 20 * 60_000,
  async run(ctx: Ctx) {
    const env = ctx.env;
    const owner = ctx.actor(ACTOR[mode]);
    const name = `vis-${mode}-${env.runId.slice(-6)}`;
    const ownerDm = await owner.client.openDm(env.botUserId);
    const since = String(Date.now() / 1000);
    let channel: string;
    let root: string | undefined;
    if (mode === "dm") {
      channel = ownerDm;
      await owner.client.post(ownerDm, appPrompt(name));
    } else {
      const ch = await ctx.freshChannel();
      channel = ch.id;
      const as = ch.as(owner);
      if (mode === "thread") root = await as.mention(appPrompt(name));
      else if (mode === "subagent")
        root = await as.mention(
          `Open a sub-agent session (sessions tool, action open) and have IT do this work, not you: ${appPrompt(name)}`,
        );
      else {
        root = await as.mention(
          `Publish a tiny app named "${name}" (Node server.js answering "ok" on $PORT, entrypoint "node server.js") and keep it private. Then schedule a one-shot cron for 1 minute from now that posts back to this thread and, when it fires, makes "${name}" public and then posts a message containing exactly VIS_DONE and nothing else (never write that token otherwise). Reply SCHEDULED now.`,
        );
      }
    }
    const card = await waitFor("approval card where the request was made", async () =>
      (await messages(owner.client, channel, root)).find((m) => Number(m.ts) > Number(since) && isCard(env, name)(m)),
    ).catch(async (error) => {
      const all = (await messages(owner.client, channel, root).catch(() => []))
        .filter((m) => m.user === env.botUserId)
        .map((m) => `${JSON.stringify((m.text ?? "").slice(0, 60))}${buttons(m).length ? "[buttons]" : ""}`);
      (error as Error).message += ` (bot messages: ${all.join(" | ") || "none"})`;
      const inDm = mode !== "dm" && (await owner.client.history(ownerDm, since)).some(isCard(env, name));
      throw new Error(`${(error as Error).message}${inDm ? " (it went to the owner's DM instead)" : ""}`);
    });
    const problems: string[] = [];
    if (!/public|anyone with the link/i.test(JSON.stringify(card.blocks ?? []) + (card.text ?? "")))
      problems.push("card does not say it makes the app public");
    if (mode !== "dm" && (await owner.client.history(ownerDm, since)).some(isCard(env, name)))
      problems.push("card also went to the owner's DM");
    const early = (await messages(owner.client, channel, root)).some(
      (m) => m.user === env.botUserId && Number(m.ts) > Number(since) && (m.text ?? "").trim() === "VIS_DONE",
    );
    if (early) problems.push("app was reported public before approval");
    await click(env, owner, channel, card);
    await waitFor("work to resume after approval", async () =>
      (await messages(owner.client, channel, root)).some(
        (m) => m.user === env.botUserId && Number(m.ts) >= Number(card.ts) && (m.text ?? "").trim() === "VIS_DONE",
      )
        ? true
        : undefined,
    ).catch(async () => {
      const seen = (await messages(owner.client, channel, root).catch(() => []))
        .filter((m) => m.user === env.botUserId && Number(m.ts) >= Number(card.ts))
        .map((m) => JSON.stringify((m.text ?? "").slice(0, 80)));
      problems.push(`approving did not resume the work (bot after card: ${seen.join(" | ") || "nothing"})`);
    });
    assert.deepEqual(problems, [], problems.join("; "));
  },
}));
