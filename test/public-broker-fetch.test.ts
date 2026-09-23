import assert from "node:assert/strict";
import type { LookupAddress, LookupOptions } from "node:dns";
import { beforeEach, mock, test } from "node:test";
import tls from "node:tls";
import { inspect } from "node:util";
import { Agent as RealAgent, fetch as realFetch, getGlobalDispatcher, Response } from "undici";

const SECRET = "test-provider-key-must-not-leak";
const publicV4 = { address: "93.184.216.34", family: 4 };
const publicV6 = { address: "2606:4700:4700::1111", family: 6 };
const init = { method: "GET", headers: { Authorization: `Bearer ${SECRET}` } };
const agents: RealAgent[] = [];
const agentOptions: RealAgent.Options[] = [];
let transport: typeof realFetch = realFetch;

mock.module("undici", {
  namedExports: {
    Agent: class extends RealAgent {
      constructor(options: RealAgent.Options) {
        super(options);
        agents.push(this);
        agentOptions.push(options);
      }
    },
    fetch: (...args: Parameters<typeof realFetch>) => transport(...args),
  },
});

const { createPublicBrokerFetch, createPublicBrokerLookup, publicBrokerFetch } =
  await import("../src/api/public-broker-fetch.ts");

beforeEach(() => {
  agents.length = 0;
  agentOptions.length = 0;
  transport = realFetch;
});

function runLookup(
  lookup: ReturnType<typeof createPublicBrokerLookup>,
  options: LookupOptions = {},
  hostname = "provider.example",
): Promise<{ address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

function safeError(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.message, "Public broker request failed");
  assert.equal(error.cause, undefined);
  assert.ok(!inspect(error).includes(SECRET));
  return true;
}

const privateAddresses = [
  "0.0.0.0",
  "10.1.2.3",
  "100.100.100.200",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.1.1",
  "198.18.0.1",
  "224.0.0.1",
  "::",
  "::1",
  "fc00::1",
  "fe80::1",
  "ff02::1",
  "::ffff:127.0.0.1",
  "::ffff:a9fe:a9fe",
  "::ffff:10.0.0.1",
];

for (const address of privateAddresses) {
  test(`rejects private DNS answer ${address} alone and mixed with public addresses`, async () => {
    const entry = { address, family: address.includes(":") ? 6 : 4 };
    for (const answers of [[entry], [publicV4, entry], [entry, publicV6]]) {
      const lookup = createPublicBrokerLookup(async () => answers);
      for (const options of [{}, { all: true }, { family: 4 }, { family: 6 }]) {
        await assert.rejects(runLookup(lookup, options), /destination is not allowed/);
      }
    }
  });

  test(`rejects private literal ${address} before creating a connection`, async () => {
    const host = address.includes(":") ? `[${address}]` : address;
    await assert.rejects(publicBrokerFetch(`https://${host}/`, init), safeError);
    assert.equal(agents.length, 0);
  });
}

test("returns validated public IPv4, IPv6 and mapped public IPv6 in single and all modes", async () => {
  for (const entry of [publicV4, publicV6, { address: "::ffff:93.184.216.34", family: 6 }]) {
    const lookup = createPublicBrokerLookup(async (hostname) => {
      assert.equal(hostname, "provider.example");
      return [entry];
    });
    assert.deepEqual(await runLookup(lookup), entry);
    assert.deepEqual(await runLookup(lookup, { all: true }), { address: [entry], family: undefined });
  }
});

test("validates all answers before applying family selection and preserves public answer order", async () => {
  const lookup = createPublicBrokerLookup(async () => [publicV6, publicV4]);
  assert.deepEqual(await runLookup(lookup), publicV6);
  assert.deepEqual(await runLookup(lookup, { all: true }), {
    address: [publicV6, publicV4],
    family: undefined,
  });
  for (const family of [4, "IPv4"] as const) {
    assert.deepEqual(await runLookup(lookup, { family }), publicV4);
  }
  for (const family of [6, "IPv6"] as const) {
    assert.deepEqual(await runLookup(lookup, { family }), publicV6);
  }
  assert.deepEqual(await runLookup(lookup, { all: true, family: 4 }), {
    address: [publicV4],
    family: undefined,
  });
});

