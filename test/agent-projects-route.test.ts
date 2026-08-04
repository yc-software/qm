import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "agent-projects-secret".repeat(2);

describe("agent projects self-API", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let mineId: string;
  let theirsId: string;

  const capFor = (actorId: string) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );

  const request = async (method: string, path: string, body?: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { "x-agent-capability": token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  before(async () => {
    built = buildApp(testConfig({ signingSecret: SECRET }));
    await built.app.upsertDirectory([
      { principalId: "U1", displayName: "One", type: "internal" },
      { principalId: "U2", displayName: "Two", type: "internal" },
      { principalId: "U3", displayName: "Three", type: "internal" },
    ]);
    mineId = (await built.app.createProject("U1", "Mine"))!.id;
    theirsId = (await built.app.createProject("U2", "Theirs"))!.id;
    server = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("requires a capability token on every route", async () => {
    assert.equal((await request("GET", "/v1/projects")).status, 401);
    assert.equal((await request("POST", "/v1/projects", { name: "New" })).status, 401);
    assert.equal((await request("PATCH", `/v1/projects/${mineId}`, { name: "Renamed" })).status, 401);
    assert.equal((await request("POST", `/v1/projects/${mineId}/members`, { memberId: "U3" })).status, 401);
    assert.equal((await request("DELETE", `/v1/projects/${mineId}/members/U3`, {})).status, 401);
  });

  it("lists only projects visible to the token actor", async () => {
    const response = await request("GET", "/v1/projects", undefined, await capFor("U1"));
    assert.equal(response.status, 200);
    const { projects } = (await response.json()) as { projects: Array<{ id: string }> };
    assert.ok(projects.some((project) => project.id === mineId));
    assert.ok(!projects.some((project) => project.id === theirsId));
  });

  it("creates, renames, adds a member, and removes a member as the token actor", async () => {
    const token = await capFor("U1");
    const created = await request("POST", "/v1/projects", { name: "Agent Project" }, token);
    assert.equal(created.status, 201);
    const project = ((await created.json()) as { project: { id: string } }).project;

    const renamed = await request("PATCH", `/v1/projects/${project.id}`, { name: "Agent Renamed" }, token);
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { project: { name: string } }).project.name, "Agent Renamed");

    const added = await request("POST", `/v1/projects/${project.id}/members`, { memberId: "U3" }, token);
    assert.equal(added.status, 200);
    assert.ok(
      ((await added.json()) as { project: { members: Array<{ principalId: string }> } }).project.members.some(
        (member) => member.principalId === "U3",
      ),
    );

    const removed = await request("DELETE", `/v1/projects/${project.id}/members/U3`, {}, token);
    assert.equal(removed.status, 200);
    assert.ok(
      !((await removed.json()) as { project: { members: Array<{ principalId: string }> } }).project.members.some(
        (member) => member.principalId === "U3",
      ),
    );
  });

  it("returns 404 for another principal's project", async () => {
    const token = await capFor("U1");
    assert.equal((await request("PATCH", `/v1/projects/${theirsId}`, { name: "Hidden" }, token)).status, 404);
    assert.equal((await request("POST", `/v1/projects/${theirsId}/members`, { memberId: "U3" }, token)).status, 404);
    assert.equal((await request("DELETE", `/v1/projects/${theirsId}/members/U3`, {}, token)).status, 404);
  });

  it("uses the token actor when principalId is omitted or matching and hides mismatches", async () => {
    const token = await capFor("U1");
    assert.equal((await request("GET", "/v1/projects?principalId=U1", undefined, token)).status, 200);
    assert.equal((await request("GET", "/v1/projects?principalId=U2", undefined, token)).status, 404);
    assert.equal((await request("POST", "/v1/projects", { principalId: "U1", name: "Matching" }, token)).status, 201);
    assert.equal((await request("POST", "/v1/projects", { principalId: "U2", name: "Hidden" }, token)).status, 404);
  });

  it("allows every mutation under strict posture", async () => {
    const token = await capFor("U1");
    const scope = scopeId("personal", "U1");
    await built.config.setSecurityPosture(scope, "strict");
    try {
      const created = await request("POST", "/v1/projects", { name: "Strict" }, token);
      assert.equal(created.status, 201);
      const projectId = ((await created.json()) as { project: { id: string } }).project.id;
      assert.equal(
        (await request("PATCH", `/v1/projects/${projectId}`, { name: "Strict Renamed" }, token)).status,
        200,
      );
      assert.equal((await request("POST", `/v1/projects/${projectId}/members`, { memberId: "U3" }, token)).status, 200);
      assert.equal((await request("DELETE", `/v1/projects/${projectId}/members/U3`, {}, token)).status, 200);
    } finally {
      await built.config.setSecurityPosture(scope, "auto");
    }
  });
});
