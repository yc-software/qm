import { mintSignedPayload } from "../src/auth/signed-token.ts";
import "./support/auto-fake-sprites.ts";
import { refreshPrivateContext, type PrivateContext } from "../src/sessions/private-context.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createServer } from "../src/api/server.ts";
import { serverDeps } from "../src/wiring.ts";
import {
  mintCapabilityToken,
  mintComputerCapabilityToken,
  verifyCapabilityToken,
  CONTROL_PLANE_AUD,
  type CapabilityClaims,
} from "../src/auth/capability-token.ts";

const secret = "computer-privacy-test-signing-secret-0123456789";

test("ordinary computer credentials cannot read private managed data or gain access after a native private read", async (t) => {
  const config = testConfig({ signingSecret: secret, capabilitySecret: secret });
  const built = buildApp(config);
  const actor = "admin-alice",
    owner = `personal:${actor}`;
  await built.app.upsertDirectory([{ principalId: actor, displayName: "Alice", type: "internal" }]);
  const source = await built.sessions.getOrCreateByThread("private-computer-data", "dm", owner);
  await built.sessions.addParticipant(source.id, actor);
  await built.sessions.recordContextProvenance(source.id, owner, {
    sources: [owner],
    sensitivity: "ordinary",
    sourceUnknown: false,
    personalOnly: true,
  });
  await built.sessions.append({ sessionId: source.id }, { kind: "AgentMessage", text: "PrivateTranscriptCedar7301" });
  const { artifact } = await built.files.put({
    id: "private-computer-file",
    ownerScopeId: owner,
    createdBy: actor,
    name: "secret.txt",
    path: "secret.txt",
    mimetype: "text/plain",
    direction: "out",
    data: Buffer.from("PrivateFileCedar7301"),
    contextSessionIds: [source.id],
  });
  const skill = await built.skills.create({
    scopeId: owner,
    createdBy: actor,
    personalOnly: true,
    sourceProvenance: { sources: [owner], sensitivity: "ordinary", sourceUnknown: false },
    manifest: {
      name: "private-computer-procedure",
      description: "Private procedure",
      body: "PrivateSkillCedar7301",
      requiredCapabilities: [],
    },
  });
  await built.skills.review(skill.id, actor, []);
  await built.skills.publish(skill.id);
  await built.memory.capture(
    owner,
    ["PrivateMemoryCedar7301"],
    Date.now(),
    { actorId: actor, context: "self" },
    { mode: "explicit", personalOnly: true, sensitivity: "ordinary" },
  );
  const cron = await built.app.createCron({
    owner: actor,
    createdBy: actor,
    ownerScopeId: owner,
    schedule: { everyMs: 3_600_000 },
    action: "Ordinary task",
    destination: { type: "principal", target: actor, onBehalfOf: actor, audienceScopeId: owner },
  });
  await built.crons.recordFire(cron.id, {
    fireKey: "private-computer-history",
    threadRef: source.threadRef,
    sessionId: source.id,
    firedAt: Date.now(),
    reply: "PrivateScheduledHistoryCedar7301",
  });
  const session = await built.sessions.getOrCreateByThread("ordinary-computer-caller", "dm", owner);
  await built.sessions.addParticipant(session.id, actor);
  const claims: CapabilityClaims = {
    actorId: actor,
    scopeId: owner,
    sessionId: session.id,
    threadRef: session.threadRef,
    aud: CONTROL_PLANE_AUD,
    exp: Date.now() + 60_000,
    memory: { read: [owner], write: owner },
  };
  const ordinary = await mintComputerCapabilityToken(
    claims,
    { resourceId: "ordinary-computer", personalOnly: false },
    secret,
  );
  const native = await mintCapabilityToken(claims, secret);
  const privateToken = await mintComputerCapabilityToken(
    claims,
    { resourceId: "private-computer", personalOnly: true },
    secret,
  );
  assert.equal((await verifyCapabilityToken(native, secret))!.computer, undefined);
  assert.equal((await verifyCapabilityToken(ordinary, secret))!.computer!.personalOnly, false);
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, token: string, body?: unknown) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const { privateRead: _privateGrant, ...legacyClaims } = (await verifyCapabilityToken(native, secret))!;
  const legacy = await mintSignedPayload(legacyClaims, secret);
  assert.equal((await call("/v1/apis", legacy)).status, 200);
  const legacyPrivate = await call(`/v1/files/${artifact.id}/content`, legacy);
  assert.ok([403, 404].includes(legacyPrivate.status));
  assert.ok(!(await legacyPrivate.text()).includes("PrivateFileCedar7301"));
  for (const path of [
    `/v1/files/${artifact.id}/content`,
    `/v1/skills/${skill.id}`,
    `/v1/shares/skill/${skill.id}`,
    `/v1/conversations/${source.id}`,
    `/v1/crons/${cron.id}/runs`,
  ]) {
    const response = await call(path, ordinary);
    const text = await response.text();
    assert.ok([403, 404].includes(response.status), `${path}: ${response.status} ${text}`);
    assert.ok(!text.includes("Cedar7301"));
  }
  const mutation = await call(`/v1/conversations/${source.id}`, ordinary, { pinned: true });
  assert.ok([403, 404].includes(mutation.status), await mutation.clone().text());
  assert.ok(!(await mutation.text()).includes(source.threadRef));
  const memory = await call("/v1/memory/search", ordinary, { query: "PrivateMemoryCedar7301", scope: owner });
  assert.equal(memory.status, 200);
  assert.ok(!(await memory.text()).includes("PrivateMemoryCedar7301"));
  assert.notEqual((await built.sessions.get(session.id))!.personalOnly, true);
  const hostRead = await call(`/v1/files/${artifact.id}/content`, native);
  assert.equal(hostRead.status, 200);
  assert.equal(await hostRead.text(), "PrivateFileCedar7301");
  assert.equal((await built.sessions.get(session.id))!.personalOnly, true);
  const stale = await call(`/v1/files/${artifact.id}/content`, ordinary);
  assert.equal(stale.status, 403);
  assert.ok(!(await stale.text()).includes("PrivateFileCedar7301"));
  const privateRead = await call(`/v1/files/${artifact.id}/content`, privateToken);
  assert.equal(privateRead.status, 200);
  assert.equal(await privateRead.text(), "PrivateFileCedar7301");
  for (const path of [`/v1/skills/${skill.id}`, `/v1/conversations/${source.id}`, `/v1/crons/${cron.id}/runs`]) {
    const response = await call(path, privateToken);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes("Cedar7301"));
  }
  assert.equal((await call(`/v1/shares/skill/${skill.id}`, privateToken)).status, 200);
  const privateMemory = await call("/v1/memory/search", privateToken, {
    query: "PrivateMemoryCedar7301",
    scope: owner,
  });
  assert.equal(privateMemory.status, 200);
  assert.ok((await privateMemory.text()).includes("PrivateMemoryCedar7301"));
});

