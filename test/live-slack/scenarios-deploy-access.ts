import { request as httpRequest } from "node:http";
import { text } from "node:stream/consumers";
import { createHmac } from "node:crypto";
import { assert, type Actor, type Env, type Scenario } from "./harness.ts";
import { sleep, type SlackMessage } from "./slack.ts";
import { signedRequestHeaders } from "../../src/auth/source-auth-sign.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../src/auth/portal-identity.ts";

const CORE = () => (process.env.CORE_API_URL ?? "http://localhost:8181").replace(/\/+$/, "");
const SECRET = () => process.env.CORE_SIGNING_SECRET ?? "";
const APPS_DOMAIN = () => process.env.DEPLOY_APPS_DOMAIN ?? "";
const SESSION_SECRET = () => process.env.DEPLOY_APPS_SESSION_SECRET ?? "";
const EVENTS_URL = () =>
  process.env.SLACK_EVENTS_TARGET_URL ?? `http://127.0.0.1:${process.env.SLACK_EVENTS_PORT ?? "8182"}/slack/events`;

const APP_SOURCE = (marker: string) =>
  `import { createServer } from "node:http";\ncreateServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("hello from ${marker}"); }).listen(Number(process.env.PORT), "127.0.0.1");\n`;

async function principalOf(env: Env, actor: Actor): Promise<string> {
  const r = await env.core
    .resolveDirectory(actor.handle)
    .catch(() => ({ members: [] as Array<{ principalId: string }> }));
  return r.members[0]?.principalId ?? actor.userId;
}

