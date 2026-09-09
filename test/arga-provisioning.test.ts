import assert from "node:assert/strict";
import { test } from "node:test";
import { provisionSlackTwin, teardownTwin } from "./live-slack/arga.ts";

test("failed Arga provisions are torn down before one fresh retry", async (t) => {
  const requests: Array<{ method: string; path: string }> = [];
  let provisions = 0;
  let teardownRequested = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    requests.push({ method, path });
    if (method === "POST" && path === "/validate/twins/provision") {
      provisions += 1;
      return Response.json({ run_id: `run-${provisions}` });
    }
    if (path === "/validate/twins/provision/run-1/status") {
      return Response.json(
        teardownRequested ? { status: "torn_down" } : { status: "failed", error: "warm VM unavailable" },
      );
    }
    if (path === "/validate/twins/provision/run-1/teardown") {
      teardownRequested = true;
      return Response.json({ status: "tearing_down" });
    }
    if (path === "/validate/twins/provision/run-2/status") {
      return Response.json({
        status: "ready",
        proxy_token: "proxy",
        twins: {
          slack: {
            base_url: "https://slack.test",
            admin_url: "https://admin.test",
            env_vars: { SLACK_BOT_TOKEN: "bot", SLACK_SIGNING_SECRET: "signing" },
          },
        },
      });
    }
    if (String(input) === "https://admin.test/admin/config") {
      return Response.json({});
    }
    throw new Error(`unexpected request: ${method} ${input}`);
  });

  const session = await provisionSlackTwin("key", 60);

  assert.equal(session.runId, "run-2");
  assert.deepEqual(
    requests.filter((request) => request.method === "POST").map((request) => request.path),
    ["/validate/twins/provision", "/validate/twins/provision/run-1/teardown", "/validate/twins/provision"],
  );
});

test("a retry is not started when cleanup cannot be confirmed", async (t) => {
  let provisions = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST" && path === "/validate/twins/provision") {
      provisions += 1;
      return Response.json({ run_id: "run-1" });
    }
    if (path === "/validate/twins/provision/run-1/status") {
      return Response.json({ status: "failed", error: "warm VM unavailable" });
    }
    if (path === "/validate/twins/provision/run-1/teardown") {
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    throw new Error(`unexpected request: ${input}`);
  });

  await assert.rejects(provisionSlackTwin("key", 60), /cleanup could not be confirmed/);
  assert.equal(provisions, 1);
});

test("teardown confirms success after a transient status-read server error", async (t) => {
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "POST") return Response.json({ status: "tearing_down" });
    if (methods.length === 2) return Response.json({}, { status: 500 });
    return Response.json({ status: "torn_down" });
  });
  await teardownTwin("key", "run-1");
  assert.deepEqual(methods, ["POST", "GET", "GET"]);
});

test("teardown still fails when status cannot be confirmed after bounded retries", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ status: "tearing_down" });
    reads++;
    return Response.json({}, { status: 500 });
  });
  await assert.rejects(teardownTwin("key", "run-1"), /500/);
  assert.equal(reads, 3);
});

test("provision requests are not replayed after an ambiguous server error", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({}, { status: 500 });
  });
  await assert.rejects(provisionSlackTwin("key", 60), /500/);
  assert.equal(requests, 1);
});
