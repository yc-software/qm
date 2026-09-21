import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import type { Run } from "../src/runs/run-store.ts";
import { createProductAnalytics } from "../src/util/product-analytics.ts";

test("disabled analytics makes no requests", async () => {
  let requests = 0;
  const analytics = createProductAnalytics("company", {}, async () => {
    requests += 1;
    return new Response("ok");
  });
  await analytics.appPublished("person", "app", 1);
  await analytics.responseFinished(await humanRun());
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
  await assert.doesNotReject(failing.responseFinished(await humanRun()));
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

test("human run outcomes keep identity and deduplication without response content", async () => {
  const bodies: Record<string, any>[] = [];
  const analytics = createProductAnalytics("company", { apiKey: "token" }, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("ok");
  });
  const run = await humanRun();
  for (const status of ["ok", "silent", "react", "failed"] as const) {
    run.result = { status, reply: "private reply", reason: "secret error https://private.test" };
    await analytics.responseFinished(run);
  }
  await analytics.responseFinished(run);
  assert.deepEqual(
    bodies.map((body) => body.event),
    ["response_completed", "response_completed", "response_completed", "response_failed", "response_failed"],
  );
  assert.equal(bodies[3]!.properties.$insert_id, bodies[4]!.properties.$insert_id);
  assert.equal(bodies[0]!.properties.$insert_id, `company:${run.id}:response_completed`);
  assert.deepEqual(bodies[0]!.properties, {
    distinct_id: JSON.stringify(["company", "person"]),
    company_id: "company",
    $groups: { company: "company" },
    $insert_id: `company:${run.id}:response_completed`,
    $geoip_disable: true,
    surface: "web",
    completion_boundary: "run",
    result_status: "ok",
  });
  assert.doesNotMatch(JSON.stringify(bodies), /private|secret/);
});

test("non-human, stopped and non-completion results do not produce response outcomes", async () => {
  let requests = 0;
  const analytics = createProductAnalytics("company", { apiKey: "token" }, async () => {
    requests++;
    return new Response("ok");
  });
  const run = await humanRun();
  for (const kind of ["automation", "ambient", "direct"] as const) {
    await analytics.responseFinished({ ...run, request: { ...run.request, origin: { kind } } });
  }
  await analytics.responseFinished({ ...run, request: { ...run.request, botActor: true } });
  for (const flag of ["analyticsSuppressed", "proactiveOpener"] as const) {
    for (const status of ["ok", "failed"] as const) {
      await analytics.responseFinished({ ...run, request: { ...run.request, [flag]: true }, result: { status } });
    }
  }
  for (const status of ["queued", "pending_approval", "refused"] as const) {
    await analytics.responseFinished({ ...run, result: { status } });
  }
  for (const status of ["ok", "silent", "failed"] as const) {
    await analytics.responseFinished({ ...run, result: { status, stopped: true } });
  }
  for (const status of ["pending", "running"] as const) {
    await analytics.responseFinished({ ...run, status });
  }
  await analytics.responseFinished({ ...run, result: null });
  assert.equal(requests, 0);
});

test("terminal listener reports only exhausted failures and accepted completions, not retries or stale leases", async () => {
  const events: string[] = [];
  const analytics = createProductAnalytics("company", { apiKey: "token" }, async (_url, init) => {
    events.push(JSON.parse(String(init?.body)).event);
    return new Response("ok");
  });
  const { runs } = createMemoryRunStore();
  runs.onTerminal((run) => {
    return analytics.responseFinished(run);
  });
  const request = (await humanRun()).request;
  const { run } = await runs.enqueue({ sessionId: "thread", request, maxAttempts: 2 });
  let claimed = (await runs.claim("worker", 10_000))!;
  await runs.fail(run.id, claimed.leaseToken!, "private first error");
  assert.deepEqual(events, []);
  claimed = (await runs.claim("worker", 10_000))!;
  assert.equal(await runs.complete(run.id, "stale-lease", { status: "ok" }), false);
  assert.deepEqual(events, []);
  await runs.fail(run.id, claimed.leaseToken!, "private final error");
  assert.deepEqual(events, ["response_failed"]);
  await runs.enqueue({ sessionId: "thread", request });
  claimed = (await runs.claim("worker", 10_000))!;
  await runs.complete(claimed.id, claimed.leaseToken!, { status: "ok" });
  assert.deepEqual(events, ["response_failed", "response_completed"]);
});

async function humanRun(): Promise<Run> {
  const { runs } = createMemoryRunStore();
  const { run } = await runs.enqueue({
    sessionId: "thread",
    request: {
      actor: { id: "person", type: "internal" },
      conversation: { kind: "dm", threadRef: "thread", audience: [] },
      origin: { kind: "human" },
      surface: "web",
      text: "private prompt",
    },
  });
  return { ...run, status: "done", result: { status: "ok" }, finishedAt: Date.now() };
}
