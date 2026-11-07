import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import {
  addressGuardedFetch,
  configurePublicFetch,
  createPublicFetch,
  isNeverAllowedIp,
  parsePrivateNetworkOrigins,
  PrivateNetworkAddressError,
  publicFetch,
} from "../src/util/network.ts";
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
  const strict =
    /127\.0\.0\.1 is a private network address; a deployment operator can allow this exact origin with PRIVATE_NETWORK_ALLOWED_ORIGINS/;
  await assert.rejects(createMcpClient({ url: `${base}/mcp`, auth: { mode: "none" } }).listTools(), (e: unknown) =>
    strict.test(errMessage(e)),
  );
  const discovered = await discoverOAuth(new URL(`${base}/mcp`));
  assert.match(discovered.errors.join("; "), strict);
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

test("the never-allow list covers loopback, unspecified, link-local and metadata addresses in every spelling", () => {
  for (const ip of [
    "127.0.0.1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "169.254.170.2",
    "0.0.0.0",
    "::",
    "::1",
    "fe80::1",
    "fd00:ec2::254",
    "100.100.100.100",
    "100.100.100.200",
    "64:ff9b::6464:64c8",
  ])
    assert.equal(isNeverAllowedIp(ip), true, ip);
  for (const ip of ["10.0.12.7", "172.18.0.4", "192.168.1.1", "100.101.102.103", "fdaa:0:1::3", "64:ff9b:1::a9fe:a9fe"])
    assert.equal(isNeverAllowedIp(ip), false, ip);
});

test("PRIVATE_NETWORK_ALLOWED_ORIGINS parses to normalized exact origins", () => {
  assert.equal(parsePrivateNetworkOrigins(undefined).size, 0);
  assert.equal(parsePrivateNetworkOrigins(" , ").size, 0);
  assert.deepEqual(
    [
      ...parsePrivateNetworkOrigins(
        " HTTP://GBrain.:8787 ,http://gbrain:8787,https://brain.example-tailnet.ts.net:443/,http://10.0.12.7:80,,http://[FDAA:0:1::3]:8080",
      ),
    ],
    ["http://gbrain:8787", "https://brain.example-tailnet.ts.net", "http://10.0.12.7", "http://[fdaa:0:1::3]:8080"],
  );
});

test("PRIVATE_NETWORK_ALLOWED_ORIGINS refuses a bad entry by position and origin, never echoing the raw value", () => {
  for (const [entry, reason] of [
    ["not a url secret", /entry 2 is not a valid URL \(value not shown\)/],
    ["ftp://secret.example", /entry 2 is not an http:\/\/ or https:\/\/ origin \(value not shown\)/],
    ["http://admin:secret@gbrain:8787", /entry 2 \(http:\/\/gbrain:8787\) carries credentials/],
    ["http://gbrain:8787/secret", /entry 2 \(http:\/\/gbrain:8787\) has a path, query or fragment/],
    ["http://gbrain:8787/?", /entry 2 \(http:\/\/gbrain:8787\) has a path, query or fragment/],
    ["http://gbrain:8787?secret", /entry 2 \(http:\/\/gbrain:8787\) has a path, query or fragment/],
    ["http://gbrain:8787#secret", /entry 2 \(http:\/\/gbrain:8787\) has a path, query or fragment/],
    [
      "http://localhost:8787",
      /entry 2 \(http:\/\/localhost:8787\) is a loopback, link-local or cloud metadata address/,
    ],
    ["http://localhost.:8787", /entry 2 \(http:\/\/localhost:8787\) is a loopback/],
    ["http://brain.localhost", /entry 2 \(http:\/\/brain\.localhost\) is a loopback/],
    ["http://127.1:8787", /entry 2 \(http:\/\/127\.0\.0\.1:8787\) is a loopback/],
    ["http://[::1]", /entry 2 \(http:\/\/\[::1\]\) is a loopback/],
    ["http://[::ffff:127.0.0.1]", /entry 2 \(http:\/\/\[::ffff:7f00:1\]\) is a loopback/],
    ["http://0.0.0.0:8787", /entry 2 \(http:\/\/0\.0\.0\.0:8787\) is a loopback/],
    ["http://169.254.169.254", /entry 2 \(http:\/\/169\.254\.169\.254\) is a loopback/],
    ["http://[64:ff9b::a9fe:a9fe]", /entry 2 \(http:\/\/\[64:ff9b::a9fe:a9fe\]\) is a loopback/],
    ["http://100.100.100.200", /entry 2 \(http:\/\/100\.100\.100\.200\) is a loopback/],
    ["http://metadata.google.internal", /entry 2 \(http:\/\/metadata\.google\.internal\) is a loopback/],
  ] as const) {
    let message = "";
    assert.throws(
      () => parsePrivateNetworkOrigins(`http://gbrain:9090,${entry}`),
      (e: unknown) => {
        message = errMessage(e);
        return reason.test(message);
      },
      entry,
    );
    assert.doesNotMatch(message, /secret|admin/, entry);
  }
});

