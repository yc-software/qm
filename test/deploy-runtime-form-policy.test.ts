import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/deploy-hardening-fixture.ts";

test("app runtime preserves native form Origin while token handoffs never send referrers", async (t) => {
  const f = await fixture(t);
  const flow = await f.complete();
  for (const response of [flow.initial, flow.start, flow.ticket, flow.done])
    assert.equal(response.headers["referrer-policy"], "no-referrer");
  const runtime = await f.send("/", { host: f.host, cookie: flow.cookie });
  assert.equal(runtime.status, 200);
  assert.equal(runtime.headers["referrer-policy"], "same-origin");
  assert.equal(
    (await f.send("/form", { host: f.host, cookie: flow.cookie, origin: "null" }, "POST", "x=1")).status,
    403,
  );
  assert.equal(
    (await f.send("/form", { host: f.host, cookie: flow.cookie, origin: f.origin }, "POST", "x=1")).status,
    200,
  );
});