function portalSession(sub: string): string {
  const key = createHmac("sha256", SESSION_SECRET()).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + 3600 })).toString(
    "base64url",
  );
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function gateway(slug: string, sub: string, request = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${CORE()}${request ? "/__claw__/request-access" : "/"}`,
      {
        method: request ? "POST" : "GET",
        headers: {
          Host: `${slug}.${APPS_DOMAIN()}`,
          Accept: "text/html",
          Cookie: `portal_session=${portalSession(sub)}`,
        },
      },
      (res) => {
        text(res).then((body) => resolve({ status: res.statusCode ?? 0, body }), reject);
      },
    );
    req.setTimeout(45_000, () => req.destroy(new Error("gateway timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function publishApp(owner: string, slug: string, marker: string): Promise<void> {
  const path = `/v1/deployments?_nonce=${crypto.randomUUID()}`;
  const body = JSON.stringify({
    ownerScopeId: `personal:${owner}`,
    createdBy: owner,
    name: slug,
    entrypoint: "node server.mjs",
    files: [{ path: "server.mjs", data: APP_SOURCE(marker) }],
  });
  const headers = signedRequestHeaders(SECRET(), "POST", path, body, {
    "content-type": "application/json",
    [PORTAL_IDENTITY_HEADER]: await mintPortalIdentity({ p: owner, exp: Date.now() + 60_000 }, SECRET()),
  });
  const res = await fetch(`${CORE()}${path}`, { method: "POST", headers, body, signal: AbortSignal.timeout(60_000) });
  assert.equal(res.status, 200, `publish failed: ${(await res.text()).slice(0, 300)}`);
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last error: ${String(last)})` : ""}`);
}

function actionsOf(m: SlackMessage): Array<{ action_id: string; value: string; block_id?: string }> {
  const block = (m.blocks ?? []).find((b) => b.type === "actions") as
    { block_id?: string; elements?: Array<{ action_id: string; value: string }> } | undefined;
  return (block?.elements ?? []).map((e) => ({ ...e, block_id: block?.block_id }));
}

async function click(env: Env, clicker: Actor, channel: string, card: SlackMessage, actionId: string): Promise<number> {
  const action = actionsOf(card).find((a) => a.action_id === actionId);
  assert.ok(action, `card has no ${actionId} button: ${JSON.stringify(card.blocks).slice(0, 300)}`);
  const body = JSON.stringify({
    type: "block_actions",
    team: { id: env.teamId, domain: "e2e" },
    user: { id: clicker.userId, username: clicker.handle, team_id: env.teamId },
    api_app_id: "AE2E",
    container: { type: "message", message_ts: card.ts, channel_id: channel, is_ephemeral: false },
    channel: { id: channel, name: "directmessage" },
    message: { type: "message", ts: card.ts, text: card.text, user: env.botUserId },
    actions: [{ ...action, type: "button", action_ts: `${Date.now() / 1000}` }],
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", process.env.SLACK_SIGNING_SECRET ?? "")
    .update(`v0:${ts}:${body}`)
    .digest("hex")}`;
  const res = await fetch(EVENTS_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": signature },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

async function waitReachable(slug: string, sub: string, marker: string, label: string): Promise<void> {
  await waitFor(
    `${label} to reach the app`,
    async () => {
      const res = await gateway(slug, sub);
      return res.status === 200 && res.body.includes(`hello from ${marker}`) ? res : undefined;
    },
    45_000,
  );
}

async function requestAccessAs(slug: string, requester: string): Promise<void> {
  const denied = await gateway(slug, requester);
  assert.equal(denied.status, 403, `stranger should be denied, got ${denied.status}: ${denied.body.slice(0, 200)}`);
  assert.match(denied.body, /Request access/);
  const asked = await gateway(slug, requester, true);
  assert.equal(asked.status, 200, `request-access failed: ${asked.body.slice(0, 200)}`);
}

export const deployAccessScenarios: Scenario[] = [true, false].map((approve) => ({
  name: approve ? "deploy-access-approve-button-grants-and-notifies" : "deploy-access-decline-button-tells-requester",
  lane: "parallel",
  tags: ["twin", "apps-gateway", "deploy-access"],
  actors: ["alice", "bob", "carol"],
  timeoutMs: 4 * 60_000,
  async run(ctx) {
    const env = ctx.env;
    const owner = env.actors.get(approve ? "alice" : "carol")!;
    const requester = env.actors.get("bob")!;
    const stranger = env.actors.get(approve ? "carol" : "alice")!;
    const [ownerId, requesterId] = await Promise.all([principalOf(env, owner), principalOf(env, requester)]);
    const marker = ctx.marker(approve ? "approve" : "decline");
    const slug = `access-${crypto.randomUUID().slice(0, 8)}`;
    await publishApp(ownerId, slug, marker);
    await waitReachable(slug, ownerId, marker, "the owner");
    const ownerDm = await owner.client.openDm(env.botUserId);
    const requesterDm = await requester.client.openDm(env.botUserId);
    const since = String(Date.now() / 1000 - 1);
    await requestAccessAs(slug, requesterId);
    const card = await waitFor("owner request card", async () =>
      (await owner.client.history(ownerDm, since)).find(
        (m) => m.user === env.botUserId && (m.text ?? "").includes(slug) && actionsOf(m).length === 2,
      ),
    );
    assert.ok(card.text?.includes(requesterId));
    const action = approve ? "deploy_access_approve" : "deploy_access_decline";
    assert.equal(await click(env, stranger, ownerDm, card, action), 200);
    await sleep(3000);
    assert.equal((await gateway(slug, requesterId)).status, 403, "a stranger's click must grant nothing");
    const unchanged = (await owner.client.history(ownerDm, since)).find((m) => m.ts === card.ts);
    assert.equal(actionsOf(unchanged!).length, 2, "a stranger cannot decide the card");
    assert.equal(await click(env, owner, ownerDm, card, action), 200);
    const settled = await waitFor("card to settle", async () => {
      const m = (await owner.client.history(ownerDm, since)).find((m) => m.ts === card.ts);
      return m && (m.text ?? "").startsWith(approve ? "Approved." : "Declined.") ? m : undefined;
    });
    assert.equal(actionsOf(settled).length, 0);
    const notice = await waitFor("requester notification", async () =>
      (await requester.client.history(requesterDm, since)).find(
        (m) =>
          m.user === env.botUserId &&
          (m.text ?? "").includes(slug) &&
          (m.text ?? "").includes(approve ? "gave you access" : "declined your request"),
      ),
    );
    if (approve) {
      assert.ok(notice.text?.includes(`https://${slug}.${APPS_DOMAIN()}/`));
      await waitReachable(slug, requesterId, marker, "the requester");
    } else assert.equal((await gateway(slug, requesterId)).status, 403, "decline grants nothing");
  },
}));
