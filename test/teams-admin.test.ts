import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { strFromU8, unzipSync } from "fflate";
import { createServer } from "../src/api/server.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp, stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";
import { fakeEntra } from "./support/fake-entra.ts";

const BOT = { tenantId: "0f2e7c64-5b1a-4d3e-9c8b-2a6f1e4d7b90", appId: "3d9b1f27-8e4c-4a6b-b5d2-7c1e9f0a4b63" };

test("an admin connects a Teams bot Microsoft accepts, downloads its app, and disconnects it", async (t) => {
  const config = testConfig({ signingSecret: "teams-admin-signing-secret-0123456789" });
  const built = stopAtEnd(buildApp(config));
  const { network: teamsNetworkClient, secrets } = fakeEntra((secret) =>
    secret === "right" ? { token: "t" } : { error: "AADSTS7000215: Invalid client secret provided." },
  );
  const server = createServer(built.app, { ...serverDeps(config, built), ...browserSessionDeps, teamsNetworkClient });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/teams`;
  const call = (method: string, body?: unknown, who = "admin-alice", path = "") =>
    fetch(base + path, {
      method,
      headers: {
        cookie: browserSessionCookie(who),
        origin: browserSessionDeps.portalUrl,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const empty = (await (await call("GET")).json()) as Record<string, unknown>;
  assert.deepEqual(
    [empty.configured, empty.endpoint, empty.signInRedirect],
    [
      false,
      `${browserSessionDeps.portalUrl}/v1/surfaces/teams/activities`,
      `${browserSessionDeps.portalUrl}/auth/callback`,
    ],
  );
  const refused = await call("PUT", { ...BOT, appSecret: "wrong" });
  assert.equal(refused.status, 400);
  assert.ok(((await refused.json()) as { message: string }).message.includes("AADSTS7000215: Invalid client secret"));
  assert.equal((await call("PUT", { ...BOT, appId: "not-a-guid", appSecret: "right" })).status, 400);
  assert.equal((await call("PUT", { ...BOT, appSecret: "right" })).status, 200);
  assert.equal((await call("PUT", BOT)).status, 200);
  assert.deepEqual(secrets, ["wrong", "right", "right"]);
  assert.equal((await call("PUT", { ...BOT, appSecret: "right" }, "alice")).status, 403);

  const zip = unzipSync(
    new Uint8Array(await (await call("GET", undefined, "admin-alice", "/app-package")).arrayBuffer()),
  );
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]!));
  assert.deepEqual(Object.keys(zip).sort(), ["color.png", "manifest.json", "outline.png"]);
  assert.deepEqual(
    [manifest.id, manifest.bots[0].botId, manifest.supportsChannelFeatures, manifest.validDomains],
    [BOT.appId, BOT.appId, "tier1", [new URL(browserSessionDeps.portalUrl).host]],
  );
  assert.deepEqual(
    manifest.authorization.permissions.resourceSpecific.map((p: { name: string }) => p.name),
    ["ChannelMessage.Read.Group", "ChatMessage.Read.Chat"],
  );

  assert.equal(((await (await call("DELETE")).json()) as { configured: boolean }).configured, false);
  assert.equal((await call("GET", undefined, "admin-alice", "/app-package")).status, 404);
});
