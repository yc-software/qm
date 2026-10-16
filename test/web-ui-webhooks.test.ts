import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "core-signing-secret".repeat(3);
const PUBLIC = "https://core.public.example";

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-wh-")) }));
const core = createServer(built.app, {
  signingSecret: SECRET,
  webhookReceiver: built.webhookReceiver,
  publicUrl: PUBLIC,
});
core.listen(0);
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler } = await import("../plugins/web-ui/server/index.ts");
const web = createHttpServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

function asUser(user: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: `webuiuser=${encodeURIComponent(user)}`,
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, SECRET),
      ...init.headers,
    },
  };
}

const incoming = (id: string) => `${PUBLIC}/v1/webhooks/incoming/${id}`;

test("create scopes the webhook to the user; list, disable, and re-enable are owner-gated", async () => {
  const createRes = await fetch(
    `${webBase}/api/webhooks`,
    asUser("alice", {
      method: "POST",
      body: JSON.stringify({ action: "triage issues", verification: { scheme: "github" } }),
    }),
  );
  assert.equal(createRes.status, 200);
  const created = (await createRes.json()) as {
    webhook: { id: string; owner: string; createdBy: string; ownerScopeId: string; verification: { secret?: string } };
    url: string;
  };
  assert.equal(created.webhook.owner, "alice");
  assert.equal(created.webhook.createdBy, "alice");
  assert.equal(created.webhook.ownerScopeId, "personal:alice");
  assert.equal(created.url, incoming(created.webhook.id));
  assert.match(created.webhook.verification.secret ?? "", /^[0-9a-f]{64}$/);

  const id = created.webhook.id;

  const aliceList = (await (await fetch(`${webBase}/api/webhooks`, asUser("alice"))).json()) as {
    webhooks: Array<{ id: string; url: string; enabled: boolean; verification: { secret?: string } }>;
  };
  assert.equal(aliceList.webhooks.length, 1);
  assert.equal(aliceList.webhooks[0]?.id, id);
  assert.equal(aliceList.webhooks[0]?.url, incoming(id));
  assert.equal(aliceList.webhooks[0]?.verification.secret, "***");

  const bobList = (await (await fetch(`${webBase}/api/webhooks`, asUser("bob"))).json()) as { webhooks: unknown[] };
  assert.equal(bobList.webhooks.length, 0);
  const bobDisable = await fetch(`${webBase}/api/webhooks/${id}/disable`, asUser("bob", { method: "POST" }));
  assert.equal(bobDisable.status, 404);

  const stillEnabled = (await (await fetch(`${webBase}/api/webhooks`, asUser("alice"))).json()) as {
    webhooks: Array<{ enabled: boolean }>;
  };
  assert.equal(stillEnabled.webhooks[0]?.enabled, true);

  const aliceDisable = await fetch(`${webBase}/api/webhooks/${id}/disable`, asUser("alice", { method: "POST" }));
  assert.equal(aliceDisable.status, 200);
  const afterDisable = (await (await fetch(`${webBase}/api/webhooks`, asUser("alice"))).json()) as {
    webhooks: Array<{ enabled: boolean }>;
  };
  assert.equal(afterDisable.webhooks[0]?.enabled, false);
  const aliceEnable = await fetch(`${webBase}/api/webhooks/${id}/enable`, asUser("alice", { method: "POST" }));
  assert.equal(aliceEnable.status, 200);
  const afterEnable = (await (await fetch(`${webBase}/api/webhooks`, asUser("alice"))).json()) as {
    webhooks: Array<{ enabled: boolean }>;
  };
  assert.equal(afterEnable.webhooks[0]?.enabled, true);
});

