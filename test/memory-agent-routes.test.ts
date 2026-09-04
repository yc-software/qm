import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CREDENTIAL_BROKER_AUD } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "memory-route-test-secret".repeat(3);

describe("agent memory self-API (/v1/memory/self|search|facts)", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const capFor = async (actorId: string, memory?: { write?: ScopeId; orgWrite?: ScopeId; read: ScopeId[] }) =>
    await mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...(memory ? { memory } : {}),
      },
      SECRET,
    );

  before(async () => {
    built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "memory-routes-")),
        signingSecret: SECRET,
      }),
    );
    server = createServer(built.app, { signingSecret: SECRET, memory: built.memory });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const put = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });

  const U1 = scopeId("personal", "U1");
  const ORG = scopeId("org", "default-org");

  it("appends facts to the token's writable scope and reads them back", async () => {
    const cap = await capFor("U1", { write: U1, read: [U1] });
    const res = await post(
      "/v1/memory/facts",
      { facts: ["Hsiao is building speaker attribution."] },
      { "x-agent-capability": cap },
    );
    assert.equal(res.status, 200);
    const out = (await res.json()) as any;
    assert.equal(out.added, 1);
    assert.equal(out.scopeId, U1);

    const self = (await (await get("/v1/memory/self", { "x-agent-capability": cap })).json()) as any;
    assert.equal(self.scopeId, U1);
    assert.match(self.content, /speaker attribution/);
  });

  it("dedupes repeated facts server-side", async () => {
    const cap = await capFor("U1", { write: U1, read: [U1] });
    const res = await post(
      "/v1/memory/facts",
      { facts: ["Hsiao is building speaker attribution."] },
      { "x-agent-capability": cap },
    );
    assert.equal(((await res.json()) as any).added, 0);
  });

  it("searches across every readable scope, labeling hits by scope", async () => {
    await built.memory.capture(ORG, ["The org all-hands is on Fridays."], Date.now());
    const cap = await capFor("U1", { write: U1, read: [U1, ORG] });
    const res = await post("/v1/memory/search", { query: "all-hands" }, { "x-agent-capability": cap });
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as any;
    assert.equal(results.length, 1);
    assert.equal(results[0].scopeId, ORG);
    assert.match(results[0].fact, /Fridays/);
  });

  it("cannot search a scope the token does not carry", async () => {
    await built.memory.capture(scopeId("personal", "U2"), ["U2's private fact about kumquats."], Date.now());
    const cap = await capFor("U1", { write: U1, read: [U1, ORG] });
    const res = await post("/v1/memory/search", { query: "kumquats" }, { "x-agent-capability": cap });
    const { results } = (await res.json()) as any;
    assert.equal(results.length, 0, "a scope outside the token's read claim must be invisible");
  });

  it("ignores forged scope hints in the body — the token decides", async () => {
    const cap = await capFor("U1", { write: U1, read: [U1] });
    const res = await post(
      "/v1/memory/facts",
      { facts: ["forged-scope fact"], scopeId: scopeId("personal", "U2"), principalId: "U2" },
      { "x-agent-capability": cap },
    );
    assert.equal(((await res.json()) as any).scopeId, U1);
    assert.equal(await built.memory.read(scopeId("personal", "U2")).then((c) => c.includes("forged-scope")), false);
  });

  it("curates (rewrites) the writable notebook via PUT /v1/memory/self", async () => {
    const cap = await capFor("U1", { write: U1, read: [U1] });
    const res = await put(
      "/v1/memory/self",
      { content: "# Memory\n\n- (2026-06-10) curated." },
      { "x-agent-capability": cap },
    );
    assert.equal(res.status, 200);
    const self = (await (await get("/v1/memory/self", { "x-agent-capability": cap })).json()) as any;
    assert.match(self.content, /curated/);
    assert.doesNotMatch(self.content, /speaker attribution/);
  });

  it('scope:"org" writes the org notebook when the token carries orgWrite (admin turn)', async () => {
    const cap = await capFor("A1", { write: scopeId("personal", "A1"), orgWrite: ORG, read: [ORG] });
    const res = await post(
      "/v1/memory/facts",
      { facts: ["Quarterly planning moved to Mondays."], scope: "org" },
      { "x-agent-capability": cap },
    );
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).scopeId, ORG);
    assert.match(await built.memory.read(ORG), /Quarterly planning/);
    assert.doesNotMatch(await built.memory.read(scopeId("personal", "A1")), /Quarterly planning/);

    const self = (await (await get("/v1/memory/self?scope=org", { "x-agent-capability": cap })).json()) as any;
    assert.equal(self.scopeId, ORG);
    assert.match(self.content, /Quarterly planning/);
    const putRes = await put(
      "/v1/memory/self",
      { content: "# Memory\n\n- org notebook curated.", scope: "org" },
      { "x-agent-capability": cap },
    );
    assert.equal(putRes.status, 200);
    assert.match(await built.memory.read(ORG), /org notebook curated/);
  });

  it('without scope:"org", an admin token still writes the turn\'s own notebook', async () => {
    const A1 = scopeId("personal", "A1");
    const cap = await capFor("A1", { write: A1, orgWrite: ORG, read: [A1] });
    const res = await post("/v1/memory/facts", { facts: ["A1 prefers terse updates."] }, { "x-agent-capability": cap });
    assert.equal(((await res.json()) as any).scopeId, A1);
    assert.doesNotMatch(await built.memory.read(ORG), /terse updates/);
  });

  it('403s scope:"org" when the token carries no orgWrite (non-admin)', async () => {
    const cap = await capFor("U1", { write: U1, read: [U1] });
    const res = await post(
      "/v1/memory/facts",
      { facts: ["forged org fact"], scope: "org" },
      { "x-agent-capability": cap },
    );
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as any).message, /org admin/);
    assert.equal((await get("/v1/memory/self?scope=org", { "x-agent-capability": cap })).status, 403);
    assert.equal(
      (await put("/v1/memory/self", { content: "x", scope: "org" }, { "x-agent-capability": cap })).status,
      403,
    );
    assert.doesNotMatch(await built.memory.read(ORG), /forged org fact/);
  });

  it("400s an unknown scope selector", async () => {
    const cap = await capFor("U1", { write: U1, orgWrite: ORG, read: [U1] });
    assert.equal(
      (await post("/v1/memory/facts", { facts: ["x"], scope: "personal:U2" }, { "x-agent-capability": cap })).status,
      400,
    );
    assert.equal((await get("/v1/memory/self?scope=team", { "x-agent-capability": cap })).status, 400);
  });

  it("403s search when the token carries no read scopes (recall off)", async () => {
    const cap = await capFor("U1", { write: U1, read: [] });
    assert.equal((await post("/v1/memory/search", { query: "anything" }, { "x-agent-capability": cap })).status, 403);
  });

  it("403s writes when the token carries no write scope (capture off)", async () => {
    const cap = await capFor("U1", { read: [U1] });
    assert.equal((await post("/v1/memory/facts", { facts: ["x"] }, { "x-agent-capability": cap })).status, 403);
    assert.equal((await get("/v1/memory/self", { "x-agent-capability": cap })).status, 403);
    assert.equal((await put("/v1/memory/self", { content: "" }, { "x-agent-capability": cap })).status, 403);
  });

  it("rejects a memoryless or wrong-audience token", async () => {
    const noClaim = await capFor("U1");
    assert.equal((await post("/v1/memory/search", { query: "x" }, { "x-agent-capability": noClaim })).status, 403);
    const wrongAud = await mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: U1,
        aud: CREDENTIAL_BROKER_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
        memory: { write: U1, read: [U1] },
      },
      SECRET,
    );
    assert.equal((await post("/v1/memory/search", { query: "x" }, { "x-agent-capability": wrongAud })).status, 403);
  });

  it("rejects an unauthenticated call outright", async () => {
    const res = await post("/v1/memory/facts", { facts: ["x"] });
    assert.notEqual(res.status, 200);
  });

  it("400s malformed input", async () => {
    const cap = await capFor("U1", { write: U1, read: [U1] });
    assert.equal((await post("/v1/memory/search", { query: "   " }, { "x-agent-capability": cap })).status, 400);
    assert.equal((await post("/v1/memory/facts", { facts: [] }, { "x-agent-capability": cap })).status, 400);
    assert.equal(
      (
        await post(
          "/v1/memory/facts",
          { facts: Array.from({ length: 21 }, (_, i) => `f${i}`) },
          { "x-agent-capability": cap },
        )
      ).status,
      400,
    );
    assert.equal((await put("/v1/memory/self", { content: 42 }, { "x-agent-capability": cap })).status, 400);
    assert.equal(
      (await post("/v1/memory/facts", { channel: "eng", facts: ["x"] }, { "x-agent-capability": cap })).status,
      400,
    );
    assert.equal(
      (await post("/v1/memory/facts", { participants: ["U2"], facts: ["x"] }, { "x-agent-capability": cap })).status,
      400,
    );
    assert.equal(
      (await post("/v1/memory/facts", { recipient: "U2", facts: ["x"] }, { "x-agent-capability": cap })).status,
      400,
    );
  });
});

