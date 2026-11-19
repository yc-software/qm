import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createDocumentMemory, publishDocumentLearning } from "../src/documents/memory.ts";
import { disclosedMemory } from "../src/memory/disclosure.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { resolveTurnContext } from "../src/resolution/turn-context.ts";
import { DEFAULT_MEMORY_POLICY } from "../src/memory/policy.ts";
import { testTenant, testTenant as ancestryTenant } from "./support/test-tenant.ts";
import type { Conversation } from "../src/types.ts";

const surface = "https://sheets.example.test";

test("authorized document notebooks follow the team roster and automatic recall stays with the active document", async () => {
  const config = testConfig();
  const databaseUrl = config.databaseUrl;
  assert.ok(databaseUrl);
  const built = buildApp(config);
  try {
    const project = await built.projects.create({ name: "Operations", ownerId: "owner" });
    await built.projects.addMember(project.id, "owner", "member");
    await built.documentConversations.configure(surface, project.id);
    const resolve = async (documentId: string, principalId: string, mode: "shared" | "private" = "shared") => {
      const result = await built.documentConversations.resolve({ surface, documentId, principalId, mode });
      if (result.status !== "ok") throw new Error("missing conversation");
      const knowledge = await built.documentConversations.knowledgeForSession(
        result.conversation.sessionId,
        principalId,
      );
      assert.ok(knowledge);
      return { ...result.conversation, knowledge };
    };
    const a = await resolve("a", "owner");
    const b = await resolve("b", "member");
    const personal = await resolve("a", "member", "private");
    const raw = createPostgresMemoryService(databaseUrl);
    const memory = createDocumentMemory(raw, built.documentConversations, built.auditLog);
    const at = 100;
    const capture = {
      mode: "explicit" as const,
      conversationScopeId: a.scopeId,
      sessionId: a.sessionId,
      sensitivity: "ordinary" as const,
      inheritedFacts: [],
    };
    await memory.capture(
      testTenant,
      a.knowledge.teamScopeId,
      ["Team procedure"],
      at,
      { actorId: "owner", context: "conversation" },
      capture,
    );
    await memory.capture(
      testTenant,
      a.knowledge.documentScopeId,
      ["Document A assumption"],
      at,
      { actorId: "owner", context: "conversation" },
      capture,
    );
    const context = async (binding: typeof a, id: string) => {
      const actor = built.identity.classify(id);
      const conversation: Conversation = {
        kind: binding.mode === "private" ? "dm" : "group",
        threadRef: binding.threadRef,
        ...(binding.mode === "shared" ? { channelRef: binding.scopeId.slice(6) } : {}),
        audience: binding.mode === "private" ? [actor] : ((await built.app.currentScopeMembers(binding.scopeId)) ?? []),
      };
      const resolution = await createResolutionService(config.orgId, built.config, built.acl).resolve(
        testTenant,
        conversation,
        actor,
        false,
        false,
      );
      return resolveTurnContext({
        tenant: testTenant,
        actor,
        targetScope: binding.scopeId,
        document: (await built.documentConversations.knowledgeForSession(binding.sessionId, id))!,
        resolution,
        audience: conversation.audience,
        origin: { kind: "human" },
        trustedLiveHuman: true,
        config: built.config,
        sessions: built.sessions,
        isCurrentSharedScopeMember: built.app.isCurrentSharedScopeMember,
        currentScopeMembers: built.app.currentScopeMembers,
        acl: built.acl,
        memoryPolicy: DEFAULT_MEMORY_POLICY,
        useMemory: true,
        botActor: false,
        ownScopeBotWork: false,
        memory,
        files: built.files,
      });
    };
    assert.deepEqual(
      new Set((await (await context(a, "owner")).memorySnapshot()).facts.map((fact) => fact.text)),
      new Set(["Team procedure", "Document A assumption"]),
    );
    assert.deepEqual(
      (await (await context(b, "member")).memorySnapshot()).facts.map((fact) => fact.text),
      ["Team procedure"],
    );
    assert.deepEqual(
      new Set((await (await context(personal, "member")).memorySnapshot()).facts.map((fact) => fact.text)),
      new Set(["Team procedure", "Document A assumption"]),
    );
    const rosters = await built.managedGroups.membersMany([
      a.knowledge.documentScopeId.slice(6),
      b.knowledge.documentScopeId.slice(6),
      "document-missing",
    ]);
    assert.deepEqual(rosters.get("document-missing"), []);
    assert.deepEqual(new Set(rosters.get(a.knowledge.documentScopeId.slice(6))), new Set(["owner", "member"]));
    await assert.rejects(
      memory.capture(
        testTenant,
        a.knowledge.documentScopeId,
        ["Wrong document"],
        at,
        { actorId: "member", context: "conversation" },
        { ...capture, sessionId: b.sessionId },
      ),
    );
    await built.principalLinks.link({
      principalId: "member",
      canonicalId: "web-member",
      evidence: "test: verified linked account",
      linkedBy: "web-member",
    });
    assert.equal(await built.managedGroups.membership(a.knowledge.documentScopeId.slice(6), "web-member"), true);
    await built.projects.removeMember(project.id, "owner", "member");
    assert.equal(
      await built.app.authorizesCapabilityScope({ actorId: "member", scopeId: a.knowledge.documentScopeId }),
      false,
    );
    await assert.rejects(
      memory.capture(
        testTenant,
        b.knowledge.documentScopeId,
        ["Revoked write"],
        at,
        { actorId: "member", context: "conversation" },
        { ...capture, sessionId: b.sessionId },
      ),
    );
    assert.deepEqual((await (await context(personal, "member")).memorySnapshot()).facts, []);
  } finally {
    await built.runtime.stop();
  }
});

