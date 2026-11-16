import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { startSlackPlugin, type SlackCoreClient } from "../src/slack/index.ts";
import { withTenant } from "../src/tenants/context.ts";

test("an inactive bot token fails Slack startup without an unhandled rejection", async (t) => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "account_inactive" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  let receiverStops = 0;
  await assert.rejects(
    withTenant("00000000-0000-4000-8000-000000000001", () =>
      startSlackPlugin(
        {
          botToken: "xoxb-inactive",
          apiUrl: `http://127.0.0.1:${address.port}/`,
          coreSingleton: false,
          receiverFactory: () => ({
            init() {},
            async start() {
              throw new Error("receiver must not start with an inactive token");
            },
            async stop() {
              receiverStops++;
            },
          }),
        },
        {
          onScopeModelChanged: () => () => {},
          onChannelHeaderPinChanged: () => () => {},
        } as unknown as SlackCoreClient,
        "00000000-0000-4000-8000-000000000001",
      ),
    ),
    /account_inactive/,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(unhandled, []);
  assert.deepEqual(requests, ["/api/auth.test"]);
  assert.equal(receiverStops, 1);
});
