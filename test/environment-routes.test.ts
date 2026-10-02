import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "env-route-test-secret".repeat(3);

describe("environment verbs (list / create / attach, owner-gated)", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let unwired: Server;
  let unwiredBase: string;

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
      signingSecret: SECRET,
      scheduler: built.scheduler,
      canWriteScope: built.canWriteScope,
    });
    unwired = createServer(built.app, { signingSecret: SECRET, scheduler: built.scheduler });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    await new Promise<void>((resolve) => unwired.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    unwiredBase = `http://localhost:${(unwired.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    unwired.close();
  });

  it("create names THIS conversation's computer; the actor becomes its owner", async () => {
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

  it("the owner attaches another conversation freely", async () => {
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

  it("a non-owner is refused and told to ask the owner (owner mediation)", async () => {
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

  it("any current member of the owning conversation may attach another conversation (the gate still demands the creating person)", async () => {
    const ownerScope = scopeId("channel", "C-eng");
    const created = await post(
      "/v1/environments",
      { name: "eng-box" },
      {
        "x-agent-capability": await mintCapabilityToken(
          { actorId: "U-owner", scopeId: ownerScope, exp: Date.now() + CAPABILITY_TTL_MS },
          SECRET,
        ),
      },
    );
    assert.equal(created.status, 200);
    await built.directory.replaceChannels(
      [{ channelId: "C-eng", name: "eng", isPrivate: false }],
      [
        { channelId: "C-eng", principalId: "U-owner" },
        { channelId: "C-eng", principalId: "U-mate" },
      ],
    );

    const res = await post(
      "/v1/environments/attach",
      { name: "eng-box" },
      { "x-agent-capability": await cap("U-mate") },
    );
    assert.equal(res.status, 200);
  });

  it("attach says the membership check is missing rather than blaming the owning conversation (a server misconfiguration reads as a refusal)", async () => {
    const res = await fetch(`${unwiredBase}/v1/environments/attach`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await cap("U-owner") },
      body: JSON.stringify({ name: "prod" }),
    });
    assert.equal(res.status, 501);
    assert.equal(((await res.json()) as any).error, "not_configured");
  });

  it("the creator may not attach once they leave the conversation that owns the environment (the recorded person keeps attaching)", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C-eng", name: "eng", isPrivate: false }],
      [{ channelId: "C-eng", principalId: "U-mate" }],
    );

    const res = await post(
      "/v1/environments/attach",
      { name: "eng-box" },
      { "x-agent-capability": await cap("U-owner") },
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as any;
    assert.equal(body.error, "owner_mediation_required");
    assert.equal(body.ownerScopeId, scopeId("channel", "C-eng"));
  });
});
