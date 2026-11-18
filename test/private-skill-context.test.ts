import { disclosedMemory } from "../src/memory/disclosure.ts";
import { recordReplyFiles } from "../src/core/orchestrator/settle.ts";
import { randomUUID } from "node:crypto";
import { FILE_ARTIFACT_MIGRATIONS } from "../src/files/postgres-file-artifact-store.ts";
import { fileArtifactId } from "../src/files/file-artifact-store.ts";
import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import pg from "pg";
import { SESSION_MIGRATIONS } from "../src/sessions/session-schema.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { createServer } from "../src/api/server.ts";
import { serverDeps } from "../src/wiring.ts";
import { mintCapabilityToken, verifyCapabilityToken, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";

const secret = "private-skill-context-test-secret-0123456789";

test("private document capability and skill privacy survive memory opt-out and an open admin context", async (t) => {
  const config = testConfig({ signingSecret: secret, capabilitySecret: secret, apiBaseUrl: "http://core.test" });
  let base = "";
  let token: string | undefined;
  let privateId = "";
  let copiedId = "";
  let privateFileId = "";
  let copies = 0;
  let sourceSessionId = "";
  let extractions = 0;
  const raw = createPostgresMemoryService(config.databaseUrl!);
  const fetchActual = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("http://core.test/")) {
      token = new Headers(init?.headers).get("x-agent-capability") ?? undefined;
      return fetchActual(input.replace("http://core.test", base), init);
    }
    return fetchActual(input, init);
  });
  const built = buildApp(config, {
    agent: {
      ...createMockAgent(),
      oneShot: async (_system, _prompt, purpose) => {
        if (purpose === "memory_capture")
          return (
            "SENSITIVITY: ordinary\n- " +
            (++extractions === 1 ? "Automatic late private memory" : "Automatic private procedure")
          );
        if (purpose === "memory_classification") return "ordinary";
        return undefined;
      },
      runTurn: async (input) => {
        await input.emit({ kind: "UserMessage", text: input.input });
        assert.ok(input.tools.selfApi);
        if (input.input.includes("Read late private memory")) {
          assert.equal((await built.sessions.get(input.session.id))?.personalOnly, undefined);
          await raw.capture(
            "personal:admin-alice",
            ["Late private memory"],
            Date.now(),
            { actorId: "admin-alice", context: "self" },
            {
              mode: "explicit",
              personalOnly: true,
              inheritedFacts: [{ sensitivity: "restricted", sources: ["group:restricted"], sourceUnknown: false }],
              sensitivity: "restricted",
            },
          );
          const recalled = await input.tools.selfApi("POST", "/v1/memory/search", {
            query: "Late private memory",
            scope: "personal:admin-alice",
          });
          assert.equal(recalled.status, 200);
          const body = JSON.stringify(recalled.body);
          assert.ok(body.includes("Late private memory"));
          assert.equal((await input.tools.memoryAdd(["Late native: Late private memory"]))?.added, 1);
          privateFileId = (
            await input.tools.createPlayground({ title: "Private procedure", html: "<p>Late private memory</p>" })
          ).artifactId;
          const saved = await input.tools.selfApi("POST", "/v1/skills", {
            name: "late-memory-copy",
            description: "derived",
            body,
          });
          assert.equal(saved.status, 201);
          copiedId = (saved.body as { skill: { id: string } }).skill.id;
          await input.emit({ kind: "AgentMessage", text: "Late private memory" });
          return { reply: "Late private memory", modelCalls: 0 };
        }
        if (input.input.includes("Read private file search")) {
          assert.equal((await built.sessions.get(input.session.id))?.personalOnly, undefined);
          const read = await input.tools.selfApi("POST", "/v1/search", { query: "Late private memory" });
          assert.equal(read.status, 200);
          const hits = (read.body as { hits: Array<{ id: string; backend: string; snippet: string }> }).hits;
          const file = hits.find((hit) => hit.id === privateFileId && hit.backend === "files");
          assert.ok(file);
          assert.ok(file.snippet.includes("Late private memory"));
          const saved = await input.tools.selfApi("POST", "/v1/skills", {
            name: "file-search-copy",
            description: "derived",
            body: file.snippet,
          });
          assert.equal(saved.status, 201);
          copiedId = (saved.body as { skill: { id: string } }).skill.id;
          await input.emit({ kind: "AgentMessage", text: "Saved file procedure" });
          return { reply: "Saved file procedure", modelCalls: 0 };
        }
        if (input.input.includes("Attach private file to personal reply")) {
          const attached = await input.tools.attach([{ file_id: privateFileId }]);
          assert.equal(attached.ok, true);
          await input.emit({ kind: "AgentMessage", text: "Attached private file" });
          return { reply: "Attached private file", modelCalls: 0 };
        }
        if (input.input.includes("Attach private file from shared context")) {
          const attached = await input.tools.attach([{ file_id: privateFileId }]);
          assert.equal(attached.ok, false);
          await input.emit({ kind: "AgentMessage", text: "Private file withheld" });
          return { reply: "Private file withheld", modelCalls: 0 };
        }
        if (input.input.includes("Read restricted admin memory")) {
          const read = await input.tools.selfApi("GET", "/v1/admin/memory?scope=group:restricted");
          assert.equal(read.status, 200);
          assert.ok(JSON.stringify(read.body).includes("Restricted source procedure"));
          const saved = await input.tools.selfApi("POST", "/v1/skills", {
            name: "restricted-admin-copy",
            description: "derived",
            body: JSON.stringify(read.body),
          });
          assert.equal(saved.status, 201);
          copiedId = (saved.body as { skill: { id: string } }).skill.id;
          await input.emit({ kind: "AgentMessage", text: "Saved restricted procedure" });
          return { reply: "Saved restricted procedure", modelCalls: 0 };
        }
        if (input.input.includes("Read private transcript")) {
          assert.equal((await built.sessions.get(input.session.id))?.personalOnly, undefined);
          let body: string;
          if (input.input.includes("HTTP")) {
            const read = await input.tools.selfApi("GET", "/v1/conversations/" + sourceSessionId);
            assert.equal(read.status, 200);
            body = JSON.stringify(read.body);
          } else {
            assert.ok(input.tools.sessionSyscalls);
            const read = await input.tools.sessionSyscalls.read({ target: sourceSessionId, peer: true });
            assert.ok(read.ok && read.mode === "transcript");
            body = read.rendered;
          }
          assert.ok(body.includes("Private procedure content"));
          const saved = await input.tools.selfApi("POST", "/v1/skills", {
            name: "transcript-procedure-" + ++copies,
            description: "derived",
            body,
          });
          assert.equal(saved.status, 201);
          copiedId = (saved.body as { skill: { id: string } }).skill.id;
          await input.emit({ kind: "AgentMessage", text: body });
          return { reply: body, modelCalls: 0 };
        }
        if (input.input.includes("Consume private source")) {
          const source = await input.tools.selfApi("GET", "/v1/skills/" + privateId);
          assert.equal(source.status, 200);
          const body = (source.body as { skill: { body: string } }).skill.body;
          assert.equal(body, "Private procedure content");
          assert.equal((await input.tools.memoryAdd(["Native: " + body]))?.added, 1);
          const written = await input.tools.selfApi("POST", "/v1/memory/facts", { facts: ["API: " + body] });
          assert.equal(written.status, 200);
          const admin = await input.tools.selfApi("POST", "/v1/admin/memory?scope=personal:admin-alice", {
            facts: ["Admin: " + body],
          });
          assert.equal(admin.status, 200, JSON.stringify(admin.body));
          const broad = await input.tools.selfApi("POST", "/v1/admin/memory?scope=org:default-org", {
            facts: ["Forbidden: " + body],
          });
          assert.equal(broad.status, 403);
          await input.emit({ kind: "AgentMessage", text: body });
          return { reply: body, modelCalls: 0 };
        }
        if (input.input.includes("Copy archived source")) {
          const remembered = input.history.find((item) => item.text === "Private procedure content")?.text;
          assert.ok(remembered);
          const saved = await input.tools.selfApi("POST", "/v1/skills", {
            name: "derived-procedure-" + ++copies,
            description: "derived",
            body: remembered,
          });
          assert.equal(saved.status, 201);
          copiedId = (saved.body as { skill: { id: string } }).skill.id;
          await input.emit({ kind: "AgentMessage", text: remembered });
          return { reply: remembered, modelCalls: 0 };
        }
        const saved = await input.tools.selfApi("POST", "/v1/skills", {
          name: "protected-procedure",
          description: "private procedure",
          body: "Private procedure content",
        });
        assert.equal(saved.status, 201);
        privateId = (saved.body as { skill: { id: string } }).skill.id;
        await input.emit({ kind: "AgentMessage", text: "Saved privately" });
        return { reply: "Saved privately", modelCalls: 0 };
      },
    },
  });
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const actorId = "admin-alice";
  const personal = "personal:admin-alice";
  await built.directory.replaceChannels(
    [{ channelId: "C1", name: "collaborators" }],
    [{ channelId: "C1", principalId: actorId }],
  );
  const project = await built.projects.create({ name: "Operations", ownerId: actorId });
  await built.documentConversations.configure("https://sheets.example.test", project.id);
  const binding = await built.documentConversations.resolve({
    surface: "https://sheets.example.test",
    documentId: "private-skills",
    principalId: actorId,
    mode: "private",
  });
  assert.equal(binding.status, "ok");
  if (binding.status !== "ok") throw new Error("Missing private conversation");
  const result = await built.app.turn({
    surface: "web",
    actor: { externalId: actorId },
    conversation: { kind: "dm", threadRef: binding.conversation.threadRef },
    text: "Save my private procedure",
    skipMemory: true,
  });
  assert.equal(result.status, "ok");
  assert.ok(token);
  const claims = await verifyCapabilityToken(token, secret);
  assert.equal(claims?.personalOnly, true);
  assert.equal(claims?.memory, undefined);
  const create = async (capability: string, name: string) => {
    const response = await fetch(`${base}/v1/skills`, {
      method: "POST",
      headers: { "x-agent-capability": capability, "content-type": "application/json" },
      body: JSON.stringify({ name, description: "procedure", body: "Procedure content" }),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { skill: { id: string } }).skill.id;
  };
  assert.equal((await built.skills.get(privateId))?.personalOnly, true);
  const own = await mintCapabilityToken(
    { actorId, scopeId: personal, liveActor: true, aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 },
    secret,
  );
  const ordinaryId = await create(own, "ordinary-procedure");
  await built.config.setSharingPosture("org:default-org", "open");
  const shared = await mintCapabilityToken(
    { actorId, scopeId: "channel:C1", liveActor: true, aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 },
    secret,
  );
  const detail = (id: string, capability: string) =>
    fetch(`${base}/v1/admin/skills/${id}?scope=org:default-org`, { headers: { "x-agent-capability": capability } });
  assert.equal((await detail(ordinaryId, shared)).status, 200);
  assert.equal((await detail(privateId, own)).status, 404);
  const protectedOwn = await mintCapabilityToken(
    {
      actorId,
      scopeId: personal,
      sessionId: binding.conversation.sessionId,
      personalOnly: true,
      liveActor: true,
      aud: CONTROL_PLANE_AUD,
      exp: Date.now() + 60_000,
    },
    secret,
  );
  assert.equal((await detail(privateId, protectedOwn)).status, 200);
  assert.equal((await detail(privateId, shared)).status, 404);
  for (const [path, method, body] of [
    ["/v1/sessions/" + binding.conversation.sessionId + "/items/0?viewer=" + actorId, "GET", undefined],
    [
      "/v1/sessions/" + binding.conversation.sessionId + "/share",
      "POST",
      { principalId: actorId, audience: "external" },
    ],
  ] as const) {
    const blocked = await fetch(base + path, {
      method,
      headers: { "x-agent-capability": shared, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as { message: string }).message, "capability token not valid for this route");
  }

  await built.directory.replaceGroups([{ groupId: "restricted", principalId: actorId }]);
  await built.skills.archive(privateId);
  const late = await built.app.turn({
    surface: "web",
    origin: { kind: "human" },
    actor: { externalId: actorId },
    conversation: { kind: "dm", threadRef: "web:admin-alice:late-memory" },
    text: "Read late private memory",
  });
  assert.equal(late.status, "ok");
  assert.equal((await verifyCapabilityToken(token!, secret))?.personalOnly, undefined);
  assert.equal((await built.skills.get(copiedId))?.personalOnly, true);
  built.runtime.start();
  const lateDeadline = Date.now() + 15_000;
  while (!(await raw.facts!(personal)).some((fact) => fact.text === "Automatic late private memory")) {
    assert.ok(Date.now() < lateDeadline);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const lateFacts = await raw.facts!(personal);
  assert.equal(lateFacts.length, 3);
  assert.ok(
    lateFacts.every(
      (fact) => fact.personalOnly && fact.sources.includes("group:restricted") && fact.sensitivity === "restricted",
    ),
  );
  await raw.delete!(
    personal,
    lateFacts.map((fact) => fact.id),
    { actorId, context: "self" },
  );
  const privateFile = await built.files.get(privateFileId);
  assert.equal(privateFile?.personalOnly, true);
  assert.equal(privateFile?.sourceProvenance?.sensitivity, "restricted");
  assert.ok(privateFile?.sourceProvenance?.sources.includes("group:restricted"));
  const readFile = (path: string, capability: string) =>
    fetch(base + path, { headers: { "x-agent-capability": capability } });
  assert.equal((await readFile("/v1/files/" + privateFileId + "/content", shared)).status, 404);
  assert.equal((await readFile("/v1/admin/files/read?id=" + privateFileId, shared)).status, 404);
  assert.equal((await readFile("/v1/files/" + privateFileId + "/content", protectedOwn)).status, 200);
  const shareFile = await fetch(base + "/v1/share", {
    method: "POST",
    headers: { "x-agent-capability": protectedOwn, "content-type": "application/json" },
    body: JSON.stringify({ type: "file", id: privateFileId, toScope: "org" }),
  });
  assert.equal(shareFile.status, 400);
  assert.equal(((await shareFile.json()) as { message: string }).message, "Private artifacts cannot change audience");
  await built.skills.archive(copiedId);
  await built.skills.review(privateId, actorId, []);
  await built.skills.publish(privateId);
  const normal = {
    surface: "web",
    origin: { kind: "human" as const },
    actor: { externalId: actorId },
    conversation: { kind: "dm" as const, threadRef: "web:admin-alice:derived" },
  };
  const consumed = await built.app.turn({ ...normal, text: "Consume private source" });
  assert.equal(consumed.status, "ok");
  assert.ok(consumed.sessionId);
  assert.equal((await built.sessions.get(consumed.sessionId))?.personalOnly, true);
  sourceSessionId = consumed.sessionId;
  assert.equal((await verifyCapabilityToken(token!, secret))?.personalOnly, true);
  const deadline = Date.now() + 15_000;
  while (!(await raw.facts!(personal)).some((fact) => fact.text === "Automatic private procedure")) {
    assert.ok(Date.now() < deadline, "automatic extraction completed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const derived = (await raw.facts!(personal)).filter((fact) =>
    /^(Native:|API:|Admin:|Automatic private)/.test(fact.text),
  );
  assert.equal(derived.length, 4);
  assert.ok(derived.every((fact) => fact.personalOnly));
  const sharedMemory = await fetch(`${base}/v1/admin/memory?scope=personal:admin-alice`, {
    headers: { "x-agent-capability": shared },
  });
  assert.equal(sharedMemory.status, 200);
  assert.deepEqual(((await sharedMemory.json()) as { facts: unknown[] }).facts, []);
  await built.skills.archive(privateId);
  assert.equal((await built.app.turn({ ...normal, text: "Copy archived source", skipMemory: true })).status, "ok");
  assert.equal((await built.skills.get(copiedId))?.personalOnly, true);
  await built.skills.archive(copiedId);
  const forked = await built.app.forkSession(consumed.sessionId, actorId);
  assert.ok(forked);
  assert.equal(forked.session.personalOnly, true);
  assert.equal(
    (
      await built.app.turn({
        ...normal,
        conversation: { kind: "dm", threadRef: forked.session.threadRef },
        text: "Copy archived source",
        skipMemory: true,
      })
    ).status,
    "ok",
  );
  assert.equal((await built.skills.get(copiedId))?.personalOnly, true);
  await built.skills.archive(copiedId);
  for (const path of ["native", "HTTP"]) {
    const read = await built.app.turn({
      ...normal,
      conversation: { kind: "dm", threadRef: "web:admin-alice:transcript-" + path },
      text: "Read private transcript " + path,
      skipMemory: true,
    });
    assert.equal(read.status, "ok");
    assert.equal((await verifyCapabilityToken(token!, secret))?.personalOnly, undefined);
    assert.equal((await built.skills.get(copiedId))?.personalOnly, true);
    await built.skills.archive(copiedId);
  }
  await raw.capture("group:restricted", ["Restricted source procedure"], Date.now(), undefined, {
    mode: "explicit",
    sensitivity: "restricted",
    inheritedFacts: [{ sensitivity: "restricted", sources: ["group:restricted"], sourceUnknown: false }],
  });
  const restrictedRead = await built.app.turn({
    ...normal,
    conversation: { kind: "dm", threadRef: "web:admin-alice:restricted-admin" },
    text: "Read restricted admin memory",
    skipMemory: true,
  });
  assert.equal(restrictedRead.status, "ok");
  const restrictedCopy = await built.skills.get(copiedId);
  assert.equal(restrictedCopy?.sourceProvenance?.sensitivity, "restricted");
  assert.ok(restrictedCopy?.sourceProvenance?.sources.includes("group:restricted"));
  const fileRead = await built.app.turn({
    ...normal,
    conversation: { kind: "dm", threadRef: "web:admin-alice:private-file-reader" },
    text: "Read private file search",
    skipMemory: true,
  });
  assert.equal(fileRead.status, "ok");
  assert.equal((await built.skills.get(copiedId))?.personalOnly, true);
  assert.equal((await built.skills.get(copiedId))?.sourceProvenance?.sensitivity, "restricted");
  await built.skills.archive(copiedId);
  const attached = await built.app.turn({
    ...normal,
    conversation: { kind: "dm", threadRef: "web:admin-alice:private-file-reply" },
    text: "Attach private file to personal reply",
    skipMemory: true,
  });
  assert.equal(attached.status, "ok");
  assert.ok(attached.sessionId);
  const attachedHistory = await built.app.getSessionForViewer(attached.sessionId, { actorId });
  const delivery = attachedHistory?.items.find(
    (item) => item.kind === "AgentMessage" && item.variant === "files_delivered",
  );
  assert.ok(delivery);
  assert.ok(JSON.stringify(delivery.body.files).includes(privateFileId));
  assert.ok(!JSON.stringify(delivery.body).includes("blobId"));
  await recordReplyFiles(
    built.sessions,
    { sessionId: attached.sessionId, turnId: delivery.turnId! },
    attached.attachments ?? [],
    attachedHistory!.items,
  );
  assert.equal(
    (await built.sessions.getItems(attached.sessionId)).filter((item) => item.variant === "files_delivered").length,
    1,
  );
  const attachDenied = await built.app.turn({
    ...normal,
    conversation: { kind: "channel", threadRef: "channel:C1", channelRef: "C1" },
    text: "Attach private file from shared context",
    skipMemory: true,
  });
  assert.equal(attachDenied.status, "ok");
  await assert.rejects(
    built.files.put({
      id: "forbidden-private-file",
      ownerScopeId: "org:default-org",
      createdBy: actorId,
      name: "private.txt",
      path: "private.txt",
      mimetype: "text/plain",
      data: Buffer.from("Private procedure"),
      direction: "out",
      contextSessionIds: [late.sessionId!],
    }),
    /Private files must remain/,
  );
  const child = await built.sessions.getOrCreateByThread("private-child", "dm", personal);
  await built.sessions.setParentSession(child.id, forked.session.id);
  assert.equal((await built.sessions.get(child.id))?.personalOnly, true);
  const sharedChild = await built.sessions.getOrCreateByThread("shared-child", "channel", "channel:C1");
  await assert.rejects(built.sessions.setParentSession(sharedChild.id, forked.session.id), /owner does not match/);
  const legacyFork = await built.sessions.getOrCreateByThread("legacy-private-fork", "dm", personal);
  await built.sessions.updateForkProvenance(legacyFork.id, {
    forkedFrom: { sessionId: binding.conversation.sessionId },
    forkBoundarySeq: 0,
  });
  const legacyChild = await built.sessions.getOrCreateByThread("legacy-private-child", "dm", personal);
  await built.sessions.setParentSession(legacyChild.id, legacyFork.id);
  const legacyIds = [binding.conversation.sessionId, legacyFork.id, legacyChild.id];
  const sql = new pg.Client({ connectionString: config.databaseUrl });
  await sql.connect();
  try {
    await sql.query("UPDATE sessions SET personal_only=false WHERE id=ANY($1::text[])", [legacyIds]);
    for (const statement of SESSION_MIGRATIONS.find(
      (migration) => migration.id === "sessions/store/0065-private-documents",
    )!.statements)
      await sql.query(statement);
  } finally {
    await sql.end();
  }
  assert.ok(
    (await built.sessions.getMany({ ids: legacyIds, threadRefs: [] })).every((session) => session.personalOnly),
  );
  assert.equal((await built.sessions.get(sharedChild.id))?.personalOnly, undefined);
  await assert.rejects(built.sessions.inheritContextFrom(child.id, "missing-source"), /no longer exists/);
  const legacyTurn = randomUUID();
  const createdId = fileArtifactId(legacyTurn + ":attach:0", "out", 0);
  const exportedId = "ordinary-reexport-" + randomUUID();
  for (const id of [createdId, exportedId])
    await built.files.put({
      id,
      ownerScopeId: personal,
      createdBy: actorId,
      name: id + ".txt",
      path: id + ".txt",
      mimetype: "text/plain",
      data: Buffer.from("Legacy file"),
      direction: "out",
      createdInScope: personal,
    });
  await built.sessions.appendMany({ sessionId: binding.conversation.sessionId }, [
    {
      kind: "ToolCall",
      tool: "attach",
      turnId: legacyTurn,
      callId: "legacy-created",
      body: { files: ["private.txt"] },
    },
    {
      kind: "ToolResult",
      tool: "attach",
      turnId: legacyTurn,
      callId: "legacy-created",
      body: { files: [{ artifactId: createdId }] },
    },
    {
      kind: "ToolCall",
      tool: "attach",
      turnId: legacyTurn,
      callId: "legacy-reexported",
      body: { files: [{ file_id: exportedId }] },
    },
    {
      kind: "ToolResult",
      tool: "attach",
      turnId: legacyTurn,
      callId: "legacy-reexported",
      body: { files: [{ artifactId: exportedId }] },
    },
  ]);
  const migration = new pg.Client({ connectionString: config.databaseUrl });
  await migration.connect();
  try {
    for (const statement of FILE_ARTIFACT_MIGRATIONS.find(
      (migration) => migration.id === "files/artifacts/0005-recorded-origin",
    )!.statements)
      await migration.query(statement);
  } finally {
    await migration.end();
  }
  assert.equal((await built.files.get(createdId))?.personalOnly, true);
  assert.equal((await built.files.get(createdId))?.sourceProvenance?.sensitivity, "restricted");
  assert.equal((await built.files.get(exportedId))?.personalOnly, undefined);
  assert.equal((await built.files.get(exportedId))?.sourceProvenance?.sourceUnknown, true);
  const teamScope = "channel:C1";
  await built.app.upsertDirectory([{ principalId: "bob", displayName: "Bob", type: "internal" }]);
  await built.directory.replaceChannels(
    [
      { channelId: "C1", name: "collaborators", isPrivate: true },
      { channelId: "C2", name: "editors", isPrivate: true },
    ],
    [
      { channelId: "C1", principalId: actorId },
      { channelId: "C1", principalId: "bob" },
      { channelId: "C2", principalId: actorId },
    ],
  );
  const writer = await built.sessions.getOrCreateByThread("shared-origin-writer", "channel", teamScope);
  const reader = await built.sessions.getOrCreateByThread("shared-origin-reader", "channel", teamScope);
  const cap = (actor: string, scope: string, sessionId: string) =>
    mintCapabilityToken(
      { actorId: actor, scopeId: scope, sessionId, liveActor: true, aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 },
      secret,
    );
  const writerToken = await cap(actorId, teamScope, writer.id);
  const readerToken = await cap("bob", teamScope, reader.id);
  const call = (path: string, capability: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { "x-agent-capability": capability, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const made = await call("/v1/skills", writerToken, "POST", {
    name: "shared-origin",
    description: "Shared procedure",
    body: "Use the shared reporting procedure.",
  });
  assert.equal(made.status, 201);
  const sharedSkill = ((await made.json()) as { skill: { id: string } }).skill;
  assert.ok((await built.skills.get(sharedSkill.id))?.sourceProvenance?.sources.includes(teamScope));
  await built.files.put({
    id: "shared-origin-file",
    ownerScopeId: personal,
    createdBy: actorId,
    name: "shared.txt",
    path: "shared.txt",
    mimetype: "text/plain",
    data: Buffer.from("Use the shared reporting procedure."),
    direction: "out",
    contextSessionIds: [writer.id],
    createdInScope: teamScope,
  });
  for (const [type, id] of [
    ["skill", sharedSkill.id],
    ["file", "shared-origin-file"],
  ])
    assert.equal(
      (await call("/v1/share", writerToken, "POST", { type, id, toScope: teamScope, notify: false })).status,
      200,
    );
  assert.equal((await call("/v1/skills/" + sharedSkill.id, readerToken)).status, 200);
  assert.equal((await call("/v1/files/shared-origin-file/content", readerToken)).status, 200);
  const origin = (await built.sessions.get(reader.id))?.sourceProvenance;
  assert.ok(origin?.sources.includes(teamScope));
  assert.ok(!origin?.sources.includes(personal));
  await built.memory.capture(
    teamScope,
    ["Use the shared reporting procedure."],
    Date.now(),
    { actorId: "bob", context: "conversation" },
    { mode: "explicit", conversationScopeId: teamScope, sessionId: reader.id },
  );
  const sharedView = disclosedMemory(built.memory, {
    actor: { id: "bob", type: "internal" },
    targetScope: teamScope,
    nativeScopes: [teamScope],
    audience: [
      { id: actorId, type: "internal" },
      { id: "bob", type: "internal" },
    ],
    open: false,
    currentScopeMembers: (scope) => built.app.currentScopeMembers(scope),
    isCurrentSharedScopeMember: (actor, scope) => built.app.isCurrentSharedScopeMember(actor, scope),
  });
  assert.ok((await sharedView.facts!(teamScope)).some((fact) => fact.text === "Use the shared reporting procedure."));
  const editing = await built.sessions.getOrCreateByThread("shared-origin-editor", "channel", "channel:C2");
  assert.equal(
    (
      await call("/v1/skills/" + sharedSkill.id, await cap(actorId, "channel:C2", editing.id), "PUT", {
        body: "Use the revised shared reporting procedure.",
      })
    ).status,
    200,
  );
  assert.ok((await built.skills.get(sharedSkill.id))?.sourceProvenance?.sources.includes("channel:C2"));
});
