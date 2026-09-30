import { createHmac } from "node:crypto";
import { assert, type Actor, type Ctx, type Env, type Scenario } from "./harness.ts";
import { sleep, type SlackMessage } from "./slack.ts";
import { signedRequestHeaders } from "../../src/auth/source-auth-sign.ts";

const EVENTS_URL = () =>
  process.env.SLACK_EVENTS_TARGET_URL ?? `http://127.0.0.1:${process.env.SLACK_EVENTS_PORT ?? "8182"}/slack/events`;
const LEAK = /\b[0-9a-f]{12}\b|mention me|paused|keychain ask/i;

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

async function click(env: Env, clicker: Actor, channel: string, card: SlackMessage, actionId: string): Promise<void> {
  const action = buttons(card).find((a) => a.action_id === actionId);
  assert.ok(action, `card has no ${actionId} button`);
  const body = `payload=${encodeURIComponent(
    JSON.stringify({
      type: "block_actions",
      team: { id: env.teamId, domain: "e2e" },
      user: { id: clicker.userId, username: clicker.handle, team_id: env.teamId },
      api_app_id: "AE2E",
      container: { type: "message", message_ts: card.ts, channel_id: channel, is_ephemeral: false },
      channel: { id: channel, name: "directmessage" },
      message: { type: "message", ts: card.ts, text: card.text, user: env.botUserId },
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

async function approveOnWeb(env: Env, owner: Actor, card: SlackMessage): Promise<void> {
  const askId = buttons(card)[0]!.value;
  const principalId =
    (await env.core.resolveDirectory(owner.handle).catch(() => ({ members: [] as Array<{ principalId: string }> })))
      .members[0]?.principalId ?? owner.userId;
  const path = `/v1/keychain/approvals/${encodeURIComponent(askId)}`;
  const body = JSON.stringify({ principalId, decision: "standing" });
  const res = await fetch(`${(process.env.CORE_API_URL ?? "http://localhost:8181").replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: signedRequestHeaders(process.env.CORE_SIGNING_SECRET ?? "", "POST", path, body),
    body,
  });
  assert.equal(res.status, 200, `web approval failed: ${res.status} ${await res.text()}`);
}

const isCard = (env: Env, service: string) => (m: SlackMessage) =>
  m.user === env.botUserId && (m.text ?? "").includes(service) && buttons(m).length > 0;

async function threadMessages(ctx: Ctx, channel: string, root: string): Promise<SlackMessage[]> {
  return [...(await ctx.env.qa.replies(channel, root)), ...(await ctx.env.qa.history(channel, root))];
}

async function nextCard(
  ctx: Ctx,
  channel: string,
  root: string,
  after: string,
  service: string,
): Promise<SlackMessage> {
  return waitFor("approval card in the requesting thread", async () =>
    (await threadMessages(ctx, channel, root)).find((m) => Number(m.ts) > Number(after) && isCard(ctx.env, service)(m)),
  );
}

async function threadText(ctx: Ctx, channel: string, root: string, after: string): Promise<string> {
  return (await threadMessages(ctx, channel, root))
    .filter((m) => m.user === ctx.env.botUserId && Number(m.ts) > Number(after))
    .map((m) => m.text ?? "")
    .join("\n");
}

async function childSessionIn(ctx: Ctx, scope: string): Promise<boolean> {
  const core = ctx.core as unknown as {
    listSessions(): Promise<{ sessions: Array<{ id: string }> }>;
    getSession(id: string): Promise<{ session?: { scopeId?: string; parentSessionId?: string } }>;
  };
  for (const { id } of (await core.listSessions()).sessions) {
    const { session } = await core.getSession(id);
    if (session?.scopeId === scope && session.parentSessionId) return true;
  }
  return false;
}

const OWNER = { once: "alice", standing: "carol", web: "bob", cron: "alice" } as const;

