import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

test(
  "run event streams expose queue transitions and pending heartbeats without model or tool output",
  { timeout: 10_000 },
  async (t) => {
    const now = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now });
    const statuses = ["pending", "pending", "pending", "running", "pending", "running", "done"];
    let reads = 0;
    const core = createServer((req, res) => {
      if (new URL(req.url ?? "", "http://core").pathname !== "/v1/runs/parked") {
        res.writeHead(404);
        res.end();
        return;
      }
      const status = statuses[Math.min(reads++, statuses.length - 1)];
      if (reads === 3) t.mock.timers.setTime(now + 10 * 60_000);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status, result: status === "done" ? { status: "ok", reply: "done" } : null }));
    });
    await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      core.closeAllConnections();
      core.close();
    });
    const secret = "queue-events-test";
    process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
    process.env.CORE_SIGNING_SECRET = secret;
    process.env.WEB_UI_PRINCIPALS = "alice";
    const { handler } = await import("../server/index.ts");
    const surface = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      surface.closeAllConnections();
      surface.close();
    });
    const response = await fetch(`http://127.0.0.1:${(surface.address() as AddressInfo).port}/api/runs/parked/events`, {
      headers: {
        cookie: "webuiuser=alice",
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, secret),
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    const events = await response.text();
    const changes = [...events.matchAll(/event: status\ndata: (.+)/g)].map((match) => JSON.parse(match[1]!).status);
    assert.deepEqual(changes, ["pending", "pending", "running", "pending", "running"]);
    assert.match(events, /event: done\ndata: .*"reply":"done"/);
    assert.doesNotMatch(events, /event: activity|event: partial|event: failed/);
  },
);