test("removed Project members cannot list or disable their former Project webhook", async () => {
  await built.app.upsertDirectory([
    { principalId: "project-owner", displayName: "Project Owner", type: "internal" },
    { principalId: "hook-owner", displayName: "Hook Owner", type: "internal" },
    { principalId: "project-teammate", displayName: "Project Teammate", type: "internal" },
  ]);
  const project = await built.app.createProject("project-owner", "Webhook access");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "project-owner", "hook-owner")).status, "ok");
  assert.equal((await built.app.addProjectMember(project.id, "project-owner", "project-teammate")).status, "ok");
  const webhook = await built.app.createWebhook({
    ownerScopeId: project.scopeId,
    owner: "hook-owner",
    createdBy: "hook-owner",
    action: "project hook",
    verification: { scheme: "github", secret: "project-secret" },
  });

  const before = (await (await fetch(`${webBase}/api/webhooks`, asUser("hook-owner"))).json()) as {
    webhooks: Array<{ id: string }>;
  };
  assert.ok(before.webhooks.some((candidate) => candidate.id === webhook.id));
  const teammateList = (await (await fetch(`${webBase}/api/webhooks`, asUser("project-teammate"))).json()) as {
    webhooks: Array<{ id: string }>;
  };
  assert.ok(teammateList.webhooks.some((candidate) => candidate.id === webhook.id));

  assert.equal((await built.app.removeProjectMember(project.id, "project-owner", "hook-owner")).status, "ok");
  const after = (await (await fetch(`${webBase}/api/webhooks`, asUser("hook-owner"))).json()) as {
    webhooks: Array<{ id: string }>;
  };
  assert.ok(!after.webhooks.some((candidate) => candidate.id === webhook.id));
  assert.equal(
    (await fetch(`${webBase}/api/webhooks/${webhook.id}/disable`, asUser("hook-owner", { method: "POST" }))).status,
    404,
  );
  assert.equal(
    (
      await fetch(
        `${webBase}/api/webhooks/${webhook.id}`,
        asUser("hook-owner", { method: "PATCH", body: JSON.stringify({ action: "removed owner edit" }) }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(
        `${webBase}/api/webhooks/${webhook.id}`,
        asUser("project-teammate", { method: "PATCH", body: JSON.stringify({ action: "current member edit" }) }),
      )
    ).status,
    200,
  );
  assert.equal((await built.app.listWebhooks()).find((candidate) => candidate.id === webhook.id)?.enabled, true);
  assert.equal(
    (await fetch(`${webBase}/api/webhooks/${webhook.id}/disable`, asUser("project-teammate", { method: "POST" })))
      .status,
    200,
  );
  assert.equal((await built.app.listWebhooks()).find((candidate) => candidate.id === webhook.id)?.enabled, false);
});

test("a provided secret is passed through verbatim (no auto-generation)", async () => {
  const createRes = await fetch(
    `${webBase}/api/webhooks`,
    asUser("carol", {
      method: "POST",
      body: JSON.stringify({ action: "notify", verification: { scheme: "hmac-sha256", secret: "my-own-secret" } }),
    }),
  );
  assert.equal(createRes.status, 200);
  const created = (await createRes.json()) as { webhook: { verification: { secret?: string } } };
  assert.equal(created.webhook.verification.secret, "my-own-secret");
});

