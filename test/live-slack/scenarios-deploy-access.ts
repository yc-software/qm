import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { assert, type Actor, type Ctx, type Env, type Scenario } from "./harness.ts";
import { sleep, type SlackMessage } from "./slack.ts";
import { signedRequestHeaders } from "../../src/auth/source-auth-sign.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../../src/auth/capability-token.ts";
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

async function coreSigned(method: string, path: string, body: unknown, asPrincipal?: string): Promise<any> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const salted = `${path}${path.includes("?") ? "&" : "?"}_nonce=${crypto.randomUUID()}`;
  const base: Record<string, string> = { "content-type": "application/json" };
  if (asPrincipal)
    base[PORTAL_IDENTITY_HEADER] = await mintPortalIdentity({ p: asPrincipal, exp: Date.now() + 60_000 }, SECRET());
  const headers = signedRequestHeaders(SECRET(), method, salted, raw, base);
  const res = await fetch(`${CORE()}${salted}`, {
    method,
    headers,
    ...(raw ? { body: raw } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function capabilityFor(principal: string, liveActor: boolean): Promise<string> {
  return mintCapabilityToken(
    {
      actorId: principal,
      scopeId: `personal:${principal}`,
      aud: CONTROL_PLANE_AUD,
      exp: Date.now() + CAPABILITY_TTL_MS,
      liveActor,
    },
    SECRET(),
  );
}

async function coreAs(
  principal: string,
  liveActor: boolean,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${CORE()}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-agent-capability": await capabilityFor(principal, liveActor) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function portalSession(sub: string): string {
  const key = createHmac("sha256", SESSION_SECRET()).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + 3600 })).toString(
    "base64url",
  );
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function gateway(
  slug: string,
  method: string,
  path: string,
  sub: string | null,
  accept = "text/html",
): Promise<{ status: number; body: string }> {
  const core = new URL(CORE());
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: core.hostname,
        port: Number(core.port || 80),
        path,
        method,
        headers: {
          Host: `${slug}.${APPS_DOMAIN()}`,
          Accept: accept,
          ...(sub ? { Cookie: `portal_session=${portalSession(sub)}` } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function publishApp(owner: string, slug: string, marker: string): Promise<{ id: string; name: string }> {
  const { status, data } = await coreSigned(
    "POST",
    "/v1/deployments",
    {
      ownerScopeId: `personal:${owner}`,
      createdBy: owner,
      name: slug,
      entrypoint: "node server.mjs",
      files: [{ path: "server.mjs", data: APP_SOURCE(marker) }],
    },
    owner,
  );
  assert.equal(status, 200, `publish failed: ${JSON.stringify(data).slice(0, 300)}`);
  return { id: data.deployment.id, name: data.deployment.name };
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

async function botDm(env: Env, actor: Actor): Promise<string> {
  return actor.client.openDm(env.botUserId);
}

async function waitForBotDm(
  env: Env,
  actor: Actor,
  channel: string,
  match: RegExp,
  afterTs = "0",
  timeoutMs = 90_000,
): Promise<SlackMessage> {
  return waitFor(
    `bot DM to ${actor.name} matching ${match}`,
    async () => {
      const msgs = await actor.client.history(channel, afterTs);
      return msgs.find((m) => m.user === env.botUserId && match.test(m.text ?? ""));
    },
    timeoutMs,
  );
}

async function click(env: Env, clicker: Actor, channel: string, card: SlackMessage, actionId: string): Promise<number> {
  const action = actionsOf(card).find((a) => a.action_id === actionId);
  assert.ok(action, `card has no ${actionId} button: ${JSON.stringify(card.blocks).slice(0, 300)}`);
  const body = JSON.stringify({
    type: "block_actions",
    team: { id: env.teamId, domain: "e2e" },
    user: { id: clicker.userId, username: clicker.handle, team_id: env.teamId },
    api_app_id: "AE2E",
    token: "e2e",
    container: { type: "message", message_ts: card.ts, channel_id: channel, is_ephemeral: false },
    trigger_id: `${Date.now()}.e2e`,
    channel: { id: channel, name: "directmessage" },
    message: { type: "message", ts: card.ts, text: card.text, user: env.botUserId },
    response_url: "https://hooks.slack.invalid/e2e",
    actions: [
      {
        type: "button",
        action_id: actionId,
        block_id: action!.block_id ?? "",
        value: action!.value,
        action_ts: `${Date.now() / 1000}`,
      },
    ],
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

interface Cast {
  owner: Actor;
  requester: Actor;
  stranger: Actor;
  ownerId: string;
  requesterId: string;
  strangerId: string;
}

async function cast(ctx: Ctx, roles: { owner: string; requester: string; stranger: string }): Promise<Cast> {
  const env = ctx.env;
  const owner = env.actors.get(roles.owner)!;
  const requester = env.actors.get(roles.requester)!;
  const stranger = env.actors.get(roles.stranger)!;
  const [ownerId, requesterId, strangerId] = await Promise.all([
    principalOf(env, owner),
    principalOf(env, requester),
    principalOf(env, stranger),
  ]);
  return { owner, requester, stranger, ownerId, requesterId, strangerId };
}

async function cardStaysPending(
  actor: Actor,
  channel: string,
  cardTs: string,
  since: string,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  let pendingReads = 0;
  while (Date.now() < deadline) {
    const m = (await actor.client.history(channel, since)).find((x) => x.ts === cardTs);
    assert.ok(!/Approved\.|Declined\./.test(m?.text ?? ""), `card was decided by a stranger: ${m?.text}`);
    if (m && actionsOf(m).length === 2) pendingReads++;
    await sleep(2000);
  }
  assert.ok(pendingReads > 0, "card never read back as pending with both buttons");
}

function slugFor(marker: string): string {
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${marker
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 30)
    .replace(/-+$/, "")}-${suffix}`;
}

async function waitReachable(slug: string, sub: string, marker: string, label: string): Promise<void> {
  const r = await waitFor(
    `${label} to reach the app`,
    async () => {
      const res = await gateway(slug, "GET", "/", sub);
      return res.status === 200 && res.body.includes(`hello from ${marker}`) ? res : undefined;
    },
    45_000,
  );
  assert.equal(r.status, 200);
}

function requireGatewayEnv(): void {
  assert.ok(
    APPS_DOMAIN() && SESSION_SECRET() && SECRET(),
    "DEPLOY_APPS_DOMAIN, DEPLOY_APPS_SESSION_SECRET and CORE_SIGNING_SECRET are required",
  );
}

async function requestAccessAs(slug: string, requester: string): Promise<void> {
  const denied = await gateway(slug, "GET", "/", requester);
  assert.equal(denied.status, 403, `stranger should be denied, got ${denied.status}: ${denied.body.slice(0, 200)}`);
  assert.match(denied.body, /Request access/);
  const asked = await gateway(slug, "POST", "/__claw__/request-access", requester, "application/json");
  assert.equal(asked.status, 200, `request-access failed: ${asked.body.slice(0, 200)}`);
}

export const deployAccessScenarios: Scenario[] = [
  {
    name: "deploy-access-approve-button-grants-and-notifies",
    lane: "parallel",
    tags: ["twin", "apps-gateway", "deploy-access"],
    actors: ["alice", "bob", "carol"],
    timeoutMs: 6 * 60_000,
    async run(ctx) {
      requireGatewayEnv();
      const env = ctx.env;
      const {
        owner: alice,
        requester: bob,
        stranger: carol,
        ownerId: aliceId,
        requesterId: bobId,
      } = await cast(ctx, {
        owner: "alice",
        requester: "bob",
        stranger: "carol",
      });
      const marker = ctx.marker("approve");
      const slug = slugFor(marker);
      const app = await publishApp(aliceId, slug, marker);
      await waitReachable(slug, aliceId, marker, "the owner");

      const aliceDm = await botDm(env, alice);
      const bobDm = await botDm(env, bob);
      const since = String(Date.now() / 1000 - 1);
      await requestAccessAs(slug, bobId);

      const card = await waitForBotDm(env, alice, aliceDm, /is asking for access to your app/, since);
      assert.match(card.text ?? "", new RegExp(bobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.deepEqual(
        actionsOf(card).map((a) => a.action_id),
        ["deploy_access_approve", "deploy_access_decline"],
        "card offers Approve/Decline",
      );
      const pending = await coreAs(aliceId, true, "GET", "/v1/deployment-access-requests");
      assert.equal(pending.status, 200);
      assert.equal(
        pending.data.requests.length >= 1 &&
          pending.data.requests.some((r: { deploymentId: string }) => r.deploymentId === app.id),
        true,
        "owner's API view lists the pending request",
      );

      assert.equal(await click(env, carol, aliceDm, card, "deploy_access_approve"), 200);
      await cardStaysPending(alice, aliceDm, card.ts, since);
      assert.equal((await gateway(slug, "GET", "/", bobId)).status, 403, "a stranger's click must not grant access");

      assert.equal(await click(env, alice, aliceDm, card, "deploy_access_approve"), 200);
      const settled = await waitFor("card to settle", async () => {
        const msgs = await alice.client.history(aliceDm, since);
        const m = msgs.find((x) => x.ts === card.ts);
        return m && /Approved\./.test(m.text ?? "") ? m : undefined;
      });
      assert.equal(actionsOf(settled).length, 0, "buttons are gone once decided");
      const notice = await waitForBotDm(env, bob, bobDm, /gave you access to the app/, since);
      assert.match(
        notice.text ?? "",
        new RegExp(`${slug}\\.${APPS_DOMAIN().replace(/\./g, "\\.")}`),
        "grantee notice carries the app link",
      );
      await waitReachable(slug, bobId, marker, "bob");
      const after = await coreAs(aliceId, true, "GET", "/v1/deployment-access-requests");
      assert.equal(
        after.data.requests.some((r: { deploymentId: string }) => r.deploymentId === app.id),
        false,
        "request no longer pending",
      );
    },
  },
  {
    name: "deploy-access-decline-button-tells-requester",
    lane: "parallel",
    tags: ["twin", "apps-gateway", "deploy-access"],
    actors: ["alice", "bob", "carol"],
    timeoutMs: 6 * 60_000,
    async run(ctx) {
      requireGatewayEnv();
      const env = ctx.env;
      const {
        owner: alice,
        requester: bob,
        ownerId: aliceId,
        requesterId: bobId,
        strangerId: carolId,
      } = await cast(ctx, { owner: "carol", requester: "alice", stranger: "bob" });
      const marker = ctx.marker("decline");
      const slug = slugFor(marker);
      await publishApp(aliceId, slug, marker);
      await waitReachable(slug, aliceId, marker, "the owner");
      const aliceDm = await botDm(env, alice);
      const bobDm = await botDm(env, bob);
      const since = String(Date.now() / 1000 - 1);
      await requestAccessAs(slug, bobId);
      const card = await waitForBotDm(env, alice, aliceDm, /is asking for access to your app/, since);
      const requestId = actionsOf(card)[0]!.value;

      const byRequester = await coreAs(bobId, true, "POST", `/v1/deployment-access-requests/${requestId}/decide`, {
        decision: "approve",
      });
      assert.equal(byRequester.status, 403, "the requester cannot approve themself");
      const byStranger = await coreAs(carolId, true, "POST", `/v1/deployment-access-requests/${requestId}/decide`, {
        decision: "approve",
      });
      assert.equal(byStranger.status, 403, "a stranger cannot approve");
      const background = await coreAs(aliceId, false, "POST", `/v1/deployment-access-requests/${requestId}/decide`, {
        decision: "approve",
      });
      assert.equal(background.status, 403, "a non-live turn cannot approve");
      assert.equal((await gateway(slug, "GET", "/", bobId)).status, 403);

      assert.equal(await click(env, alice, aliceDm, card, "deploy_access_decline"), 200);
      const settled = await waitFor("card to settle", async () => {
        const msgs = await alice.client.history(aliceDm, since);
        const m = msgs.find((x) => x.ts === card.ts);
        return m && /Declined\./.test(m.text ?? "") ? m : undefined;
      });
      assert.equal(actionsOf(settled).length, 0);
      await waitForBotDm(env, bob, bobDm, /declined your request for access/, since);
      assert.equal((await gateway(slug, "GET", "/", bobId)).status, 403, "declining grants nothing");
    },
  },
  {
    name: "deploy-access-manual-share-resolves-request-and-notifies",
    lane: "parallel",
    tags: ["twin", "apps-gateway", "deploy-access"],
    actors: ["alice", "bob", "carol"],
    timeoutMs: 6 * 60_000,
    async run(ctx) {
      requireGatewayEnv();
      const env = ctx.env;
      const {
        owner: alice,
        requester: bob,
        stranger: carol,
        ownerId: aliceId,
        requesterId: bobId,
        strangerId: carolId,
      } = await cast(ctx, { owner: "bob", requester: "carol", stranger: "alice" });
      const marker = ctx.marker("share");
      const slug = slugFor(marker);
      const app = await publishApp(aliceId, slug, marker);
      await waitReachable(slug, aliceId, marker, "the owner");
      const aliceDm = await botDm(env, alice);
      const bobDm = await botDm(env, bob);
      const carolDm = await botDm(env, carol);
      const since = String(Date.now() / 1000 - 1);
      await requestAccessAs(slug, bobId);
      const card = await waitForBotDm(env, alice, aliceDm, /is asking for access to your app/, since);

      const shared = await coreAs(aliceId, true, "POST", `/v1/deployments/${app.id}/share`, {
        scope: `personal:${bobId}`,
        access: "view",
      });
      assert.equal(shared.status, 200, `share failed: ${JSON.stringify(shared.data).slice(0, 200)}`);
      const notice = await waitForBotDm(env, bob, bobDm, /gave you access to the app/, since);
      assert.match(notice.text ?? "", new RegExp(slug));
      await waitReachable(slug, bobId, marker, "bob (after the manual share)");
      const pending = await coreAs(aliceId, true, "GET", "/v1/deployment-access-requests");
      assert.equal(
        pending.data.requests.some((r: { deploymentId: string }) => r.deploymentId === app.id),
        false,
        "the pending request was resolved by the manual share",
      );
      assert.equal(await click(env, alice, aliceDm, card, "deploy_access_approve"), 200);
      const settled = await waitFor("stale card to settle as approved", async () => {
        const msgs = await alice.client.history(aliceDm, since);
        const m = msgs.find((x) => x.ts === card.ts);
        return m && /Approved\./.test(m.text ?? "") ? m : undefined;
      });
      assert.equal(actionsOf(settled).length, 0);
      const bobNotices = (await bob.client.history(bobDm, since)).filter(
        (m) => m.user === env.botUserId && /gave you access/.test(m.text ?? ""),
      );
      assert.equal(bobNotices.length, 1, "a late Approve click does not re-notify the grantee");

      const unprompted = await coreAs(aliceId, true, "POST", `/v1/deployments/${app.id}/share`, {
        scope: `personal:${carolId}`,
        access: "manage",
      });
      assert.equal(unprompted.status, 200);
      const carolNotice = await waitForBotDm(env, carol, carolDm, /gave you access to the app/, since);
      assert.match(carolNotice.text ?? "", /you can also manage it/);
      await waitReachable(slug, carolId, marker, "carol");
    },
  },
];