test("a listed origin still refuses a name that resolves to loopback, at dial time", async (t) => {
  const target = await listen(t, (_req, res) => res.end("secret"));
  const fetchListed = createPublicFetch(new Set([`http://localhost:${target.port}`]));
  await assert.rejects(fetchListed(`http://localhost:${target.port}/`), (e: unknown) => {
    assert.ok(e instanceof PrivateNetworkAddressError);
    assert.match(
      errMessage(e),
      /^localhost resolves to a loopback, link-local or cloud metadata address, which PRIVATE_NETWORK_ALLOWED_ORIGINS never allows; point it at the service's own address$/,
    );
    return true;
  });
  assert.equal(target.hits(), 0);
});

test("only the exact listed origin gets the private-network allowance", async (t) => {
  const target = await listen(t, (req, res) => {
    if (req.url === "/moved") return void res.writeHead(302, { location: `http://127.0.0.1:${other.port}/` }).end();
    res.end("listed");
  });
  const other = await listen(t, (_req, res) => res.end("unlisted"));
  const listedOrigin = `http://127.0.0.1:${target.port}`;
  const allowLoopback = createPublicFetch(new Set([listedOrigin]), () => false);
  assert.equal(await (await allowLoopback(`${listedOrigin}/`)).text(), "listed");
  await assert.rejects(allowLoopback(`http://localhost:${target.port}/`), (e: unknown) =>
    /^localhost resolves to a private network address; a deployment operator can allow this exact origin with PRIVATE_NETWORK_ALLOWED_ORIGINS$/.test(
      errMessage(e),
    ),
  );
  await assert.rejects(allowLoopback(`http://127.0.0.1:${other.port}/`), PrivateNetworkAddressError);
  await assert.rejects(allowLoopback(`${listedOrigin}/moved`, { redirect: "error" }), /redirect from .* refused/);
  const unfollowed = await allowLoopback(`${listedOrigin}/moved`);
  assert.equal(unfollowed.status, 302);
  assert.equal(target.hits(), 3);
  assert.equal(other.hits(), 0);
});

test("the configured public fetch is the default for MCP clients, discovery and token exchange", async (t) => {
  const target = await listen(t, (_req, res) => res.writeHead(500).end());
  t.after(() => configurePublicFetch(new Set()));
  configurePublicFetch(new Set([`http://localhost:${target.port}`]));
  const neverAllowed =
    /localhost resolves to a loopback, link-local or cloud metadata address, which PRIVATE_NETWORK_ALLOWED_ORIGINS never allows/;
  await assert.rejects(
    createMcpClient({ url: `http://localhost:${target.port}/mcp`, auth: { mode: "none" } }).listTools(),
    (e: unknown) => neverAllowed.test(errMessage(e)),
  );
  const discovered = await discoverOAuth(new URL(`http://localhost:${target.port}/mcp`));
  assert.match(discovered.errors.join("; "), neverAllowed);
  t.after(() => setPublicOAuthClients([]));
  setPublicOAuthClients([
    {
      name: "internal-crm",
      host: "crm.example.com",
      authUrl: "https://crm.example.com/authorize",
      tokenUrl: `http://localhost:${target.port}/token`,
      scopes: [],
      clientId: "public-client",
      label: "CRM",
    },
  ]);
  await assert.rejects(
    exchangeCode("internal-crm", "code", "https://qm.example/cb", {
      client: { id: "public-client", secret: "", clientRef: "public:internal-crm" },
    }),
    (e: unknown) => e instanceof PrivateNetworkAddressError && neverAllowed.test(errMessage(e)),
  );
  assert.equal(target.hits(), 0);
});
