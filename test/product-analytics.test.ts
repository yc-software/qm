import test from "node:test";
import assert from "node:assert/strict";
import { createProductAnalytics } from "../src/util/product-analytics.ts";

test("disabled analytics makes no requests", async () => {
  let requests = 0;
  const analytics = createProductAnalytics("company", {}, async () => {
    requests += 1;
    return new Response("ok");
  });
  await analytics.appPublished("person", "app", 1);
  assert.equal(requests, 0);
});

test("publication has matching company identity, groups and deduplication without app content", async () => {
  let body: Record<string, any> = {};
  const analytics = createProductAnalytics("company", { apiKey: "public-token" }, async (url, init) => {
    assert.equal(url, "https://us.i.posthog.com/i/v0/e/");
    assert.equal(init?.redirect, "error");
    body = JSON.parse(String(init?.body));
    return new Response("ok");
  });
  await analytics.appPublished("person", "app", 2);
  assert.equal(body.event, "app_published");
  assert.equal(body.properties.distinct_id, JSON.stringify(["company", "person"]));
  assert.deepEqual(body.properties.$groups, { company: "company" });
  assert.equal(body.properties.$insert_id, "app:2:app_published");
  assert.deepEqual(
    Object.keys(body.properties).sort(),
    ["distinct_id", "company_id", "$groups", "$insert_id", "$geoip_disable", "surface"].sort(),
  );
});

test("delivery failures cannot fail publication and concurrent requests are bounded", async () => {
  const failing = createProductAnalytics("company", { apiKey: "token" }, async () => {
    throw Error("offline");
  });
  await assert.doesNotReject(failing.appPublished("person", "app", 1));
  const releases: Array<() => void> = [];
  const bounded = createProductAnalytics("company", { apiKey: "token" }, async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response("ok");
  });
  const requests = Array.from({ length: 20 }, () => bounded.appPublished("person", "app", 1));
  assert.equal(releases.length, 16);
  releases.forEach((release) => release());
  await Promise.all(requests);
});
