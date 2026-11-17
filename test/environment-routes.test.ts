import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { resolveEnvironmentId } from "../src/environments/environment-store.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SECRET = "env-route-test-secret".repeat(3);

describe("environment verbs (list / create / attach, shared by the owning conversation)", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const cap = (actorId: string, scope = scopeId("personal", actorId)) =>
    mintCapabilityToken({ actorId, scopeId: scope, exp: Date.now() + CAPABILITY_TTL_MS }, SECRET);

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });

  before(async () => {
    built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "env-routes-")),
        signingSecret: SECRET,
      }),
    );
    await built.directory.replaceChannels(
      [{ channelId: "C-eng", name: "eng", isPrivate: false }],
      [{ channelId: "C-eng", principalId: "U-owner" }],
    );
    server = createServer(built.app, {
      replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
      signingSecret: SECRET,
      scheduler: built.scheduler,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("create names THIS conversation's computer and records who named it", async () => {
    const res = await post("/v1/environments", { name: "prod" }, { "x-agent-capability": await cap("U-owner") });
    assert.equal(res.status, 200);
    const { environment } = (await res.json()) as any;
    assert.equal(environment.name, "prod");
    assert.equal(environment.ownerActorId, "U-owner");
    assert.equal(environment.id, scopeId("personal", "U-owner"));
  });

  it("list reports named environments and their attachments", async () => {
    const res = await get("/v1/environments", { "x-agent-capability": await cap("U-owner") });
    assert.equal(res.status, 200);
    const { environments } = (await res.json()) as any;
    const prod = environments.find((e: any) => e.name === "prod");
    assert.ok(prod, "the created environment is listed");
    assert.deepEqual(prod.attachedScopes, []);
  });

  it("a current member of the owning conversation shares it with another conversation", async () => {
    const channelCap = await mintCapabilityToken(
      { actorId: "U-owner", scopeId: scopeId("channel", "C-eng"), exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );
    const res = await post("/v1/environments/attach", { name: "prod" }, { "x-agent-capability": channelCap });
    assert.equal(res.status, 200);
    const list = (await (await get("/v1/environments", { "x-agent-capability": await cap("U-owner") })).json()) as any;
    const prod = list.environments.find((e: any) => e.name === "prod");
    assert.deepEqual(prod.attachedScopes, [scopeId("channel", "C-eng")]);
  });

  it("someone outside the owning conversation is refused and pointed at that conversation", async () => {
    const res = await post(
      "/v1/environments/attach",
      { name: "prod" },
      { "x-agent-capability": await cap("U-stranger") },
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as any;
    assert.equal(body.error, "owner_mediation_required");
    assert.equal(body.ownerScopeId, scopeId("personal", "U-owner"));
  });

  it("a room member's DM share of the room's computer lapses when they leave the room", async () => {
    const room = scopeId("channel", "C-room");
    const dm = scopeId("personal", "U-mallory");
    const channels = [
      { channelId: "C-eng", name: "eng", isPrivate: false },
      { channelId: "C-room", name: "room", isPrivate: true },
    ];
    const eng = { channelId: "C-eng", principalId: "U-owner" };
    await built.directory.replaceChannels(channels, [eng, { channelId: "C-room", principalId: "U-mallory" }]);
    const created = await post(
      "/v1/environments",
      { name: "room-box" },
      { "x-agent-capability": await cap("U-mallory", room) },
    );
    assert.equal(created.status, 200);
    const attached = await post(
      "/v1/environments/attach",
      { name: "room-box" },
      { "x-agent-capability": await cap("U-mallory") },
    );
    assert.equal(attached.status, 200);
    assert.equal(await resolveEnvironmentId(built.environments, dm), room);

    await built.directory.replaceChannels(channels, [eng]);
    assert.equal(
      await resolveEnvironmentId(built.environments, dm),
      dm,
      "the DM no longer reaches the room's computer",
    );
    const list = (await (
      await get("/v1/environments", { "x-agent-capability": await cap("U-mallory") })
    ).json()) as any;
    assert.deepEqual(list.environments.find((e: any) => e.name === "room-box").attachedScopes, []);
    const again = await post(
      "/v1/environments/attach",
      { name: "room-box" },
      { "x-agent-capability": await cap("U-mallory") },
    );
    assert.equal(again.status, 403, "naming the environment gave no lasting authority over it");
    assert.equal(((await again.json()) as any).ownerScopeId, room);
  });

  it("attach to an unknown environment is a 404", async () => {
    const res = await post(
      "/v1/environments/attach",
      { name: "ghost" },
      { "x-agent-capability": await cap("U-owner") },
    );
    assert.equal(res.status, 404);
  });

  it("all verbs require a capability token (the auth gate rejects unauthed requests)", async () => {
    assert.equal((await get("/v1/environments")).status, 401);
    assert.equal((await post("/v1/environments", { name: "x" })).status, 401);
    assert.equal((await post("/v1/environments/attach", { name: "x" })).status, 401);
  });
});
