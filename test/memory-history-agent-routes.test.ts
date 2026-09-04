import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/api/server.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import type { MemoryRevision, MemoryService } from "../src/memory/memory-service.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "memory-history-route-secret".repeat(3);

describe("agent memory history and restore", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let memory: MemoryService;

  const capFor = (actorId: string, write: ScopeId, orgWrite?: ScopeId) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
        memory: { write, read: [write], ...(orgWrite ? { orgWrite } : {}) },
      },
      SECRET,
    );
  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, { headers: token ? { "x-agent-capability": token } : {} });
  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-agent-capability": token } : {}) },
      body: JSON.stringify(body),
    });
  const put = (path: string, body: unknown, token: string) =>
    fetch(`${base}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": token },
      body: JSON.stringify(body),
    });

  before(async () => {
    built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "memory-history-routes-")), signingSecret: SECRET }),
    );
    const revisions = new Map<ScopeId, MemoryRevision[]>();
    memory = {
      ...built.memory,
      async replace(scope, content, author) {
        await built.memory.replace(scope, content, author);
        const history = revisions.get(scope) ?? [];
        history.push({
          revision: String(history.length + 1),
          content: await built.memory.read(scope),
          operation: "replace",
          ...(author ? { author } : {}),
          at: Date.now(),
        });
        revisions.set(scope, history);
      },
      async history(scope, limit = 30) {
        return (revisions.get(scope) ?? []).toReversed().slice(0, limit);
      },
      async restore(scope, revision, expectedRevision, author) {
        const history = revisions.get(scope) ?? [];
        if (String(history.length) !== expectedRevision) return false;
        const target = history.find((entry) => entry.revision === revision);
        if (!target) return false;
        await this.replace(scope, target.content, author);
        return true;
      },
    };
    server = createServer(built.app, { signingSecret: SECRET, memory });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("lists versions after writes and restores a prior version", async () => {
    const mine = scopeId("personal", "U1");
    const token = await capFor("U1", mine);
    assert.equal((await put("/v1/memory/self", { content: "first version" }, token)).status, 200);
    assert.equal((await put("/v1/memory/self", { content: "second version" }, token)).status, 200);

    const history = await get("/v1/memory/history", token);
    assert.equal(history.status, 200);
    const { revisions } = (await history.json()) as {
      revisions: Array<{ revision: string; content: string }>;
    };
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0]?.content, "second version\n");
    assert.equal(revisions[1]?.content, "first version\n");

    const restored = await post(
      "/v1/memory/restore",
      { revision: revisions[1]?.revision, expectedRevision: revisions[0]?.revision },
      token,
    );
    assert.equal(restored.status, 200);
    assert.equal(await memory.read(mine), "first version\n");
  });

  it("does not expose or restore another principal's notebook", async () => {
    const token = await capFor("U2", scopeId("personal", "U2"));
    assert.equal((await get("/v1/memory/history?principalId=U1", token)).status, 404);
    assert.equal(
      (await post("/v1/memory/restore", { principalId: "U1", revision: "1", expectedRevision: "2" }, token)).status,
      404,
    );
  });

  it("binds org history and restore to the token's org write scope", async () => {
    const mine = scopeId("personal", "A1");
    const org = scopeId("org", "default-org");
    const token = await capFor("A1", mine, org);
    assert.equal((await put("/v1/memory/self", { content: "first org version", scope: "org" }, token)).status, 200);
    assert.equal((await put("/v1/memory/self", { content: "second org version", scope: "org" }, token)).status, 200);

    const history = await get("/v1/memory/history?scope=org", token);
    assert.equal(history.status, 200);
    const { revisions } = (await history.json()) as { revisions: Array<{ revision: string }> };
    const restored = await post(
      "/v1/memory/restore",
      { scope: "org", revision: revisions[1]?.revision, expectedRevision: revisions[0]?.revision },
      token,
    );
    assert.equal(restored.status, 200);
    assert.equal(await memory.read(org), "first org version\n");

    const personalOnly = await capFor("U3", scopeId("personal", "U3"));
    assert.equal((await get("/v1/memory/history?scope=org", personalOnly)).status, 404);
    assert.equal(
      (await post("/v1/memory/restore", { scope: "org", revision: "1", expectedRevision: "2" }, personalOnly)).status,
      404,
    );
  });

  it("requires authentication", async () => {
    assert.equal((await get("/v1/memory/history")).status, 401);
    assert.equal((await post("/v1/memory/restore", { revision: "1", expectedRevision: "2" })).status, 401);
  });
});
