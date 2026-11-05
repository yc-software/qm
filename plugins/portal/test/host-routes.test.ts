import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHostRoutes } from "../src/host-routes.ts";

const alpha = "00000000-0000-4000-8000-00000000000a";

function routes() {
  const pages: Array<[number, string]> = [];
  const hosts = createHostRoutes({
    publicUrl: "https://mt.qm.example.test",
    appsDomain: "apps.example.test",
    lookup: async (host) => (host === "alpha.qm.example.test" ? { tenant: alpha } : null),
    handoffKey: Buffer.alloc(32, 1),
    claim: async () => true,
    session: () => null,
    signOut: () => undefined,
    signIn: () => undefined,
    signInApp: () => undefined,
    page: (_res, status, html) => void pages.push([status, html]),
    errorHtml: (detail) => detail,
    unavailable: () => undefined,
  });
  const resolve = (host: string, url = "/") =>
    hosts.resolve({ headers: { host }, url } as IncomingMessage, {} as ServerResponse);
  return { resolve, pages };
}

test("a sibling hostname with no company says so instead of starting a sign-in that cannot finish", async () => {
  const { resolve, pages } = routes();
  assert.equal(await resolve("nosuchco.qm.example.test"), null);
  assert.deepEqual(pages, [[404, "unknown workspace address"]]);
});

test("the shared host, app hosts, other domains and health checks stay unmapped, and a company host maps", async () => {
  const { resolve, pages } = routes();
  for (const host of ["mt.qm.example.test", "x.apps.example.test", "elsewhere.test", "10.0.0.1:3000", "localhost:3000"])
    assert.equal(await resolve(host), undefined);
  assert.equal(await resolve("nosuchco.qm.example.test", "/healthz"), undefined);
  assert.equal((await resolve("alpha.qm.example.test"))?.tenant, alpha);
  assert.deepEqual(pages, []);
});