export const credentialApprovalScenarios: Scenario[] = (["once", "standing", "web", "cron"] as const).map((mode) => ({
  name: `credential-approval-card-${mode}`,
  lane: "parallel",
  tags: ["twin", "keychain"],
  actors: [OWNER[mode]],
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const env = ctx.env;
    const problems: string[] = [];
    const owner = ctx.actor(OWNER[mode]);
    const marker = ctx.marker(mode);
    const fixture = `fixture-${marker}`;
    const ownerDm = await owner.client.openDm(env.botUserId);
    const seed = await owner.client.post(
      ownerDm,
      `Register this synthetic test value in my keychain (it is not a real secret): POST /v1/keychain/credentials with service "demo-${mode}", envKey "DEMO_FIXTURE", secret "${fixture}". Reply DONE when saved.`,
    );
    await waitFor("seed saved", async () =>
      (await owner.client.history(ownerDm, seed)).find((m) => m.user === env.botUserId && /DONE/.test(m.text ?? "")),
    );

    const channel = await ctx.freshChannel();
    const since = String(Date.now() / 1000);
    const command = `printf %s "$DEMO_FIXTURE" | wc -c`;
    const root = await channel.mention(
      mode === "cron"
        ? `Schedule a one-shot cron for 1 minute from now that posts back to this thread. When it fires it must run \`${command}\` here with ${owner.mention}'s demo-cron credential, requesting access through the keychain if needed, and reply COUNT=<number>. Reply SCHEDULED now.`
        : `Open a sub-agent session (sessions tool, action open) for this and have IT do the work: using ${owner.mention}'s demo-${mode} credential, run \`${command}\` and reply COUNT=<number>. ` +
            `The sub-agent should run it here with a keychain grant, requesting access through the keychain if needed${mode === "once" ? ", for just this one command" : ""} — do not hand it to their agent.`,
    );
    const card = await nextCard(ctx, channel.id, root, root, `demo-${mode}`).catch(async (error) => {
      const inDm = (await owner.client.history(ownerDm, since)).some(isCard(env, `demo-${mode}`));
      throw new Error(`${(error as Error).message}${inDm ? " (it went to the owner's DM)" : ""}`);
    });
    const cardText = JSON.stringify(card.blocks ?? []) + (card.text ?? "");
    if (/Why:/.test(cardText)) problems.push("card shows the raw purpose");
    if ((await owner.client.history(ownerDm, since)).some(isCard(env, `demo-${mode}`)))
      problems.push("the card also went to the owner's DM instead of only the requesting conversation");
    if (mode === "web" || mode === "cron") await approveOnWeb(env, owner, card);
    else await click(env, owner, channel.id, card, mode === "once" ? "keychain_allow_once" : "keychain_allow_always");
    await waitFor(
      "the Slack card to show the decision",
      async () => {
        const now = (await threadMessages(ctx, channel.id, root)).find((m) => m.ts === card.ts);
        return now && buttons(now).length === 0 && /Approved/.test(now.text ?? "") ? true : undefined;
      },
      120_000,
    ).catch(() => problems.push("the Slack card never showed the decision"));
    const count = String(fixture.length);
    await waitFor("command to resume", async () =>
      (await threadText(ctx, channel.id, root, root)).includes(`COUNT=${count}`) ? true : undefined,
    );
    const first = await threadText(ctx, channel.id, root, root);
    if (LEAK.test(first)) problems.push(`requester thread leaked plumbing: ${first.match(LEAK)?.[0]}`);

    if (mode === "cron") return assert.deepEqual(problems, [], problems.join("; "));
    if (!(await childSessionIn(ctx, `channel:${channel.id}`))) problems.push("no sub-agent session did the work");

    const again = await channel.threadReply(
      root,
      `<@${env.botUserId}> run that exact command again and reply COUNT=<number>.`,
    );
    if (mode === "once") {
      const next = await nextCard(ctx, channel.id, root, again, `demo-${mode}`);
      await click(env, owner, channel.id, next, "keychain_allow_once");
    }
    const since2 = String(Date.now() / 1000);
    await waitFor("re-run", async () =>
      (await threadText(ctx, channel.id, root, again)).includes(`COUNT=${count}`) ? true : undefined,
    ).catch(() => problems.push("re-running the approved command did not succeed"));
    const extraCard = (await threadMessages(ctx, channel.id, root)).find(
      (m) => Number(m.ts) > Number(since2) && isCard(env, `demo-${mode}`)(m),
    );
    if (extraCard) problems.push("re-running an approved command asked for approval again");

    if (mode === "standing") {
      const revoke = await owner.client.post(
        ownerDm,
        `Revoke every demo-${mode} grant I gave to other conversations. Reply REVOKED when done.`,
      );
      await waitFor("revoked", async () =>
        (await owner.client.history(ownerDm, revoke)).find(
          (m) => m.user === env.botUserId && /REVOKED/.test(m.text ?? ""),
        ),
      );
      const again3 = await channel.threadReply(
        root,
        `<@${env.botUserId}> run that command once more and reply COUNT=<number>.`,
      );
      await nextCard(ctx, channel.id, root, again3, `demo-${mode}`);
    }
    assert.deepEqual(problems, [], problems.join("; "));
  },
}));