describe("agent memory: cross-conversation writes are refused", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const CH_PUBLIC = "C-eng";
  const CH_PRIVATE = "C-secret";
  const GROUP = "G-jrs";

  const capFor = async (actorId: string, memory?: { write?: ScopeId; read: ScopeId[] }) =>
    await mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...(memory ? { memory } : {}),
      },
      SECRET,
    );

  before(async () => {
    built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "memory-room-")),
        signingSecret: SECRET,
      }),
    );
    await built.directory.replace([
      { principalId: "U1", displayName: "Una", type: "internal" },
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
      { principalId: "U-sam", displayName: "Sam", type: "internal" },
    ]);
    await built.directory.replaceChannels(
      [
        { channelId: CH_PUBLIC, name: "eng", isPrivate: false },
        { channelId: CH_PRIVATE, name: "secret", isPrivate: true },
      ],
      [{ channelId: CH_PRIVATE, principalId: "U-carol" }],
    );
    await built.directory.replaceGroups([
      { groupId: GROUP, principalId: "U-carol" },
      { groupId: GROUP, principalId: "U-sam" },
    ]);
    server = createServer(built.app, { signingSecret: SECRET, memory: built.memory });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (body: unknown, cap: string) =>
    fetch(`${base}/v1/memory/facts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
      body: JSON.stringify(body),
    });

  it("does not let an internal non-member plant a public channel notebook", async () => {
    const cap = await capFor("U1", { write: scopeId("personal", "U1"), read: [scopeId("personal", "U1")] });
    const res = await post({ channel: "eng", facts: ["#eng coordinates the ystack launch."] }, cap);
    assert.equal(res.status, 400);
    assert.doesNotMatch(await built.memory.read(scopeId("channel", CH_PUBLIC)), /ystack launch/);
    assert.doesNotMatch(await built.memory.read(scopeId("personal", "U1")), /ystack launch/);
  });

  it("requires private-channel memory changes to originate in that conversation", async () => {
    const member = await capFor("U-carol", {
      write: scopeId("personal", "U-carol"),
      read: [scopeId("personal", "U-carol")],
    });
    const ok = await post({ channel: "secret", facts: ["private channel note."] }, member);
    assert.equal(ok.status, 400);
    assert.doesNotMatch(await built.memory.read(scopeId("channel", CH_PRIVATE)), /private channel note/);

    const outsider = await capFor("U1", { write: scopeId("personal", "U1"), read: [scopeId("personal", "U1")] });
    const denied = await post({ channel: "secret", facts: ["sneaky note."] }, outsider);
    assert.equal(denied.status, 400);
    assert.doesNotMatch(await built.memory.read(scopeId("channel", CH_PRIVATE)), /sneaky note/);
  });

  it("requires group memory changes to originate in that conversation", async () => {
    const member = await capFor("U-carol", {
      write: scopeId("personal", "U-carol"),
      read: [scopeId("personal", "U-carol")],
    });
    const ok = await post({ participants: ["U-sam"], facts: ["group DM note."] }, member);
    assert.equal(ok.status, 400);
    assert.doesNotMatch(await built.memory.read(scopeId("group", GROUP)), /group DM note/);

    const outsider = await capFor("U1", { write: scopeId("personal", "U1"), read: [scopeId("personal", "U1")] });
    assert.equal((await post({ participants: ["U-sam", "U-carol"], facts: ["x"] }, outsider)).status, 400);
  });

  it("refuses even ambiguous named targets before resolution", async () => {
    await built.directory.replaceChannels(
      [
        { channelId: CH_PUBLIC, name: "eng", isPrivate: false },
        { channelId: CH_PRIVATE, name: "secret", isPrivate: true },
        { channelId: "C-dup1", name: "dup", isPrivate: false },
        { channelId: "C-dup2", name: "dup", isPrivate: false },
      ],
      [{ channelId: CH_PRIVATE, principalId: "U-carol" }],
    );
    const cap = await capFor("U1", { write: scopeId("personal", "U1"), read: [scopeId("personal", "U1")] });
    const res = await post({ channel: "dup", facts: ["x"] }, cap);
    assert.equal(res.status, 400);
  });

  it("refuses unknown named targets without resolving them", async () => {
    const cap = await capFor("U1", { write: scopeId("personal", "U1"), read: [scopeId("personal", "U1")] });
    assert.equal((await post({ channel: "nope-nope", facts: ["x"] }, cap)).status, 400);
  });

  it("403s when memory capture is off for the conversation, even for a member", async () => {
    const noWrite = await capFor("U-carol", { read: [scopeId("personal", "U-carol")] });
    const res = await post({ channel: "eng", facts: ["x"] }, noWrite);
    assert.equal(res.status, 400);
  });

  it("400s a channel target on a non-facts memory verb", async () => {
    const cap = await capFor("U1", { write: scopeId("personal", "U1"), read: [scopeId("personal", "U1")] });
    const res = await fetch(`${base}/v1/memory/self`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
      body: JSON.stringify({ channel: "eng", content: "# Memory\n\n- hijack" }),
    });
    assert.equal(res.status, 400);
    assert.doesNotMatch(await built.memory.read(scopeId("channel", CH_PUBLIC)), /hijack/);
  });

  it("refuses a recipient (teammate personal notebook) rather than silently writing own notebook", async () => {
    const cap = await capFor("U1", { write: scopeId("personal", "U1"), read: [scopeId("personal", "U1")] });
    const res = await post({ recipient: "Carol", facts: ["about carol"] }, cap);
    assert.equal(res.status, 400);
    assert.doesNotMatch(await built.memory.read(scopeId("personal", "U-carol")), /about carol/);
    assert.doesNotMatch(await built.memory.read(scopeId("personal", "U1")), /about carol/);
  });

  it("still validates the facts array on the channel path", async () => {
    const cap = await capFor("U1", { write: scopeId("personal", "U1"), read: [scopeId("personal", "U1")] });
    assert.equal((await post({ channel: "eng", facts: [] }, cap)).status, 400);
    assert.equal(
      (await post({ channel: "eng", facts: Array.from({ length: 21 }, (_, i) => `f${i}`) }, cap)).status,
      400,
    );
  });

  it("400s a present-but-blank channel/participants instead of silently writing the own notebook", async () => {
    const cap = await capFor("U1", { write: scopeId("personal", "U1"), read: [scopeId("personal", "U1")] });
    const blank = await post({ channel: "   ", facts: ["should not land anywhere"] }, cap);
    assert.equal(blank.status, 400);
    assert.doesNotMatch(await built.memory.read(scopeId("personal", "U1")), /should not land/);
    assert.equal((await post({ participants: [], facts: ["x"] }, cap)).status, 400);
    assert.equal((await post({ channel: 42, facts: ["x"] }, cap)).status, 400);
  });
});
