import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
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
  const fetchActual = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("http://core.test/")) {
      token = new Headers(init?.headers).get("x-agent-capability") ?? undefined;
      return fetchActual(input.replace("http://core.test", base), init);
    }
    return fetchActual(input, init);
  });
  const built = buildApp(config, { agent: {
    ...createMockAgent(),
    runTurn: async (input) => {
      assert.ok(input.tools.selfApi);
      const saved = await input.tools.selfApi("POST", "/v1/skills", { name: "protected-procedure", description: "private procedure", body: "Private procedure content" });
      assert.equal(saved.status, 201);
      privateId = (saved.body as { skill: { id: string } }).skill.id;
      return { reply: "Saved privately", modelCalls: 0 };
    },
  } });
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const actorId = "admin-alice";
  const personal = "personal:admin-alice";
  await built.directory.replaceChannels([{ channelId: "C1", name: "collaborators" }], [{ channelId: "C1", principalId: actorId }]);
  const project = await built.projects.create({ name: "Operations", ownerId: actorId });
  await built.documentConversations.configure("https://sheets.example.test", project.id);
  const binding = await built.documentConversations.resolve({ surface: "https://sheets.example.test", documentId: "private-skills", principalId: actorId, mode: "private" });
  assert.equal(binding.status, "ok");
  if (binding.status !== "ok") throw new Error("Missing private conversation");
  const result = await built.app.turn({ surface: "web", actor: { externalId: actorId }, conversation: { kind: "dm", threadRef: binding.conversation.threadRef }, text: "Save my private procedure", skipMemory: true });
  assert.equal(result.status, "ok");
  assert.ok(token);
  const claims = await verifyCapabilityToken(token, secret);
  assert.equal(claims?.personalOnly, true);
  assert.equal(claims?.memory, undefined);
  const create = async (capability: string, name: string) => {
    const response = await fetch(`${base}/v1/skills`, { method: "POST", headers: { "x-agent-capability": capability, "content-type": "application/json" }, body: JSON.stringify({ name, description: "procedure", body: "Procedure content" }) });
    assert.equal(response.status, 201);
    return ((await response.json()) as { skill: { id: string } }).skill.id;
  };
  assert.equal((await built.skills.get(privateId))?.personalOnly, true);
  const own = await mintCapabilityToken({ actorId, scopeId: personal, liveActor: true, aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 }, secret);
  const ordinaryId = await create(own, "ordinary-procedure");
  await built.config.setSharingPosture("org:default-org", "open");
  const shared = await mintCapabilityToken({ actorId, scopeId: "channel:C1", liveActor: true, aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 }, secret);
  const detail = (id: string, capability: string) => fetch(`${base}/v1/admin/skills/${id}?scope=org:default-org`, { headers: { "x-agent-capability": capability } });
  assert.equal((await detail(ordinaryId, shared)).status, 200);
  assert.equal((await detail(privateId, own)).status, 404);
  const protectedOwn = await mintCapabilityToken({ actorId, scopeId: personal, personalOnly: true, liveActor: true, aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 }, secret);
  assert.equal((await detail(privateId, protectedOwn)).status, 200);
  assert.equal((await detail(privateId, shared)).status, 404);
});
