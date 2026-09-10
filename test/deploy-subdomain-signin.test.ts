import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, portal } from "./helpers/deploy-hardening-fixture.ts";
import { scopeId } from "../src/types.ts";

test("subdomain sign-in: signed-out navigation resumes exact app path via the trusted source, not parent cookies", async (t) => {
  const f = await fixture(t);
  const path = "/consultants?x=1&dpl_signin=1&owner=app&access=ordinary";
  const browser = await f.send(path, { host: f.host, accept: "text/html" });
  assert.equal(browser.status, 302);
  assert.equal(browser.headers.location, `${portal}/d/${f.d.id}${path}`);
  const xhr = await f.send("/api/data", { host: f.host, accept: "application/json" });
  assert.equal(xhr.status, 401);
  assert.match(xhr.body, /loginUrl/);
  const signed = await f.complete("owner", "/d/alpha" + path);
  const owner = await f.send(path, { host: f.host, cookie: signed.cookie, accept: "text/html" });
  assert.equal(owner.status, 200);
  assert.equal(f.seen.at(-1)!.path, path);
  assert.equal(f.seen.at(-1)!.headers.cookie, undefined);
  const stranger = await f.complete("stranger");
  const seen = f.seen.length;
  assert.equal((await f.send(path, { host: f.host, cookie: stranger.cookie, accept: "text/html" })).status, 403);
  assert.equal(f.seen.length, seen);
});

test("request access: current scoped identity, exact Origin and denied ACL precede idempotent delivery", async (t) => {
  const f = await fixture(t);
  const signed = await f.complete();
  await f.app.shareDeployment(f.d.id, scopeId("personal", "viewer"), null, { createdBy: "owner" });
  const deliveries: { destination: unknown; text: string; idempotencyKey: string }[] = [];
  f.app.enqueueDelivery = async (input) => {
    deliveries.push(input);
  };
  const denied = await f.send("/consultants", { host: f.host, cookie: signed.cookie, accept: "text/html" });
  assert.equal(denied.status, 403);
  assert.match(denied.body, /Request access/);
  const headers = { host: f.host, cookie: signed.cookie, origin: f.origin };
  for (const origin of ["null", portal, "https://sibling.apps.example.test", ""]) {
    assert.equal((await f.send("/__claw__/request-access", { ...headers, origin }, "POST")).status, 403);
  }
  assert.equal(deliveries.length, 0);
  for (let i = 0; i < 2; i++) assert.equal((await f.send("/__claw__/request-access", headers, "POST")).status, 200);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0]!.idempotencyKey, deliveries[1]!.idempotencyKey);
  assert.match(deliveries[0]!.text, /viewer is asking for access/);
  assert.deepEqual(deliveries[0]!.destination, {
    type: "principal",
    target: "owner",
    audienceScopeId: "personal:owner",
    onBehalfOf: "viewer",
  });
  assert.equal((await f.send("/__claw__/request-access", { host: f.host, origin: f.origin }, "POST")).status, 401);
  await f.identity.deactivate("viewer");
  assert.equal((await f.send("/__claw__/request-access", headers, "POST")).status, 403);
  assert.equal(deliveries.length, 2);
  assert.equal(f.seen.length, 0);
});
