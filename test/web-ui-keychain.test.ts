import "./support/auto-fake-sprites.ts";

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

async function core(t: TestContext): Promise<{ base: string; built: ReturnType<typeof buildApp> }> {
  const config = testConfig({ signingSecret: "web-keychain-signing-secret-0123456789" });
  const built = stopAtEnd(buildApp(config));
  const server = createServer(built.app, { ...serverDeps(config, built), ...browserSessionDeps });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, built };
}

const as = (cookie: string, method = "GET", body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json", cookie, origin: browserSessionDeps.portalUrl },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("a signed-in person adds, lists and removes only their own keychain entries from the browser", async (t) => {
  const { base, built } = await core(t);
  const alice = browserSessionCookie("alice");
  const bob = browserSessionCookie("bob");

  const drop = await fetch(`${base}/api/keychain/drops`, as(alice, "POST", { service: "stripe", purpose: "billing" }));
  assert.equal(drop.status, 200);
  const minted = (await drop.json()) as { dropId: string; formPath: string; url: string };
  assert.match(minted.formPath, new RegExp(`^/drop/${minted.dropId}/form\\?t=`));
  assert.equal(minted.url, `${browserSessionDeps.portalUrl}${minted.formPath}`);
  const named = await fetch(
    `${base}/api/keychain/drops`,
    as(alice, "POST", { service: "stripe", purpose: "billing", principalId: "bob" }),
  );
  assert.equal(named.status, 403);
  const onBehalf = await fetch(
    `${base}/api/keychain/drops`,
    as(alice, "POST", { service: "stripe", purpose: "billing", onBehalfOf: "bob" }),
  );
  assert.equal(onBehalf.status, 403);

  const saved = await built.keychain!.save({ ownerId: "alice", service: "stripe", envKey: "STRIPE_KEY", secret: "sk" });
  const overview = (await (await fetch(`${base}/api/keychain/overview`, as(alice))).json()) as {
    credentials: Array<{ id: string }>;
  };
  assert.deepEqual(
    overview.credentials.map((c) => c.id),
    [saved.id],
  );
  const bobView = (await (await fetch(`${base}/api/keychain/overview`, as(bob))).json()) as { credentials: unknown[] };
  assert.deepEqual(bobView.credentials, []);

  assert.equal((await fetch(`${base}/api/keychain/credentials/${saved.id}`, as(bob, "DELETE"))).status, 404);
  assert.equal((await built.keychain!.listByOwner("alice")).length, 1);
  assert.equal((await fetch(`${base}/api/keychain/credentials/${saved.id}`, as(alice, "DELETE"))).status, 200);
  assert.equal((await built.keychain!.listByOwner("alice")).length, 0);
  assert.equal((await fetch(`${base}/api/keychain/grants/missing/revoke`, as(alice, "POST", {}))).status, 404);
});