test("fails closed for empty, invalid, inconsistent and unavailable DNS answers", async () => {
  for (const answers of [
    [],
    [{ address: "not-an-ip", family: 4 }],
    [{ ...publicV4, family: 6 }],
    [{ ...publicV6, family: 4 }],
    [publicV4, { address: "", family: 0 }],
  ]) {
    await assert.rejects(runLookup(createPublicBrokerLookup(async () => answers)), /destination is not allowed/);
  }
  await assert.rejects(
    runLookup(
      createPublicBrokerLookup(async () => [publicV4]),
      { family: 6 },
    ),
    /destination is not allowed/,
  );
});

test("DNS failures and synchronous resolver throws invoke the callback once without exposing keys", async () => {
  for (const resolve of [
    async (): Promise<LookupAddress[]> => {
      throw new Error(SECRET);
    },
    (): Promise<LookupAddress[]> => {
      throw new Error(SECRET);
    },
  ]) {
    let calls = 0;
    await new Promise<void>((done) => {
      createPublicBrokerLookup(resolve)("provider.example", { all: true }, (error, addresses) => {
        calls++;
        assert.equal(error?.message, "Public broker destination is not allowed");
        assert.ok(!inspect(error).includes(SECRET));
        assert.deepEqual(addresses, []);
        done();
      });
    });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(calls, 1);
  }
});

test("validates HTTPS, userinfo, default port and normalized IP spellings before networking", async () => {
  for (const url of [
    SECRET,
    "http://provider.example/",
    "ftp://provider.example/",
    `https://${SECRET}@provider.example/`,
    `https://user:${SECRET}@provider.example/`,
    "https://provider.example:8443/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://127.1/",
    "https://0177.0.0.1/",
    "https://[::ffff:7f00:1]/",
  ]) {
    await assert.rejects(publicBrokerFetch(url, init), safeError);
  }
  for (const header of ["Host", "host", "hOsT"]) {
    await assert.rejects(
      publicBrokerFetch("https://provider.example/", { ...init, headers: { [header]: SECRET } }),
      safeError,
    );
  }
  assert.equal(agents.length, 0);
});

test("the real socket validates DNS with the URL host and SNI despite inherited proxy routing", async (t) => {
  const connections: tls.ConnectionOptions[] = [];
  const connect = tls.connect;
  t.mock.method(tls, "connect", (options: tls.ConnectionOptions) => {
    connections.push(options);
    return connect(options);
  });
  const inheritedDispatch = t.mock.method(getGlobalDispatcher(), "dispatch", () => {
    throw new Error("Inherited dispatcher must not be used");
  });
  const originalProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://127.0.0.1:1";
  t.after(() => {
    if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalProxy;
  });
  for (const [hostname, answers] of [
    ["localhost", [{ address: "127.0.0.1", family: 4 }]],
    ["metadata.google.internal", [{ address: "169.254.169.254", family: 4 }]],
    ["provider.example", [publicV4, { address: "::1", family: 6 }]],
  ] as const) {
    const calls: string[] = [];
    const fetch = createPublicBrokerFetch(async (host) => {
      assert.equal(agents.length, 1);
      calls.push(host);
      return [...answers];
    });
    await assert.rejects(fetch(`https://${hostname}/`, init), safeError);
    assert.deepEqual(calls, [hostname]);
    assert.equal(connections.at(-1)!.host, hostname);
    assert.equal(connections.at(-1)!.servername, hostname);
    assert.equal(Number(connections.at(-1)!.port), 443);
    assert.equal(connections.at(-1)!.rejectUnauthorized, true);
    assert.equal(connections.at(-1)!.checkServerIdentity, undefined);
    assert.ok(agents[0]!.destroyed);
    agents.length = 0;
  }
  assert.equal(connections.length, 3);
  assert.equal(inheritedDispatch.mock.callCount(), 0);
});

test("rechecks DNS on each new connection and rejects a later private answer", async () => {
  let resolutions = 0;
  const lookup = createPublicBrokerLookup(async () => {
    resolutions++;
    return resolutions === 1 ? [publicV4] : [{ address: "127.0.0.1", family: 4 }];
  });
  assert.deepEqual(await runLookup(lookup), publicV4);
  await assert.rejects(runLookup(lookup), /destination is not allowed/);
  assert.equal(resolutions, 2);
});

