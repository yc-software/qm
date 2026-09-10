import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/deploy-hardening-fixture.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { scopeId } from "../src/types.ts";

test("never-shared visitors can request access without gaining any app content or mutation authority", async (t) => {
  const f = await fixture(t);
  const deliveries = createDeliveryStore();
  f.app.enqueueDelivery = async (input) => {
    await deliveries.enqueue(input);
  };
  let reaches = 0;
  const reach = f.app.reachDeployment.bind(f.app);
  f.app.reachDeployment = async (...args) => {
    reaches++;
    return reach(...args);
  };
  const flow = await f.complete("stranger", "/d/alpha/");
  assert.equal(reaches, 0, "identity handoff never warms or reaches the private runtime");
  assert.ok(flow.cookie);
  const denial = await f.send("/", {
    host: f.host,
    cookie: flow.cookie,
    accept: "text/html",
    "sec-fetch-dest": "document",
  });
  assert.equal(denial.status, 403);
  assert.match(denial.body, /Request access/);
  for (const [method, path] of [
    ["GET", "/app.js"],
    ["GET", "/api"],
    ["POST", "/form"],
  ]) {
    assert.equal((await f.send(path!, { host: f.host, cookie: flow.cookie, origin: f.origin }, method)).status, 403);
  }
  assert.equal(
    (
      await f.send(
        "/__claw__/request-access",
        { host: f.host, cookie: flow.cookie, origin: "https://attacker.test" },
        "POST",
      )
    ).status,
    403,
  );
  assert.equal((await f.send("/__claw__/request-access", { host: f.host, origin: f.origin }, "POST")).status, 401);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await f.send("/__claw__/request-access", { host: f.host, cookie: flow.cookie, origin: f.origin }, "POST"))
        .status,
      200,
    );
  const pending = await deliveries.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.destination.target, "owner");
  assert.match(pending[0]!.text, /stranger is asking for access/);
  assert.equal(f.seen.length, 0);
  await f.app.shareDeployment(f.d.id, scopeId("personal", "stranger"), "read", { createdBy: "owner" });
  assert.equal((await f.send("/", { host: f.host, cookie: flow.cookie })).status, 200);
});
