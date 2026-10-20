import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { withRequestTiming } from "../../chassis/src/server-timing.ts";
import { proxyToSurface } from "../src/proxy.ts";

const upstream = createServer((req, res) => {
  req.resume();
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json", "server-timing": "web-total;dur=12.5" });
    res.end("{}");
  }, 20);
});
await new Promise<void>((resolve) => upstream.listen(0, resolve));

const portal = createServer((req, res) =>
  withRequestTiming("portal", () =>
    setTimeout(
      () =>
        proxyToSurface(req, res, {
          upstreamBase: `http://localhost:${(upstream.address() as AddressInfo).port}`,
          forwardPath: "/api/sessions/s1",
          search: "",
          cookieName: "webuiuser",
          principal: "alice",
        }),
      10,
    ),
  ),
);
await new Promise<void>((resolve) => portal.listen(0, resolve));

test.after(() => {
  portal.close();
  upstream.close();
});

test("the portal reports its own time and its wait on the surface ahead of the surface's timings", async () => {
  const response = await fetch(`http://localhost:${(portal.address() as AddressInfo).port}/api/sessions/s1`);
  await response.text();
  const timing = new Map(
    (response.headers.get("server-timing") ?? "").split(", ").map((part) => {
      const [name, dur] = part.split(";dur=");
      return [name!, Number(dur)];
    }),
  );
  assert.equal(timing.get("web-total"), 12.5);
  assert.ok(timing.get("portal-pre")! >= 8, `portal pre ${timing.get("portal-pre")}`);
  assert.ok(timing.get("portal-upstream")! >= 15, `portal upstream ${timing.get("portal-upstream")}`);
  assert.ok(timing.get("portal-total")! >= timing.get("portal-pre")! + timing.get("portal-upstream")! - 0.2);
});
