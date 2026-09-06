import assert from "node:assert/strict";
import { test } from "node:test";
import { provisionSlackTwin } from "./live-slack/arga.ts";

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
