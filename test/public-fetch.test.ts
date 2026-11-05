import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { addressGuardedFetch, PrivateNetworkAddressError, publicFetch } from "../src/util/network.ts";
import { createMcpClient } from "../src/mcp/mcp-client.ts";
import { discoverOAuth } from "../src/mcp/oauth-discovery.ts";
import { exchangeCode, setPublicOAuthClients } from "../src/connectors/oauth.ts";
import { errMessage } from "../src/util/errors.ts";

async function listen(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

test("publicFetch refuses loopback, link-local, private, and unspecified address literals", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://0.0.0.0/",
    "http://[::]/",
    "http://2130706433/",
    "http://[64:ff9b::a9fe:a9fe]/",
  ]) {
    await assert.rejects(publicFetch(url), PrivateNetworkAddressError, url);
  }
});

test("publicFetch checks the address a hostname resolves to before connecting", async (t) => {
  const target = await listen(t, (_req, res) => res.end("secret"));
  await assert.rejects(publicFetch(`http://localhost:${target.port}/`), (e: unknown) =>
    /localhost resolves to a private network address/.test(errMessage(e)),
  );
  const seen: string[] = [];
  const recording = addressGuardedFetch((ip) => {
    seen.push(ip);
    return false;
  });
  assert.equal(await (await recording(`http://localhost:${target.port}/`)).text(), "secret");
  assert.ok(seen.length > 0 && seen.every((ip) => isIP(ip) !== 0), seen.join(","));
  assert.equal(target.hits(), 1);
});

test("address-guarded fetch sends bodies and headers and returns status, headers, and streamed bodies", async (t) => {
  const target = await listen(t, (req, res) => {
    if (req.url === "/empty") return void res.writeHead(204).end();
    if (req.url === "/moved") return void res.writeHead(302, { location: "/elsewhere" }).end();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json", "x-seen": String(req.headers["x-probe"]) });
      res.end(
        JSON.stringify({
          method: req.method,
          type: req.headers["content-type"],
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  const loopback = addressGuardedFetch(() => false);
  const base = `http://127.0.0.1:${target.port}`;
  const posted = await loopback(`${base}/echo`, {
    method: "POST",
    headers: { "x-probe": "1" },
    body: new URLSearchParams({ a: "b" }),
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.headers.get("x-seen"), "1");
  assert.deepEqual(await posted.json(), {
    method: "POST",
    type: "application/x-www-form-urlencoded;charset=UTF-8",
    body: "a=b",
  });
  assert.equal((await loopback(`${base}/empty`)).status, 204);
  assert.equal((await loopback(`${base}/moved`)).status, 302);
  await assert.rejects(loopback(`${base}/moved`, { redirect: "error" }), /redirect from .* refused/);
});

test("address-guarded fetch gives up on an endpoint that never answers", async (t) => {
  const silent = await listen(t, () => undefined);
  const impatient = addressGuardedFetch(() => false, { timeoutMs: 100 });
  await assert.rejects(impatient(`http://127.0.0.1:${silent.port}/`), /timed out/);
});

test("MCP clients, OAuth discovery, and OAuth token exchange refuse private network endpoints by default", async (t) => {
  const target = await listen(t, (_req, res) => res.writeHead(500).end());
  const base = `http://127.0.0.1:${target.port}`;
  await assert.rejects(createMcpClient({ url: `${base}/mcp`, auth: { mode: "none" } }).listTools(), (e: unknown) =>
    /private network address/.test(errMessage(e)),
  );
  const discovered = await discoverOAuth(new URL(`${base}/mcp`));
  assert.match(discovered.errors.join("; "), /127\.0\.0\.1 is a private network address/);
  t.after(() => setPublicOAuthClients([]));
  setPublicOAuthClients([
    {
      name: "internal-crm",
      host: "crm.example.com",
      authUrl: "https://crm.example.com/authorize",
      tokenUrl: `${base}/token`,
      scopes: [],
      clientId: "public-client",
      label: "CRM",
    },
  ]);
  await assert.rejects(
    exchangeCode("internal-crm", "code", "https://qm.example/cb", {
      client: { id: "public-client", secret: "", clientRef: "public:internal-crm" },
    }),
    PrivateNetworkAddressError,
  );
  assert.equal(target.hits(), 0);
});
