import assert from "node:assert/strict";
import test from "node:test";
import { quickTunnelUrl } from "../cli/src/util.ts";

const announcement = [
  "2026-10-10T08:00:01Z INF +--------------------------------------------------------------------------------------------+",
  "2026-10-10T08:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
  "2026-10-10T08:00:01Z INF |  https://quiet-harbor-sail-anchor.trycloudflare.com                                        |",
  "2026-10-10T08:00:01Z INF +--------------------------------------------------------------------------------------------+",
];

test("the quick tunnel URL is the one cloudflared announces, not one quoted in an earlier error", () => {
  const log = [
    '2026-10-10T08:00:00Z ERR Error unmarshaling QuickTunnel response: error="failed to request quick Tunnel: Post \\"https://api.trycloudflare.com/tunnel\\": EOF"',
    ...announcement,
  ].join("\n");
  assert.equal(quickTunnelUrl(log), "https://quiet-harbor-sail-anchor.trycloudflare.com");
  assert.equal(quickTunnelUrl(log.split("\n")[0]!), undefined);
});
