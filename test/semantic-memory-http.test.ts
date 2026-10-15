import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { createPostgresVectorStore } from "../src/memory/postgres-vector-store.ts";
import { createMemoryEmbedder } from "../src/model/embeddings.ts";
import { factHash } from "../src/memory/facts.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import assert from "node:assert/strict";
import { createServer as httpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";

const fact = "Prefers validating changes with before-and-after browser tests.";
const filler = Array.from(
  { length: 120 },
  (_, i) => `Release ${i} tracks warehouse inventory and supplier shipment records.`,
);
const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
};

const database = process.env.DATABASE_URL;
const pgTest = database ? test : test.skip;
async function isolatedDatabase(t: TestContext) {
  const admin = new pg.Client({ connectionString: database! });
  await admin.connect();
  const name = `memory_http_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const fixture = { url: "", stop: async () => {} };
  t.after(async () => {
    await fixture.stop();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  const url = new URL(database!);
  url.pathname = `/${name}`;
  fixture.url = url.toString();
  return fixture;
}

async function seedVectors(
  memory: MemoryService,
  databaseUrl: string,
  model: string,
  baseUrl: string,
  scopes: string[],
) {
  const index = createPostgresVectorStore(databaseUrl);
  const embedder = createMemoryEmbedder(
    { kind: "embedding", id: model, name: model, provider: "openai", baseUrl },
    "test-key",
  );
  try {
    for (const scope of scopes) {
      const facts = await memory.facts!(scope);
      const vectors = await embedder.embed(
        facts.map((fact) => fact.text),
        AbortSignal.timeout(5000),
      );
      await index.put(
        facts.map((fact, i) => ({
          scope,
          model: embedder.id,
          factId: fact.id,
          hash: factHash(fact.text),
          vector: vectors[i]!,
        })),
      );
    }
  } finally {
    await index.close();
  }
}

pgTest("HTTP turn injects semantic matches; grep remains independent and authorized", async (t) => {
  const databaseFixture = await isolatedDatabase(t);
  const databaseUrl = databaseFixture.url;
  const inputs: string[][] = [];
  const provider = httpServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { input } = JSON.parse(body) as { input: string[] };
    inputs.push(input);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: input.map((text, index) => ({ index, embedding: /browser|verify|portal/i.test(text) ? [1, 0] : [0, 1] })),
      }),
    );
  });
  const providerUrl = await listen(provider);
  t.after(() => close(provider));
  const built = buildApp(
    testConfig({
      memoryStrategy: "agent-only",
      databaseUrl,
      providerBaseUrls: { openai: providerUrl },
      openaiApiKey: "test-key",
    }),
  );
  databaseFixture.stop = () => built.runtime.stop();
  await migrateRegisteredPgSchemas(databaseUrl);
  await built.memory.capture("personal:unconfigured", ["a fact before model configuration"], Date.now());
  await built.memory.recall("personal:unconfigured", { query: "no model configured" });
  const inspector = new pg.Client({ connectionString: databaseUrl });
  await inspector.connect();
  try {
    const { rows } = await inspector.query(
      "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed, to_regclass('memory_fact_vectors') AS vectors",
    );
    assert.equal(rows[0].installed, false);
    assert.equal(rows[0].vectors, null);
  } finally {
    await inspector.end();
  }
  const embeddingId = "test-model";
  await built.modelRegistry.upsert(
    { kind: "embedding", id: embeddingId, name: "Embeddings", provider: "openai" },
    "admin",
  );
  await built.config.setEmbeddingModel(embeddingId);
  const orgFact = "Browser regression tests should also cover Firefox.";
  await built.memory.capture("org:default-org", [orgFact], Date.now());
  const otherFact = "Another user's confidential browser preference";
  await built.memory.capture("personal:U1", [fact, ...filler], Date.now());
  await built.memory.capture("personal:U2", [otherFact], Date.now());
  await seedVectors(built.memory, databaseUrl, embeddingId, providerUrl, ["org:default-org", "personal:U1"]);
  const server = createInsecureTestServer(built.app, {
    memory: built.memory,
    capabilitySecret: TEST_CAPABILITY_SECRET,
  });
  const base = await listen(server);
  t.after(() => close(server));
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const request = {
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "semantic-http" },
    text: "!sysprompt\nhow should I verify a UI change?",
  };
  const seeded = await built.sessions.getOrCreateByThread("semantic-http", "dm", "personal:U1");
  const { lease } = await built.sessions.acquireLease(seeded.id);
  assert.ok(lease);
  await built.sessions.append(lease, {
    type: "user",
    scopeLabel: "personal:U2",
    payload: { text: "FOREIGN_HISTORY_SENTINEL" },
  });
  await built.sessions.append(lease, {
    type: "user",
    scopeLabel: "personal:U1",
    payload: { text: "TAINTED_HISTORY_SENTINEL", securityTainted: true },
  });
  await built.sessions.releaseLease(lease);
  const response = await post("/v1/turns", request);
  const result = (await response.json()) as { status: string; reply: string };
  assert.equal(response.status, 200);
  assert.equal(result.status, "ok");
  assert.match(result.reply, /What you remember/);
  assert.ok(result.reply.includes(fact));
  assert.ok(result.reply.includes(orgFact));
  assert.ok(!result.reply.includes(otherFact));
  const memoryBlock = result.reply.split("## What you remember")[1] ?? "";
  assert.ok(memoryBlock.indexOf(fact) < memoryBlock.indexOf("warehouse") || !memoryBlock.includes("warehouse"));
  const cap = await mintCapabilityToken(
    {
      actorId: "U1",
      scopeId: "personal:U1",
      exp: Date.now() + CAPABILITY_TTL_MS,
      memory: { write: "personal:U1", read: ["personal:U1"] },
    },
    TEST_CAPABILITY_SECRET,
  );
  const grep = await post("/v1/memory/search", { query: "shipment 119" }, { "x-agent-capability": cap });
  assert.equal(grep.status, 200);
  const matches = (await grep.json()) as { results: Array<{ fact: string }> };
  assert.equal(matches.results.length, 1);
  assert.match(matches.results[0]!.fact, /Release 119/);
  const forbidden = await post("/v1/memory/search", { query: "confidential" }, { "x-agent-capability": cap });
  assert.deepEqual(((await forbidden.json()) as { results: unknown[] }).results, []);
  assert.ok(inputs.every((batch) => batch.every((text) => !text.includes(otherFact))));
  assert.ok(
    inputs.every((batch) => batch.every((text) => !/FOREIGN_HISTORY_SENTINEL|TAINTED_HISTORY_SENTINEL/.test(text))),
  );

  const personalFact = (await built.memory.facts!("personal:U1")).find((row) => row.text === fact)!;
  await built.memory.edit!("personal:U1", [
    { id: personalFact.id, text: "Updated preference: use browser smoke tests." },
  ]);
  await seedVectors(built.memory, databaseUrl, embeddingId, providerUrl, ["personal:U1"]);
  const updated = await post("/v1/turns", { ...request, conversation: { kind: "dm", threadRef: "updated" } });
  const newResult = (await updated.json()) as { reply: string };
  assert.ok(!newResult.reply.includes(fact));
  assert.match(newResult.reply, /Updated preference/);
  await post("/v1/turns", {
    ...request,
    text: "We are working on portal verification",
    conversation: { kind: "dm", threadRef: "follow-up" },
  });
  await post("/v1/turns", {
    ...request,
    text: "!sysprompt\nyes, do that",
    conversation: { kind: "dm", threadRef: "follow-up" },
  });
  assert.ok(
    inputs.some((batch) => batch.some((text) => text.includes("portal verification") && text.includes("yes, do that"))),
  );
});

pgTest("HTTP Open DM combines room and current memory, then blocks reads after membership revocation", async (t) => {
  const databaseFixture = await isolatedDatabase(t);
  const databaseUrl = databaseFixture.url;
  const inputs: string[][] = [];
  const provider = httpServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { input } = JSON.parse(body) as { input: string[] };
    inputs.push(input);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: input.map((text, index) => {
          const first = Number(text.split(" ")[0]);
          const score = Number.isFinite(first) ? first : 1;
          return { index, embedding: [score, Math.sqrt(1 - score * score)] };
        }),
      }),
    );
  });
  const providerUrl = await listen(provider);
  t.after(() => close(provider));
  const built = buildApp(
    testConfig({
      sharingPosture: "open",
      memoryStrategy: "agent-only",
      databaseUrl,
      providerBaseUrls: { openai: providerUrl },
      openaiApiKey: "test",
    }),
  );
  databaseFixture.stop = () => built.runtime.stop();
  await built.modelRegistry.upsert({ kind: "embedding", id: "test", name: "Embeddings", provider: "openai" }, "admin");
  await built.config.setEmbeddingModel("test");
  const personal = "personal:U1",
    room = "channel:C1",
    denied = "channel:C2";
  await built.directory.replaceChannels(
    [
      { channelId: "C1", name: "room", isPrivate: true },
      { channelId: "C2", name: "closed", isPrivate: true },
    ],
    [
      { channelId: "C1", principalId: "U1" },
      { channelId: "C2", principalId: "U1" },
    ],
  );
  for (const scope of [room, denied]) {
    const session = await built.sessions.getOrCreateByThread(`${scope}:seed`, "channel", scope);
    await built.sessions.addParticipant(session.id, "U1");
  }
  await built.config.setSharingPosture(denied, "isolated");
  await built.memory.capture(
    personal,
    ["0.7 LOCAL_NEAR", ...Array.from({ length: 120 }, (_, i) => `0.6 local ${i} ${"x".repeat(70)}`)],
    Date.now(),
  );
  await built.memory.capture(room, ["0.99 REMOTE_BEST", "0.72 REMOTE_NEAR"], Date.now());
  await built.memory.capture(denied, ["1 DENIED_NOTEBOOK"], Date.now());
  await seedVectors(built.memory, databaseUrl, "test", providerUrl, [personal, room]);
  const server = createInsecureTestServer(built.app);
  const base = await listen(server);
  t.after(() => close(server));
  const turn = async (text: string, thread: string) => {
    const response = await fetch(base + "/v1/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "test",
        origin: { kind: "human" },
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: thread },
        text,
      }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as { status: string; reply: string };
    assert.equal(result.status, "ok");
    return result.reply;
  };
  const prompt = await turn("!sysprompt\nverify the change", "cross-scope-http");
  const memory = prompt.split("## What you remember")[1]!.split("</environment>")[0]!;
  const packed = memory.slice(memory.indexOf("### ")).trim();
  assert.ok(packed.length <= 6000);
  assert.ok(memory.indexOf("REMOTE_BEST") >= 0);
  assert.ok(memory.indexOf("REMOTE_BEST") < memory.indexOf("REMOTE_NEAR"));
  assert.ok(memory.indexOf("REMOTE_NEAR") < memory.indexOf("LOCAL_NEAR"));
  assert.doesNotMatch(prompt, /DENIED_NOTEBOOK/);
  assert.ok(inputs.flat().every((text) => !text.includes("DENIED_NOTEBOOK")));
  assert.equal(inputs.filter((batch) => batch.length === 1 && batch[0]!.includes("verify the change")).length, 1);
  assert.match(await turn("!memoryread channel:C1", "read-shared"), /REMOTE_BEST/);
  assert.doesNotMatch(await turn("!memoryread channel:C2", "read-denied"), /DENIED_NOTEBOOK/);
  await built.directory.replaceChannels([{ channelId: "C1", name: "room", isPrivate: true }], []);
  assert.doesNotMatch(await turn("!memoryread channel:C1", "read-revoked"), /REMOTE_BEST/);
  assert.doesNotMatch(await turn("!sysprompt\nverify the change", "recall-revoked"), /REMOTE_BEST/);
  assert.ok(
    (await built.auditLog.events()).some(
      (event) => event.action === "sharing.cross_context_read" && event.resource === "memory",
    ),
  );
});