test("private capture restrictions survive storage, duplicate merges, edits, and derived facts even in open shared contexts", async () => {
  const config = testConfig();
  const databaseUrl = config.databaseUrl;
  assert.ok(databaseUrl);
  const built = buildApp(config);
  try {
    const project = await built.projects.create({ name: "Operations", ownerId: "owner" });
    await built.documentConversations.configure(surface, project.id);
    const binding = await built.documentConversations.resolve({
      surface,
      documentId: "a",
      principalId: "owner",
      mode: "private",
    });
    if (binding.status !== "ok") throw new Error("missing private binding");
    const raw = createPostgresMemoryService(databaseUrl);
    const memory = createDocumentMemory(raw, built.documentConversations, built.auditLog);
    const metadata = {
      mode: "automatic" as const,
      sessionId: binding.conversation.sessionId,
      conversationScopeId: "personal:owner",
      sensitivity: "ordinary" as const,
      inheritedFacts: [],
    };
    await memory.capture(
      testTenant,
      "personal:owner",
      ["Private convention"],
      100,
      { actorId: "owner", context: "conversation" },
      metadata,
    );
    await raw.capture(
      testTenant,
      "personal:owner",
      ["Private convention"],
      101,
      { actorId: "owner", context: "self" },
      { ...metadata, sessionId: undefined },
    );
    const child = await built.sessions.getOrCreateByThread("web:owner:private-child", "dm", "personal:owner");
    await built.sessions.setParentSession(ancestryTenant, child.id, binding.conversation.sessionId);
    await memory.capture(
      testTenant,
      "personal:owner",
      ["Private child convention"],
      101,
      { actorId: "owner", context: "conversation" },
      { ...metadata, sessionId: child.id },
    );
    assert.equal(
      (await raw.facts!("personal:owner")).find((fact) => fact.text === "Private child convention")?.personalOnly,
      true,
    );
    await assert.rejects(built.documentConversations.knowledgeForSession(child.id, "someone-else"));
    const fact = (await raw.facts!("personal:owner"))[0]!;
    assert.equal(fact.personalOnly, true);
    await raw.edit!(
      "personal:owner",
      [{ id: fact.id, text: "Updated private convention" }],
      { actorId: "owner", context: "self" },
      { inheritedFacts: [], sensitivity: "ordinary", conversationScopeId: "personal:owner" },
    );
    const stored = createPostgresMemoryService(databaseUrl);
    const updated = (await stored.facts!("personal:owner"))[0]!;
    assert.equal(updated.personalOnly, true);
    await raw.capture(testTenant, "org:test", ["Derived private convention"], 102, undefined, {
      mode: "explicit",
      inheritedFacts: [updated],
      sensitivity: "ordinary",
      conversationScopeId: "org:test",
    });
    assert.equal((await stored.facts!("org:test"))[0]?.personalOnly, true);
    const actor = built.identity.classify("owner");
    const access = {
      actor,
      targetScope: "group:room",
      nativeScopes: ["org:test", "personal:owner", "group:room"],
      audience: [actor],
      open: true,
      config: built.config,
      isCurrentSharedScopeMember: async () => true,
      currentScopeMembers: async () => [actor],
    };
    await built.config.setSharingPosture(`org:${config.orgId}`, "open");
    const shared = disclosedMemory(stored, access);
    assert.deepEqual(await shared.facts!("personal:owner"), []);
    assert.deepEqual(await shared.facts!("org:test"), []);
    assert.equal(
      (await disclosedMemory(stored, { ...access, targetScope: "personal:owner" }).facts!("personal:owner"))[0]?.text,
      "Updated private convention",
    );
    await assert.rejects(
      memory.capture(
        testTenant,
        "org:test",
        ["Forbidden publication"],
        103,
        { actorId: "owner", context: "conversation" },
        metadata,
      ),
    );
  } finally {
    await built.runtime.stop();
  }
});

