import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createControlService } from "../src/api/control-service.ts";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "project-trigger-secret".repeat(3);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function signed(method: string, path: string, body = ""): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${path}\n${body}`),
  };
}

function claims(actorId: string): CapabilityClaims {
  return { actorId, scopeId: `personal:${actorId}`, exp: Date.now() + 60_000 };
}

async function token(actorId: string, scopeId: CapabilityClaims["scopeId"], scopeVersion?: string): Promise<string> {
  return await mintCapabilityToken(
    {
      actorId,
      scopeId,
      ...(scopeVersion ? { scopeVersion } : {}),
      aud: CONTROL_PLANE_AUD,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );
}

test("Project trigger access follows current membership while Slack-group owner access is unchanged", async (t) => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "project-trigger-auth-")) }));
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  await built.app.upsertGroups([{ groupId: "G-slack", principalId: "member" }]);
  await built.app.upsertChannels([{ channelId: "C-public", name: "public", isPrivate: false }], []);
  const project = await built.app.createProject("owner", "Launch");
  assert.ok(project);
  const initialVersion = await built.projects.version(project.scopeId.slice("group:".length));
  assert.ok(initialVersion);
  const staleOwnerToken = await token("owner", project.scopeId, initialVersion);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");

  const projectCron = await built.app.createCron({
    ownerScopeId: project.scopeId,
    owner: "member",
    createdBy: "member",
    action: "project secret",
    schedule: { everyMs: 60_000 },
    runAs: "scopeShared",
    members: [
      { id: "owner", type: "internal" },
      { id: "member", type: "internal" },
    ],
  });
  const slackScope = "group:G-slack" as const;
  const slackCron = await built.app.createCron({
    ownerScopeId: slackScope,
    owner: "member",
    createdBy: "member",
    action: "slack task",
    schedule: { everyMs: 60_000 },
  });
  const publicCron = await built.app.createCron({
    ownerScopeId: "channel:C-public",
    owner: "owner",
    createdBy: "owner",
    action: "public task",
    schedule: { everyMs: 60_000 },
  });
  const projectWebhook = await built.app.createWebhook({
    ownerScopeId: project.scopeId,
    owner: "member",
    createdBy: "member",
    action: "project hook",
    verification: { scheme: "github", secret: "project-hook-secret" },
  });
  const slackWebhook = await built.app.createWebhook({
    ownerScopeId: slackScope,
    owner: "member",
    createdBy: "member",
    action: "slack hook",
    verification: { scheme: "github", secret: "slack-hook-secret" },
  });

  const control = createControlService(built.app, built.scheduler);
  assert.ok((await control.listCrons(claims("owner"))).crons.some((cron) => cron.id === projectCron.id));
  assert.ok((await control.listWebhooks(claims("owner"))).some((webhook) => webhook.id === projectWebhook.id));

  const server = createServer(built.app, { signingSecret: SECRET, scheduler: built.scheduler });
  const base = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const currentVersion = await built.projects.version(project.scopeId.slice("group:".length));
  assert.ok(currentVersion);
  const projectToken = await token("member", project.scopeId, currentVersion);
  const slackToken = await token("member", slackScope);
  assert.equal((await fetch(`${base}/v1/soul`, { headers: { "x-agent-capability": staleOwnerToken } })).status, 403);
  assert.equal((await fetch(`${base}/v1/soul`, { headers: { "x-agent-capability": projectToken } })).status, 200);
  assert.equal(
    (
      await fetch(`${base}/v1/crons`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-capability": projectToken },
        body: JSON.stringify({ schedule: { everyMs: 60_000 }, action: "project token task" }),
      })
    ).status,
    200,
  );

  assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");

  await built.scheduler.runNow(projectCron.id);
  assert.equal(
    (await built.crons.get(projectCron.id))?.enabled,
    false,
    "a scopeShared Project cron disables when its owner leaves",
  );

  assert.equal((await fetch(`${base}/v1/soul`, { headers: { "x-agent-capability": projectToken } })).status, 403);
  assert.equal(
    (
      await fetch(`${base}/v1/crons`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-capability": projectToken },
        body: JSON.stringify({ schedule: { everyMs: 60_000 }, action: "revoked project token task" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(`${base}/v1/soul`, { headers: { "x-agent-capability": await token("member", `personal:member`) } }))
      .status,
    200,
  );
  assert.equal((await fetch(`${base}/v1/soul`, { headers: { "x-agent-capability": slackToken } })).status, 200);

  const listedCrons = await built.app.listCronsForViewer("member");
  assert.ok(!listedCrons.owned.some((cron) => cron.id === projectCron.id));
  assert.ok(!listedCrons.visible.some((cron) => cron.id === projectCron.id));
  assert.ok(listedCrons.owned.some((cron) => cron.id === slackCron.id));

  const controlledCrons = await control.listCrons(claims("member"));
  assert.ok(!controlledCrons.crons.some((cron) => cron.id === projectCron.id));
  assert.ok(!controlledCrons.visible.some((cron) => cron.id === projectCron.id));
  assert.ok(controlledCrons.crons.some((cron) => cron.id === slackCron.id));
  assert.equal((await control.getCron(projectCron.id, claims("member"))).ok, false);
  assert.equal((await control.patchCron(projectCron.id, { title: "hijack" }, claims("member"))).ok, false);
  assert.equal((await control.getCron(slackCron.id, claims("member"))).ok, true);

  const controlledWebhooks = await control.listWebhooks(claims("member"));
  assert.ok(!controlledWebhooks.some((webhook) => webhook.id === projectWebhook.id));
  assert.ok(controlledWebhooks.some((webhook) => webhook.id === slackWebhook.id));
  assert.equal((await control.disableWebhook(projectWebhook.id, claims("member"))).ok, false);

  const cronListPath = "/v1/crons?viewer=member";
  const cronList = await fetch(`${base}${cronListPath}`, { headers: signed("GET", cronListPath) });
  const cronBody = (await cronList.json()) as { crons: Array<{ id: string }>; visible: Array<{ id: string }> };
  assert.ok(![...cronBody.crons, ...cronBody.visible].some((cron) => cron.id === projectCron.id));
  assert.ok(cronBody.crons.some((cron) => cron.id === slackCron.id));

  for (const suffix of [
    `/v1/crons/${projectCron.id}?principalId=member`,
    `/v1/crons/${projectCron.id}/runs?principalId=member`,
  ]) {
    assert.equal((await fetch(`${base}${suffix}`, { headers: signed("GET", suffix) })).status, 404);
  }
  const projectPatchPath = `/v1/crons/${projectCron.id}?principalId=member`;
  const projectPatchBody = JSON.stringify({ title: "hijack" });
  assert.equal(
    (
      await fetch(`${base}${projectPatchPath}`, {
        method: "PATCH",
        headers: signed("PATCH", projectPatchPath, projectPatchBody),
        body: projectPatchBody,
      })
    ).status,
    404,
  );
  const slackGetPath = `/v1/crons/${slackCron.id}?principalId=member`;
  assert.equal((await fetch(`${base}${slackGetPath}`, { headers: signed("GET", slackGetPath) })).status, 200);
  const publicGetPath = `/v1/crons/${publicCron.id}?principalId=member`;
  assert.equal((await fetch(`${base}${publicGetPath}`, { headers: signed("GET", publicGetPath) })).status, 200);
  const publicRunsPath = `/v1/crons/${publicCron.id}/runs?principalId=member`;
  assert.equal((await fetch(`${base}${publicRunsPath}`, { headers: signed("GET", publicRunsPath) })).status, 404);

  const webhookListPath = "/v1/webhooks?viewer=member";
  const webhookList = await fetch(`${base}${webhookListPath}`, { headers: signed("GET", webhookListPath) });
  const webhookBody = (await webhookList.json()) as { webhooks: Array<{ id: string }> };
  assert.ok(!webhookBody.webhooks.some((webhook) => webhook.id === projectWebhook.id));
  assert.ok(webhookBody.webhooks.some((webhook) => webhook.id === slackWebhook.id));

  const projectDisablePath = `/v1/webhooks/${projectWebhook.id}/disable?principalId=member`;
  assert.equal(
    (
      await fetch(`${base}${projectDisablePath}`, {
        method: "POST",
        headers: signed("POST", projectDisablePath),
      })
    ).status,
    404,
  );
  const slackDisablePath = `/v1/webhooks/${slackWebhook.id}/disable?principalId=member`;
  assert.equal(
    (
      await fetch(`${base}${slackDisablePath}`, {
        method: "POST",
        headers: signed("POST", slackDisablePath),
      })
    ).status,
    200,
  );
});
