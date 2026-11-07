import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  addressGuardedFetch,
  isPrivateNetworkIp,
  PrivateNetworkAddressError,
  publicFetch,
} from "../src/util/network.ts";
import { createMcpClient } from "../src/mcp/mcp-client.ts";
import { discoverOAuth } from "../src/mcp/oauth-discovery.ts";
import { exchangeCode, setPublicOAuthClients } from "../src/connectors/oauth.ts";
import { errMessage } from "../src/util/errors.ts";
import { sleep } from "../src/util/async.ts";

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
  const form = new FormData();
  form.set("field", "value");
  const multipart = await loopback(`${base}/echo`, { method: "POST", body: form });
  const { type, body } = (await multipart.json()) as { type: string; body: string };
  assert.match(type, /^multipart\/form-data; boundary=/);
  assert.match(body, /name="field"\r\n\r\nvalue\r\n/);
  assert.equal((await loopback(`${base}/empty`)).status, 204);
  assert.equal((await loopback(`${base}/moved`)).status, 302);
  await assert.rejects(loopback(`${base}/moved`, { redirect: "error" }), (e: unknown) =>
    /unexpected redirect/.test(errMessage(e)),
  );
});

test("address-guarded fetch follows redirects when asked, re-checks every hop, and keeps credentials on their origin", async (t) => {
  const log: string[] = [];
  const cdn = await listen(t, (req, res) => {
    log.push(`cdn ${req.method} ${req.headers.authorization ?? "-"}`);
    res.writeHead(200, { "content-type": "image/png" }).end("png");
  });
  const files = await listen(t, (req, res) => {
    log.push(`files ${req.method} ${req.url} ${req.headers.authorization ?? "-"}`);
    const next: Record<string, string> = {
      "/private": "/signed",
      "/signed": `http://127.0.0.1:${cdn.port}/image.png`,
      "/metadata": "http://169.254.169.254/latest/meta-data/",
    };
    res.writeHead(302, { location: next[req.url ?? ""] }).end();
  });
  const guarded = addressGuardedFetch((ip) => ip !== "127.0.0.1" && isPrivateNetworkIp(ip));
  const base = `http://127.0.0.1:${files.port}`;

  const image = await guarded(`${base}/private`, { headers: { authorization: "Bearer t" }, redirect: "follow" });
  assert.equal(image.status, 200);
  assert.equal(await image.text(), "png");
  assert.deepEqual(log, ["files GET /private Bearer t", "files GET /signed Bearer t", "cdn GET -"]);

  await assert.rejects(guarded(`${base}/metadata`, { redirect: "follow" }), PrivateNetworkAddressError);
});

test("address-guarded fetch keeps a body the caller reads after garbage collection", async (t) => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const slow = await listen(t, (_req, res) => {
    res.writeHead(200).write("a");
    setTimeout(() => res.end("b"), 200);
  });
  const response = await addressGuardedFetch(() => false)(`http://127.0.0.1:${slow.port}/`);
  for (let i = 0; i < 10; i++) {
    gc();
    await sleep(20);
  }
  assert.equal(await response.text(), "ab");
});

test("address-guarded fetch gives up on an endpoint that never answers", async (t) => {
  const silent = await listen(t, () => undefined);
  const impatient = addressGuardedFetch(() => false, { timeoutMs: 100 });
  await assert.rejects(impatient(`http://127.0.0.1:${silent.port}/`), (e: unknown) =>
    /Headers Timeout/.test(errMessage(e)),
  );
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
