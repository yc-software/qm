import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { SlackClient } from "./live-slack/slack.ts";
import { CoreClient } from "./live-slack/core.ts";

for (const status of [429, 500]) {
  test(`Slack qualification fails promptly on HTTP ${status} without hidden retries`, async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(status, { "content-type": "application/json", "retry-after": "3600" });
      res.end(JSON.stringify({ ok: false, error: "qualification-test" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const client = new SlackClient("synthetic-token", `http://127.0.0.1:${address.port}`);
      await assert.rejects(client.authTest());
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("Core qualification request deadline aborts a stalled provider request", async () => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const core = new CoreClient(`http://127.0.0.1:${address.port}`, "synthetic-secret");
    await assert.rejects(core.withSignal(AbortSignal.timeout(50)).listSandboxes("channel:test"), /timeout|abort/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function withMembershipServer(
  response: (path: string) => { status?: number; body: unknown },
  run: (core: CoreClient) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    assert.ok(req.headers["x-signature"]);
    const { status = 200, body } = response(new URL(req.url!, "http://localhost").pathname);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(new CoreClient(`http://127.0.0.1:${address.port}`, "synthetic-secret"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const principal of ["qa@example.com", "UQA"]) {
  test(`membership readiness waits for the exact QA identity ${principal} and persisted roster`, async () => {
    let resolutions = 0;
    let memberships = 0;
    await withMembershipServer(
      (path) => {
        if (path === "/v1/directory/resolve") {
          resolutions++;
          return { body: { matches: resolutions === 1 ? [] : [{ principalId: principal, slackId: "UQA" }] } };
        }
        assert.equal(path, `/v1/directory/channels/CNEW/members/${encodeURIComponent(principal)}`);
        return { body: { member: ++memberships === 2 } };
      },
      (core) => core.waitForChannelMembership("CNEW", "UQA", 5000),
    );
    assert.equal(resolutions, 3);
    assert.equal(memberships, 2);
  });
}

for (const body of [
  {},
  { matches: [{ principalId: "other", slackId: "UOTHER" }] },
  { matches: [{ principalId: "UQA" }, { principalId: "UQA" }] },
]) {
  test(`membership readiness rejects malformed or mismatched identity ${JSON.stringify(body)}`, async () => {
    let requests = 0;
    await withMembershipServer(
      () => {
        requests++;
        return { body };
      },
      (core) => assert.rejects(core.waitForChannelMembership("CNEW", "UQA"), /directory/),
    );
    assert.equal(requests, 1);
  });
}

for (const failure of [{ status: 403, body: {} }, { body: {} }, { body: { member: "true" } }]) {
  test(`membership readiness fails promptly on an invalid roster response ${JSON.stringify(failure)}`, async () => {
    let requests = 0;
    await withMembershipServer(
      (path) => {
        requests++;
        return path === "/v1/directory/resolve" ? { body: { matches: [{ principalId: "UQA" }] } } : failure;
      },
      (core) => assert.rejects(core.waitForChannelMembership("CNEW", "UQA")),
    );
    assert.equal(requests, 2);
  });
}

test("membership readiness has one deadline including unresolved identity and inherits cancellation", async () => {
  await withMembershipServer(
    () => ({ body: { matches: [] } }),
    async (core) => {
      await assert.rejects(core.waitForChannelMembership("CNEW", "UQA", 30), /readiness.*UQA.*CNEW/);
      await assert.rejects(
        core.withSignal(AbortSignal.timeout(30)).waitForChannelMembership("CNEW", "UQA"),
        /readiness.*UQA.*CNEW/,
      );
    },
  );
});
