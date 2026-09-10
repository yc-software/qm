import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const calls: Array<{
  method: string;
  path: string;
  dest?: string;
  cookie?: string;
  principal?: string;
  launchOrigin?: string;
}> = [];
let ownerLaunchOrigin: string | undefined;
let lastRange: string | undefined;
const secret = "app-entry-signing-secret-for-local-tests";
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const core = createServer((req, res) => {
  if ((req.url ?? "").startsWith("/v1/deployments/demo/owner-url")) {
    ownerLaunchOrigin = req.headers["x-qm-launch-origin"] as string | undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: `${ownerLaunchOrigin}/app-edit?slug=demo` }));
    return;
  }
  if (!(req.url ?? "").startsWith("/d/")) return void res.writeHead(404).end();
  lastRange = req.headers.range;
  calls.push({
    method: req.method!,
    path: req.url!.replace(/([?&])_sourceAuthNonce=[^&]*/g, "").replace(/\?&/, "?"),
    dest: req.headers["sec-fetch-dest"] as string,
    cookie: req.headers.cookie,
    principal: req.headers["x-as-principal"] as string,
    launchOrigin: req.headers["x-qm-launch-origin"] as string,
  });
  res.writeHead(302, {
    location: "https://app.apps.example.test/",
    "cache-control": "no-store",
    "content-type": "text/plain",
  });
  res.end();
});
process.env.CORE_API_URL = await listen(core);
process.env.CORE_SIGNING_SECRET = secret;
process.env.PORTAL_IDENTITY_SECRET = secret + "-identity";
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
const base = await listen(surface);
const identity = mintPortalIdentity({ p: "alice", exp: Date.now() + 60000 }, secret + "-identity");
test.after(() => {
  surface.closeAllConnections();
  surface.close();
  core.closeAllConnections();
  core.close();
});
function send(
  path: string,
  method = "GET",
  signed = true,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      base + path,
      {
        method,
        headers: {
          ...(signed ? { [PORTAL_IDENTITY_HEADER]: identity } : {}),
          "sec-fetch-dest": "document",
          cookie: "private=never-forward",
          "x-qm-launch-origin": "https://attacker.example",
          ...extraHeaders,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
for (const prefix of ["/d", "/deployments"]) {
  for (const method of ["GET", "HEAD"])
    test(`${method} ${prefix} delegates launch with navigation metadata`, async () => {
      const n = calls.length;
      const response = await send(`${prefix}/demo/page?q=a%20b&x=%2f&x=+&bare&tilde=~`, method);
      assert.equal(response.status, 302);
      assert.equal(response.location, "https://app.apps.example.test/");
      assert.deepEqual(calls.slice(n), [
        {
          method,
          path: "/d/demo/page?q=a%20b&x=%2f&x=+&bare&tilde=~",
          dest: "document",
          cookie: undefined,
          principal: "alice",
          launchOrigin: base,
        },
      ]);
    });
  test(`${prefix} refuses anonymous launches`, async () => {
    const n = calls.length;
    assert.equal((await send(`${prefix}/demo/`, "GET", false)).status, 401);
    assert.equal(calls.length, n);
  });
}

test("Connection-nominated range is not forwarded; nominated body framing fails closed", async () => {
  await send("/d/demo/", "GET", true, { connection: "range", range: "bytes=0-5" });
  assert.equal(lastRange, undefined);
  const n = calls.length;
  assert.equal(
    (await send("/d/demo/", "GET", true, { connection: "content-length", "content-length": "0" })).status,
    400,
  );
  assert.equal(calls.length, n);
});

test("owner editor API rebuilds the same validated initiating origin as app launch", async () => {
  const response = await send("/api/deployments/demo/owner-url");
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).url, "/app-edit?slug=demo");
  assert.equal(ownerLaunchOrigin, base);
});
