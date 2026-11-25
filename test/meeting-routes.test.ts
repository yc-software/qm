import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { App } from "../src/api/app-types.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { createServer } from "../src/api/server.ts";
import { browserImpersonationCookie, browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

test("the desktop recorder stays off until the person's flag is on, and while impersonating", async (t) => {
  const flagged = new Set<string>();
  const server = createServer(
    {} as App,
    {
      signingSecret: "meeting-route-signing-secret-0123456789",
      replayDedupe: { claim: async () => true },
      ...browserSessionDeps,
      admin: { adminStatusOf: async () => ({ isAdmin: true }) },
      featureFlags: { enabled: async (name: string, scope: string) => flagged.has(`${name}:${scope}`) },
    } as unknown as ServerDeps,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = browserSessionCookie("alice");
  const check = async (as: string) => (await fetch(`${base}/api/meetings`, { headers: { cookie: as } })).json();
  assert.deepEqual(await check(cookie), { enabled: false, user: null });
  flagged.add("meeting_recorder:personal:alice");
  assert.deepEqual(await check(cookie), { enabled: true, user: "alice" });
  assert.deepEqual(await check(`${cookie}; ${browserImpersonationCookie("alice", "bob")}`), {
    enabled: false,
    user: null,
  });
});