test("recorded document extraction routes a team procedure and workbook assumptions through the capture buffer", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createPerTurnStrategy } = await import("../src/memory/strategies/per-turn.ts");
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/document-memory-extraction.json", import.meta.url), "utf8"),
  ) as { response: string; turns: Array<{ input: string; reply: string }> };
  const config = testConfig();
  assert.ok(config.databaseUrl);
  const built = buildApp(config);
  try {
    const project = await built.projects.create({ name: "Operations", ownerId: "owner" });
    await built.documentConversations.configure(surface, project.id);
    const binding = await built.documentConversations.resolve({
      surface,
      documentId: "recorded",
      principalId: "owner",
    });
    if (binding.status !== "ok") throw new Error("missing binding");
    const document = await built.documentConversations.knowledgeForSession(binding.conversation.sessionId, "owner");
    assert.ok(document);
    const raw = createPostgresMemoryService(config.databaseUrl);
    const memory = createDocumentMemory(raw, built.documentConversations, built.auditLog);
    const strategy = createPerTurnStrategy({
      memory,
      agent: { oneShot: async () => fixture.response },
    });
    await strategy.onTurnEnd!(testTenant, {
      ...fixture.turns[0]!,
      scopeId: binding.conversation.scopeId,
      conversationScopeId: binding.conversation.scopeId,
      sessionId: binding.conversation.sessionId,
      actorId: "owner",
      inheritedFacts: [],
      document,
    });
    const teamFacts = await raw.facts!(document.teamScopeId);
    const documentFacts = await raw.facts!(document.documentScopeId);
    assert.match(teamFacts.map((fact) => fact.text).join("\n"), /reconcile every total/);
    assert.doesNotMatch(teamFacts.map((fact) => fact.text).join("\n"), /Assumptions/);
    assert.match(documentFacts.map((fact) => fact.text).join("\n"), /Assumptions/);
    assert.doesNotMatch(documentFacts.map((fact) => fact.text).join("\n"), /reconcile every total/);
    assert.doesNotMatch([...teamFacts, ...documentFacts].map((fact) => fact.text).join("\n"), /42|equal zero/);
  } finally {
    await built.runtime.stop();
  }
});

