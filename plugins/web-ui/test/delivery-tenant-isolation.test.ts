import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const SECRET = "delivery-tenant-isolation-test";
const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";
const multiHosts = new Set(["multi.example"]);
const core = createServer((req: IncomingMessage, res) => {
  req.resume();
  const host = decodeURIComponent((req.url ?? "").split("?")[0]?.split("/").at(-1) ?? "");
  if ((req.url ?? "").startsWith("/v1/operator/hosts/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tenant: null, multi: multiHosts.has(host) }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.PORTAL_IDENTITY_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler, forwardSessionState } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const port = (surface.address() as AddressInfo).port;

test.after(() => {
  surface.close();
  core.close();
});

function openStream(host: string, tenant?: string): Promise<{ next: () => Promise<string>; close: () => void }> {
  const identity = mintPortalIdentity(
    { p: "alice", exp: Date.now() + 60_000, ...(tenant ? { t: tenant } : {}) },
    SECRET,
  );
  return new Promise((resolve, reject) => {
    const req = get(
      { port, path: "/api/deliveries/events", headers: { host, [PORTAL_IDENTITY_HEADER]: identity } },
      (res) => {
        const chunks: string[] = [];
        const waiters: Array<(chunk: string) => void> = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          const waiter = waiters.shift();
          if (waiter) waiter(chunk);
          else chunks.push(chunk);
        });
        const next = () =>
          new Promise<string>((done) => {
            const queued = chunks.shift();
            if (queued !== undefined) done(queued);
            else waiters.push(done);
          });
        void next().then(() => resolve({ next, close: () => req.destroy() }));
      },
    );
    req.on("error", reject);
  });
}

function nextWithin(stream: { next: () => Promise<string> }, ms: number): Promise<string | null> {
  return Promise.race([stream.next(), new Promise<null>((done) => setTimeout(() => done(null), ms).unref())]);
}

test("an unbound connection receives nothing once more than one tenant exists", async () => {
  const stream = await openStream("multi.example");
  forwardSessionState({ threadRef: "web:alice:one", state: "running", participants: ["alice"], tenantId: TENANT_A });
  assert.equal(await nextWithin(stream, 300), null);
  stream.close();
});

test("an unbound connection still receives notices on a single-tenant deployment", async () => {
  const stream = await openStream("single.example");
  forwardSessionState({ threadRef: "web:alice:two", state: "running", participants: ["alice"], tenantId: TENANT_A });
  assert.match((await nextWithin(stream, 2_000)) ?? "", /event: session_state/);
  stream.close();
});

test("a bound connection receives only its own tenant's notices", async () => {
  const stream = await openStream("multi.example", TENANT_A);
  forwardSessionState({ threadRef: "web:alice:three", state: "running", participants: ["alice"], tenantId: TENANT_B });
  forwardSessionState({ threadRef: "web:alice:four", state: "running", participants: ["alice"], tenantId: TENANT_A });
  assert.match((await nextWithin(stream, 2_000)) ?? "", /web:alice:four/);
  stream.close();
});