test("uses a dedicated direct agent, manual redirects, TLS verification and a whole-request deadline", async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 30_000);
    return controller.signal;
  });
  const originalProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://127.0.0.1:1";
  t.after(() => {
    if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalProxy;
  });
  let requests = 0;
  transport = async (url, options) => {
    requests++;
    assert.equal(String(url), "https://provider.example/resource");
    assert.equal(options?.dispatcher, agents[0]);
    assert.equal(options?.redirect, "manual");
    assert.equal(options?.signal, controller.signal);
    assert.equal(options?.method, "POST");
    assert.equal(options?.body, '{"input":true}');
    assert.deepEqual(options?.headers, init.headers);
    const connection = agentOptions[0]!.connect;
    assert.ok(
      connection && typeof connection === "object" && "rejectUnauthorized" in connection && "lookup" in connection,
    );
    assert.equal(connection.rejectUnauthorized, true);
    assert.equal(connection.timeout, 10_000);
    assert.equal(connection.checkServerIdentity, undefined);
    assert.equal(connection.servername, undefined);
    assert.ok(connection.lookup);
    assert.deepEqual(await runLookup(connection.lookup, { all: true }), {
      address: [publicV4, publicV6],
      family: undefined,
    });
    return new Response("redirect response", {
      status: 302,
      headers: { location: "https://127.0.0.1/", "content-type": "text/plain" },
    });
  };
  const fetch = createPublicBrokerFetch(async () => [publicV4, publicV6]);
  const response = await fetch("https://provider.example:443/resource", {
    ...init,
    method: "POST",
    body: '{"input":true}',
  });
  assert.equal(response.status, 302);
  assert.equal(response.contentType, "text/plain");
  assert.equal(await response.text(), "redirect response");
  assert.equal(requests, 1);
  assert.ok(agents[0]!.destroyed);
});

test("public literal IPv4 and IPv6 URLs remain pinned to their URL host", async () => {
  for (const hostname of [publicV4.address, `[${publicV6.address}]`]) {
    transport = async (url) => {
      assert.equal(new URL(String(url)).hostname, hostname);
      return new Response(null, { status: 204 });
    };
    const response = await publicBrokerFetch(`https://${hostname}/`, init);
    assert.equal(response.status, 204);
    assert.equal(response.contentType, undefined);
    assert.equal(await response.text(), "");
  }
  assert.ok(agents.every((agent) => agent.destroyed));
});

test("consumes the body and destroys the agent even when callers never read text", async () => {
  const upstream = new Response("complete response", { status: 200 });
  transport = async () => upstream;
  const response = await publicBrokerFetch("https://provider.example/", init);
  assert.ok(upstream.bodyUsed);
  assert.ok(agents[0]!.destroyed);
  assert.equal(await response.text(), "complete response");
});

test("request and body failures destroy the agent and hide provider keys", async () => {
  for (const failBody of [false, true]) {
    transport = async () => {
      if (!failBody) throw new Error(SECRET);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(SECRET));
          },
        }),
      );
    };
    await assert.rejects(publicBrokerFetch("https://provider.example/", init), safeError);
    assert.ok(agents.at(-1)!.destroyed);
  }
});

test("the request deadline also covers a stalled response body", async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  transport = async (_url, options) => {
    const response = new Response(
      new ReadableStream({
        start(body) {
          options!.signal!.addEventListener("abort", () => body.error(new Error(SECRET)), { once: true });
        },
      }),
    );
    setImmediate(() => controller.abort());
    return response;
  };
  await assert.rejects(publicBrokerFetch("https://provider.example/", init), safeError);
  assert.ok(agents[0]!.destroyed);
});

test("undici header validation errors never expose raw credentials", async () => {
  await assert.rejects(
    publicBrokerFetch("https://provider.example/", { ...init, headers: { Authorization: `Bearer\n${SECRET}` } }),
    safeError,
  );
  assert.ok(agents[0]!.destroyed);
});

test("oversized responses are cancelled before they can exhaust core memory", async () => {
  let cancelled = false;
  let chunks = 0;
  transport = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          chunks++;
          controller.enqueue(new Uint8Array(1_000_000));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  await assert.rejects(publicBrokerFetch("https://provider.example/", init), safeError);
  assert.ok(cancelled);
  assert.ok(chunks <= 8);
  assert.ok(agents[0]!.destroyed);
});