test("computer-management and outbound file APIs preserve the computer privacy boundary", async () => {
  const config = testConfig({ signingSecret: secret, capabilitySecret: secret });
  const built = buildApp(config);
  const actor = "admin-alice",
    owner = `personal:${actor}`;
  await built.app.upsertDirectory([{ principalId: actor, displayName: "Alice", type: "internal" }]);
  const privateSession = await built.sessions.getOrCreateByThread("private-vm-output", "dm", owner);
  await built.sessions.recordContextProvenance(privateSession.id, owner, {
    sources: [owner],
    sensitivity: "ordinary",
    sourceUnknown: false,
    personalOnly: true,
  });
  const context: PrivateContext = { privateRead: true, actorId: actor, scopeId: owner, sessionId: privateSession.id };
  const privateResources = built.sandboxResources.forTurn({
    actorId: actor,
    scopeId: owner,
    isCurrent: async () => false,
    privacy: { current: () => refreshPrivateContext(built.sessions, context), sessions: built.sessions },
  });
  const ordinaryComputer = await built.sandboxResources.create(actor, owner, "sprites", "ordinary-computer");
  await built.sandboxResources.setDefault(actor, owner, ordinaryComputer.id);
  await built.sandbox.teardown(await built.sandbox.provision(owner, { sandboxId: ordinaryComputer.id }), {
    keepWarm: true,
  });
  const computer = await privateResources.create(actor, owner, "sprites", "PrivateComputerNameCedar7301");
  await privateResources.setDefault(actor, owner, computer.id);
  const router = built.sandboxForTurn(privateResources);
  const handle = await router.provision(owner, { sandboxId: computer.id });
  await router.writeFile(handle, "output.txt", "PrivateComputerBytesCedar7301");
  await router.teardown(handle, { keepWarm: true });
  const session = await built.sessions.getOrCreateByThread("ordinary-vm-output-caller", "dm", owner);
  const queued = await built.runs.enqueue({
    sessionId: session.threadRef,
    request: {
      surface: "web",
      actor: { id: actor, type: "internal" },
      conversation: { kind: "dm", threadRef: session.threadRef, audience: [{ id: actor, type: "internal" }] },
      origin: { kind: "human" },
      text: "Computer API privacy verification",
    },
  });
  const run = await built.runs.claimById(queued.run.id, "computer-api-test", 60_000);
  assert.ok(run?.leaseToken);
  const claims: CapabilityClaims = {
    actorId: actor,
    scopeId: owner,
    sessionId: session.id,
    threadRef: session.threadRef,
    aud: CONTROL_PLANE_AUD,
    exp: Date.now() + 60_000,
    liveActor: true,
    privateScope: true,
    runId: run.id,
    runAttempt: run.attempts,
    runLeaseToken: run.leaseToken,
  };
  const ordinary = await mintComputerCapabilityToken(
    claims,
    { personalOnly: false, resourceId: ordinaryComputer.id },
    secret,
  );
  const privateToken = await mintComputerCapabilityToken(
    claims,
    { personalOnly: true, resourceId: computer.id },
    secret,
  );
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, token: string, body?: unknown) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const catalogPath = `/v1/admin/sandboxes/${encodeURIComponent(owner)}`;
    assert.equal((await call("/v1/admin/scopes", ordinary)).status, 403);
    const native = await mintCapabilityToken(claims, secret);
    assert.equal((await call("/v1/admin/scopes", native)).status, 200);
    const catalog = await call(catalogPath, ordinary);
    assert.equal(catalog.status, 200);
    const visible = await catalog.text();
    assert.ok(visible.includes(ordinaryComputer.id));
    assert.ok(!visible.includes("PrivateComputerNameCedar7301"));
    const denied = await call("/v1/reach", ordinary, {
      recipient: actor,
      text: "Private VM result",
      sandbox_id: computer.id,
      files: ["output.txt"],
    });
    assert.equal(denied.status, 403);
    assert.ok(!(await denied.text()).includes("PrivateComputerBytesCedar7301"));
    assert.notEqual((await built.sessions.get(session.id))!.personalOnly, true);
    const privateCatalog = await call(catalogPath, privateToken);
    assert.equal(privateCatalog.status, 200);
    assert.ok((await privateCatalog.text()).includes("PrivateComputerNameCedar7301"));
    const posted = await call("/v1/reach", privateToken, {
      recipient: actor,
      text: "Private VM result",
      sandbox_id: computer.id,
      files: ["output.txt"],
    });
    const postedText = await posted.text();
    assert.ok(posted.ok, `${posted.status}: ${postedText}`);
    const deliveries = await built.deliveries.pending("principal");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.destination.target, actor);
    const attachment = deliveries[0]!.attachments![0]!;
    assert.ok(attachment.artifactId);
    const saved = await built.files.get(attachment.artifactId);
    assert.equal(saved?.personalOnly, true);
    const opened = await built.files.open(attachment.artifactId);
    assert.ok(opened);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "PrivateComputerBytesCedar7301");
  } finally {
    try {
      await built.runs.complete(run.id, run.leaseToken!, { status: "ok" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
