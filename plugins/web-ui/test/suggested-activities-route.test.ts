import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const activities = [
  { id: "app", title: "Build a home for my projects", prompt: "Build a private project tracker.", icon: "app" },
];
const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "suggestions-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.WEB_UI_SUGGESTED_ACTIVITIES = JSON.stringify(activities);
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("only signed-in users receive configured suggestions", async () => {
  const anonymous = await fetch(`${base}/me`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).suggestedActivities, undefined);
  const signedIn = await fetch(`${base}/me`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(signedIn.status, 200);
  assert.deepEqual((await signedIn.json()).suggestedActivities, activities);
});
