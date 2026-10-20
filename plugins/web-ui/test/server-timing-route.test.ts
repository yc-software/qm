import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const core = createServer((req, res) => {
  req.resume();
  req.on("end", () =>
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json", "server-timing": "core-total;dur=42.5" });
      res.end(JSON.stringify({ session: { id: "s1" }, entries: [] }));
    }, 20),
  );
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "server-timing-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));

test.after(() => {
  surface.close();
  core.close();
});

test("the transcript relay times its core hop and forwards core's Server-Timing", async () => {
  const info = mock.method(console, "info", () => {});
  try {
    const response = await fetch(`http://localhost:${(surface.address() as AddressInfo).port}/api/sessions/s1`, {
      headers: {
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
          { p: "alice", exp: Date.now() + 60_000 },
          "server-timing-route-test",
        ),
      },
    });
    assert.equal(response.status, 200);
    await response.json();
    const timing = new Map(
      (response.headers.get("server-timing") ?? "").split(", ").map((part) => {
        const [name, dur] = part.split(";dur=");
        return [name!, Number(dur)];
      }),
    );
    assert.equal(timing.get("core-total"), 42.5);
    assert.ok(timing.get("web-core-headers")! >= 15, `core hop ${timing.get("web-core-headers")}`);
    for (const name of ["web-auth", "web-core-body", "web-loop"]) assert.ok(Number.isFinite(timing.get(name)), name);
    assert.ok(timing.get("web-total")! >= timing.get("web-core-headers")!);
    await new Promise((resolve) => setImmediate(resolve));
    const line = info.mock.calls
      .map((call) => String(call.arguments[0]))
      .find((text) => text.startsWith("[request-timing] "));
    const logged = JSON.parse(line!.slice("[request-timing] ".length)) as Record<string, unknown>;
    assert.equal(logged.hop, "web");
    assert.equal(logged.route, "transcript");
    assert.equal(logged.status, 200);
    assert.equal(typeof logged["core-headers"], "number");
  } finally {
    info.mock.restore();
  }
});
