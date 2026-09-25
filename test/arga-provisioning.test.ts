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

for (const terminal of ["expired", "torn_down"]) {
  test(`Arga cleanup accepts an already ${terminal} twin without another teardown`, async (t) => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests++;
      assert.equal(new URL(String(input)).pathname, "/validate/twins/provision/old-run/status");
      assert.equal(init?.method ?? "GET", "GET");
      return Response.json({ status: terminal });
    });
    await teardownTwin("key", "old-run");
    assert.equal(requests, 1);
  });
}

for (const postFails of [false, true]) {
  test(`Arga cleanup confirms expiry during teardown when POST fails=${postFails}`, async (t) => {
    const methods: string[] = [];
    t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") return Response.json({}, { status: postFails ? 400 : 200 });
      return Response.json({ status: methods.length === 1 ? "ready" : "expired" });
    });
    await teardownTwin("key", "old-run");
    assert.deepEqual(methods, ["GET", "POST", "GET"]);
  });
}

test("Arga cleanup does not interpret missing or unauthorized status as successful recovery", async (t) => {
  for (const status of [401, 404, 503]) {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}, { status }));
    await assert.rejects(teardownTwin("key", "old-run"), new RegExp(String(status)));
    fetchMock.mock.restore();
  }
});