test("webhook routes require a signed-in principal (401 without a cookie)", async () => {
  assert.equal((await fetch(`${webBase}/api/webhooks`)).status, 401);
  const create = await fetch(`${webBase}/api/webhooks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "x", verification: { scheme: "hmac-sha256" } }),
  });
  assert.equal(create.status, 401);
});

test("create requires an action (400)", async () => {
  const res = await fetch(
    `${webBase}/api/webhooks`,
    asUser("alice", { method: "POST", body: JSON.stringify({ verification: { scheme: "hmac-sha256" } }) }),
  );
  assert.equal(res.status, 400);
});

test("public web creation rejects unauthenticated verification and malformed filters or destinations", async () => {
  const none = await fetch(
    `${webBase}/api/webhooks`,
    asUser("alice", { method: "POST", body: JSON.stringify({ action: "unsafe", verification: { scheme: "none" } }) }),
  );
  assert.equal(none.status, 400);
  const nonStringScheme = await fetch(
    `${webBase}/api/webhooks`,
    asUser("alice", {
      method: "POST",
      body: JSON.stringify({ action: "x", verification: { scheme: null, secret: "my-github-secret" } }),
    }),
  );
  assert.equal(nonStringScheme.status, 400);
  assert.match(await nonStringScheme.text(), /verification requires a scheme/);
  const filters = await fetch(
    `${webBase}/api/webhooks`,
    asUser("alice", {
      method: "POST",
      body: JSON.stringify({
        action: "weakened",
        verification: { scheme: "github" },
        filters: [{ path: "action", in: [] }],
      }),
    }),
  );
  assert.equal(filters.status, 400);
  const destination = await fetch(
    `${webBase}/api/webhooks`,
    asUser("alice", {
      method: "POST",
      body: JSON.stringify({ action: "partial", verification: { scheme: "github" }, destination: { type: "slack" } }),
    }),
  );
  assert.equal(destination.status, 400);
});

test("webhook history is relayed with the authenticated viewer, not a query-string impersonation", async () => {
  const res = await fetch(
    `${webBase}/api/webhooks`,
    asUser("history-owner", {
      method: "POST",
      body: JSON.stringify({ action: "history test", verification: { scheme: "github" } }),
    }),
  );
  const { webhook } = (await res.json()) as { webhook: { id: string } };
  const path = `${webBase}/api/webhooks/${webhook.id}/runs`;
  const owner = await fetch(path, asUser("history-owner"));
  assert.equal(owner.status, 200);
  assert.deepEqual(await owner.json(), { runs: [], total: 0 });
  const stranger = await fetch(`${path}?viewer=history-owner`, asUser("stranger"));
  assert.equal(stranger.status, 404);
});

test("editing webhook instructions is owner-gated and preserves its URL and signing secret", async () => {
  const webhook = await built.app.createWebhook({
    ownerScopeId: "personal:editor",
    owner: "editor",
    createdBy: "editor",
    action: "original",
    verification: { scheme: "github", secret: "keep-this-secret" },
  });
  const path = `${webBase}/api/webhooks/${webhook.id}`;
  const patch = (user: string, body: unknown) =>
    fetch(path, asUser(user, { method: "PATCH", body: JSON.stringify(body) }));
  assert.equal((await patch("outsider", { action: "stolen" })).status, 404);
  for (const body of [
    { action: " " },
    { action: 123 },
    { action: "changed", owner: "outsider" },
    { action: "changed", verification: { secret: "replace" } },
  ])
    assert.equal((await patch("editor", body)).status, 400);
  const response = await patch("editor", { action: "updated task" });
  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    webhook: { id: string; action: string; url: string; verification: { secret: string } };
  };
  assert.equal(result.webhook.id, webhook.id);
  assert.equal(result.webhook.action, "updated task");
  assert.equal(result.webhook.url, incoming(webhook.id));
  assert.equal(result.webhook.verification.secret, "***");
  assert.equal((await built.app.getWebhook(webhook.id))?.verification.secret, "keep-this-secret");
  assert.equal((await fetch(path, { method: "PATCH", body: JSON.stringify({ action: "unsigned" }) })).status, 401);
});

test("shared webhook management supports titles, archives and deletion without widening access", async () => {
  const wh = await built.app.createWebhook({
    owner: "automation-owner",
    createdBy: "automation-owner",
    ownerScopeId: "personal:automation-owner",
    action: "Inspect event",
    verification: { scheme: "github", secret: "test-only" },
  });
  const path = `${webBase}/api/webhooks/${wh.id}`;
  for (const method of ["PATCH", "DELETE"]) {
    const res = await fetch(
      path,
      asUser("outsider", { method, ...(method === "PATCH" ? { body: JSON.stringify({ title: "Bad edit" }) } : {}) }),
    );
    assert.equal(res.status, 404);
  }
  assert.equal((await fetch(`${path}/runs`, asUser("outsider"))).status, 404);
  const edited = await fetch(
    path,
    asUser("automation-owner", {
      method: "PATCH",
      body: JSON.stringify({ title: "Issue triage", task: "Summarize each issue", archived: true }),
    }),
  );
  assert.equal(edited.status, 200);
  const saved = await built.app.getWebhook(wh.id);
  assert.equal(saved?.title, "Issue triage");
  assert.equal(saved?.action, "Summarize each issue");
  assert.equal(saved?.enabled, false);
  assert.equal(saved?.archived, true);
  assert.equal(saved?.verification.secret, "test-only");
  assert.equal((await fetch(`${path}/runs`, asUser("automation-owner"))).status, 200);
  assert.equal((await fetch(path, asUser("automation-owner", { method: "DELETE" }))).status, 200);
  assert.equal(await built.app.getWebhook(wh.id), null);
});