test("HTTP edits in a private document mark previously ordinary personal facts as personal-only", async () => {
  const { createServer } = await import("../src/api/server.ts");
  const { serverDeps } = await import("../src/wiring.ts");
  const { mintCapabilityToken } = await import("../src/auth/capability-token.ts");
  const secret = "document-private-edit-test-secret-long-enough";
  const config = testConfig({ signingSecret: secret });
  const built = buildApp(config);
  const server = createServer(built.app, serverDeps(config, built));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const project = await built.projects.create({ name: "Operations", ownerId: "owner" });
    await built.documentConversations.configure(surface, project.id);
    const binding = await built.documentConversations.resolve({
      surface,
      documentId: "private-edit",
      principalId: "owner",
      mode: "private",
    });
    if (binding.status !== "ok") throw new Error("missing private conversation");
    assert.ok(config.databaseUrl);
    const raw = createPostgresMemoryService(config.databaseUrl);
    await raw.capture(testTenant, "personal:owner", ["An ordinary convention"], 100, undefined, {
      mode: "explicit",
      inheritedFacts: [],
      sensitivity: "ordinary",
    });
    const original = (await raw.facts!("personal:owner"))[0]!;
    assert.equal(original.personalOnly, undefined);
    const token = await mintCapabilityToken(
      {
        actorId: "owner",
        scopeId: "personal:owner",
        sessionId: binding.conversation.sessionId,
        memory: { write: "personal:owner", read: ["personal:owner"] },
        exp: Date.now() + 60_000,
      },
      config.capabilitySecret!,
    );
    const port = (server.address() as import("node:net").AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/memory/facts`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-agent-capability": token },
      body: JSON.stringify({ facts: [{ id: original.id, text: "A private replacement convention" }] }),
    });
    assert.equal(response.status, 200);
    const edited = (await raw.facts!("personal:owner"))[0]!;
    assert.equal(edited.text, "A private replacement convention");
    assert.equal(edited.personalOnly, true);
    const actor = built.identity.classify("owner");
    const shared = disclosedMemory(raw, {
      actor,
      targetScope: "group:shared",
      nativeScopes: ["group:shared", "personal:owner"],
      audience: [actor],
      open: true,
      config: built.config,
      isCurrentSharedScopeMember: async () => true,
      currentScopeMembers: async () => [actor],
    });
    assert.deepEqual(await shared.facts!("personal:owner"), []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

test("selected private learning publishes only to its authorized document team and retains the private source", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 17) });
  const config = testConfig();
  assert.ok(config.databaseUrl);
  const built = buildApp(config);
  try {
    const project = await built.projects.create({ name: "Operations", ownerId: "owner" });
    await built.projects.addMember(project.id, "owner", "member");
    await built.documentConversations.configure(surface, project.id);
    const binding = await built.documentConversations.resolve({
      surface,
      documentId: "publication",
      principalId: "member",
      mode: "private",
    });
    assert.equal(binding.status, "ok");
    if (binding.status !== "ok") throw new Error("missing private conversation");
    const sessionId = binding.conversation.sessionId;
    const knowledge = await built.documentConversations.knowledgeForSession(sessionId, "member");
    assert.ok(knowledge);
    const raw = createPostgresMemoryService(config.databaseUrl);
    const memory = createDocumentMemory(raw, built.documentConversations, built.auditLog);
    await memory.capture(
      testTenant,
      "personal:member",
      ["Selected procedure", "Unrelated private preference"],
      Date.now(),
      { actorId: "member", context: "conversation" },
      {
        mode: "explicit",
        sessionId,
        inheritedFacts: [],
        conversationScopeId: "personal:member",
      },
    );
    const publish = async (actorId: string, applicability: "team" | "workbook", texts = ["Selected procedure"]) => {
      const facts = await raw.facts!("personal:member");
      return publishDocumentLearning(testTenant, built.documentConversations, memory, built.auditLog, {
        sessionId,
        actorId,
        applicability,
        facts: texts.map((text) => ({ id: facts.find((fact) => fact.text === text)?.id ?? "missing", text })),
        disclosure: {
          actor: built.identity.classify(actorId),
          nativeScopes: [`org:${config.orgId}`],
          config: built.config,
          currentScopeMembers: (scope) => built.app.currentScopeMembers(scope),
          isCurrentSharedScopeMember: (principal, scope) => built.app.isCurrentSharedScopeMember(principal, scope),
        },
      });
    };
    await assert.rejects(publish("owner", "team"), /owner does not match/);
    let opaqueWrites = 0;
    const routed = createRoutedMemoryService({
      providers: {
        notebook: memory,
        opaque: {
          recall: async () => [],
          query: async () => [],
          read: async () => "",
          capture: async () => {
            opaqueWrites++;
            return 1;
          },
        },
      },
      routes: [
        { provider: "notebook", scopes: ["personal"], capture: "automatic", manage: true },
        { provider: "opaque", scopes: [knowledge.teamScopeId], capture: "automatic", manage: true },
      ],
    });
    const selected = (await raw.facts!("personal:member")).find((fact) => fact.text === "Selected procedure")!;
    await assert.rejects(
      publishDocumentLearning(testTenant, built.documentConversations, routed, built.auditLog, {
        sessionId,
        actorId: "member",
        applicability: "team",
        facts: [{ id: selected.id, text: selected.text }],
        disclosure: {
          actor: built.identity.classify("member"),
          nativeScopes: [],
          currentScopeMembers: (scope) => built.app.currentScopeMembers(scope),
        },
      }),
      /no enabled notebook/,
    );
    assert.equal(opaqueWrites, 0);
    assert.equal((await publish("member", "team"))?.added, 1);
    assert.deepEqual(
      (await raw.facts!(knowledge.teamScopeId)).map((fact) => fact.text),
      ["Selected procedure"],
    );
    assert.ok(
      (await raw.facts!(knowledge.teamScopeId)).every(
        (fact) => !fact.personalOnly && fact.sources.every((source) => source === knowledge.teamScopeId),
      ),
    );
    assert.ok((await raw.facts!("personal:member")).every((fact) => fact.personalOnly));
    await memory.capture(
      testTenant,
      "personal:member",
      ["Workbook-only procedure"],
      Date.now(),
      { actorId: "member", context: "conversation" },
      {
        mode: "explicit",
        sessionId,
        inheritedFacts: [],
        conversationScopeId: "personal:member",
      },
    );
    assert.equal((await publish("member", "workbook", ["Workbook-only procedure"]))?.added, 1);
    assert.deepEqual(
      (await raw.facts!(knowledge.documentScopeId)).map((fact) => fact.text),
      ["Workbook-only procedure"],
    );
    await memory.capture(
      testTenant,
      "personal:member",
      ["Organization procedure"],
      Date.now(),
      { actorId: "member", context: "conversation" },
      {
        mode: "explicit",
        sessionId,
        conversationScopeId: "personal:member",
        inheritedFacts: [{ sources: [`org:${config.orgId}`], sensitivity: "ordinary", sourceUnknown: false }],
      },
    );
    assert.equal((await publish("member", "team", ["Organization procedure"]))?.added, 1);
    assert.ok(
      (await raw.facts!(knowledge.teamScopeId))
        .find((fact) => fact.text === "Organization procedure")
        ?.sources.includes(`org:${config.orgId}`),
    );
    const restrictedProject = await built.projects.create({ name: "Restricted", ownerId: "member" });
    await memory.capture(
      testTenant,
      "personal:member",
      ["Restricted project detail"],
      Date.now(),
      { actorId: "member", context: "conversation" },
      {
        mode: "explicit",
        sessionId,
        conversationScopeId: "personal:member",
        inheritedFacts: [
          { sources: [`group:web-project-${restrictedProject.id}`], sensitivity: "restricted", sourceUnknown: false },
        ],
      },
    );
    await built.config.setSharingPosture(`org:${config.orgId}`, "open");
    await assert.rejects(publish("member", "team", ["Restricted project detail"]), /source restrictions/);
    await built.projects.addMember(restrictedProject.id, "member", "owner");
    assert.equal((await publish("member", "team", ["Restricted project detail"]))?.added, 1);
    const restricted = (await raw.facts!(knowledge.teamScopeId)).find(
      (fact) => fact.text === "Restricted project detail",
    )!;
    assert.ok(restricted.sources.includes(`group:web-project-${restrictedProject.id}`));
    assert.equal(restricted.sensitivity, "restricted");
    const shared = disclosedMemory(raw, {
      actor: built.identity.classify("owner"),
      targetScope: knowledge.teamScopeId,
      nativeScopes: [knowledge.teamScopeId],
      audience: (await built.app.currentScopeMembers(knowledge.teamScopeId))!,
      open: true,
      config: built.config,
      currentScopeMembers: (scope) => built.app.currentScopeMembers(scope),
      isCurrentSharedScopeMember: (principal, scope) => built.app.isCurrentSharedScopeMember(principal, scope),
    });
    assert.ok((await shared.facts!(knowledge.teamScopeId)).some((fact) => fact.id === restricted.id));
    await built.projects.removeMember(restrictedProject.id, "member", "owner");
    assert.ok(!(await shared.facts!(knowledge.teamScopeId)).some((fact) => fact.id === restricted.id));
    await memory.capture(
      testTenant,
      "personal:member",
      ["Unverified origin"],
      Date.now(),
      { actorId: "member", context: "conversation" },
      { mode: "explicit", sessionId },
    );
    assert.equal((await publish("member", "team", ["Unverified origin"]))?.added, 1);
    assert.equal(
      (await raw.facts!(knowledge.teamScopeId)).find((fact) => fact.text === "Unverified origin")?.sourceUnknown,
      true,
    );
    const original = (await raw.facts!("personal:member")).find((fact) => fact.text === "Selected procedure")!;
    await raw.edit!("personal:member", [{ id: original.id, text: "Changed after proposal" }], {
      actorId: "member",
      context: "self",
    });
    await assert.rejects(
      publishDocumentLearning(testTenant, built.documentConversations, memory, built.auditLog, {
        sessionId,
        actorId: "member",
        applicability: "team",
        facts: [{ id: original.id, text: original.text }],
        disclosure: {
          actor: built.identity.classify("member"),
          nativeScopes: [`org:${config.orgId}`],
          currentScopeMembers: (scope) => built.app.currentScopeMembers(scope),
        },
      }),
      /changed after approval/,
    );
    await assert.rejects(publish("member", "team", ["Not in this notebook"]), /No fact/);
    await built.projects.removeMember(project.id, "owner", "member");
    assert.equal(await publish("member", "team", ["Revoked write"]), null);
    assert.deepEqual(
      new Set((await raw.facts!(knowledge.teamScopeId)).map((fact) => fact.text)),
      new Set(["Selected procedure", "Organization procedure", "Restricted project detail", "Unverified origin"]),
    );
  } finally {
    await built.runtime.stop();
  }
});

test("skipMemory prevents an approved private-learning publication from writing shared memory", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 17) });
  const config = testConfig();
  assert.ok(config.databaseUrl);
  const raw = createPostgresMemoryService(config.databaseUrl);
  const base = createMockAgent();
  let selected: { id: string; text: string }[] = [];
  const built = buildApp(config, {
    agent: {
      ...base,
      runTurn: async (input) => {
        await input.tools.memoryPublish?.(selected, "team");
        return base.runTurn(input);
      },
    },
  });
  try {
    const project = await built.projects.create({ name: "Operations", ownerId: "U1" });
    await built.documentConversations.configure(surface, project.id);
    const privateBinding = await built.documentConversations.resolve({
      surface,
      documentId: "memory-opt-out",
      principalId: "U1",
      mode: "private",
    });
    if (privateBinding.status !== "ok") throw new Error("missing private binding");
    await raw.capture(
      testTenant,
      "personal:U1",
      ["Selected private fact"],
      Date.now(),
      { actorId: "U1", context: "self" },
      {
        mode: "explicit",
        conversationScopeId: "personal:U1",
        inheritedFacts: [],
        personalOnly: true,
      },
    );
    selected = (await raw.facts!("personal:U1")).map(({ id, text }) => ({ id, text }));
    const result = await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: privateBinding.conversation.threadRef },
      text: "publication opt-out test",
      skipMemory: true,
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(await raw.facts!(`group:web-project-${project.id}`), []);
  } finally {
    await built.runtime.stop();
  }
});
