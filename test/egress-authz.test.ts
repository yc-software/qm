import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import {
  buildEgressAuthzServer,
  createRelayAuditSink,
  tokenFromRequest,
  hostFromAuthority,
  isBlockedDestinationIp,
  type EgressAuthzDeps,
} from "../src/egress-authz-main.ts";
import { verifySignature } from "../src/auth/source-auth.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import type { EgressAuditRecord } from "../src/admin/egress-audit-sink.ts";
import { scopeId, type EgressPolicy } from "../src/types.ts";
import { canonicalPayload } from "../plugins/chassis/src/source-auth-sign.ts";
import { withTenant } from "../src/tenants/context.ts";
import { bindTestTenant, OTHER_TENANT, TEST_TENANT } from "./support/tenant.ts";

bindTestTenant();

const CAPABILITY_SECRET = "test-egress-capability-secret";
const SOURCE_SECRET = "test-egress-source-secret";
const listen = (s: Server): Promise<number> =>
  new Promise((r) => s.listen(0, () => r((s.address() as AddressInfo).port)));
const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

function recordingSink() {
  const records: Omit<EgressAuditRecord, "ts">[] = [];
  const tenants: (string | undefined)[] = [];
  const record = (s: Omit<EgressAuditRecord, "ts">, tenant?: string) => {
    records.push(s);
    tenants.push(tenant);
  };
  return { records, tenants, sink: { record } };
}

function egressToken(
  egress: EgressPolicy | undefined,
  over: { aud?: string; exp?: number; secret?: string } = {},
): Promise<string> {
  return mintCapabilityToken(
    {
      actorId: "U_actor",
      scopeId: scopeId("personal", "U_actor"),
      aud: over.aud ?? EGRESS_PROXY_AUD,
      exp: over.exp ?? Date.now() + 60_000,
      ...(egress ? { egress } : {}),
    },
    over.secret ?? CAPABILITY_SECRET,
  );
}

function check(port: number, authority: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        port,
        host: "127.0.0.1",
        path: "/",
        headers: { "x-egress-authority": authority, ...(token ? { "proxy-authorization": `Bearer ${token}` } : {}) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function checkWithHeaders(
  port: number,
  authority: string,
  token?: string,
): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        port,
        host: "127.0.0.1",
        path: "/",
        headers: { "x-egress-authority": authority, ...(token ? { "proxy-authorization": `Bearer ${token}` } : {}) },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function boot(deps: Partial<EgressAuthzDeps> = {}) {
  const { records, tenants, sink } = recordingSink();
  const server = buildEgressAuthzServer({
    capabilitySecret: CAPABILITY_SECRET,
    audit: sink,
    lookup: async () => ["93.184.216.34"],
    ...deps,
  });
  return { server, records, tenants };
}

test("tokenFromRequest parses Proxy-Authorization Bearer/Basic; ignores Authorization", () => {
  const basic = Buffer.from("agent:tok-123").toString("base64");
  assert.equal(tokenFromRequest({ headers: { "proxy-authorization": "Bearer tok-abc" } } as never), "tok-abc");
  assert.equal(tokenFromRequest({ headers: { "proxy-authorization": `Basic ${basic}` } } as never), "tok-123");
  assert.equal(tokenFromRequest({ headers: { authorization: "Bearer tok-hdr" } } as never), null);
  assert.equal(tokenFromRequest({ headers: {} } as never), null);
});

test("hostFromAuthority strips ports and IPv6 brackets", () => {
  assert.equal(hostFromAuthority("example.com:443"), "example.com");
  assert.equal(hostFromAuthority("example.com"), "example.com");
  assert.equal(hostFromAuthority("[fd00:ec2::254]:443"), "fd00:ec2::254");
  assert.equal(hostFromAuthority("169.254.169.254:80"), "169.254.169.254");
  assert.equal(hostFromAuthority(""), null);
});

test("isBlockedDestinationIp covers IMDS, 169.254/16, fe80::/10, v4-mapped, AWS v6 IMDS", () => {
  assert.equal(isBlockedDestinationIp("169.254.169.254"), true);
  assert.equal(isBlockedDestinationIp("169.254.1.1"), true);
  assert.equal(isBlockedDestinationIp("::ffff:169.254.169.254"), true);
  assert.equal(isBlockedDestinationIp("fe80::1"), true);
  assert.equal(isBlockedDestinationIp("febf::1"), true);
  assert.equal(isBlockedDestinationIp("fd00:ec2::254"), true);
  assert.equal(isBlockedDestinationIp("[fd00:ec2::254]"), true);
  assert.equal(isBlockedDestinationIp("8.8.8.8"), false);
  assert.equal(isBlockedDestinationIp("2606:4700::1111"), false);
  assert.equal(isBlockedDestinationIp("fec0::1"), false);
});

test("isBlockedDestinationIp catches non-canonical spellings of blocked addresses", () => {
  assert.equal(isBlockedDestinationIp("::ffff:a9fe:a9fe"), true);
  assert.equal(isBlockedDestinationIp("[::ffff:a9fe:a9fe]"), true);
  assert.equal(isBlockedDestinationIp("fd00:ec2:0:0:0:0:0:254"), true);
  assert.equal(isBlockedDestinationIp("fd00:0ec2::0254"), true);
  assert.equal(isBlockedDestinationIp("FE80::1"), true);
  assert.equal(isBlockedDestinationIp("fe80::1%eth0"), true);
  assert.equal(isBlockedDestinationIp("0.0.0.0"), true);
  assert.equal(isBlockedDestinationIp("0.0.0.7"), true);
  assert.equal(isBlockedDestinationIp("::"), true);
  assert.equal(isBlockedDestinationIp("::ffff:0:0"), true);
  assert.equal(isBlockedDestinationIp("[::]"), true);
});

test("valid token, open policy => 200 + audited as ok with scope/principal/tenant", async () => {
  const { server, records, tenants } = boot();
  const port = await listen(server);
  try {
    assert.equal(await check(port, "example.com:443", await egressToken({ allowedHosts: [] })), 200);
    assert.equal(records.at(-1)?.verdict, "ok");
    assert.equal(records.at(-1)?.source, "proxy");
    assert.equal(records.at(-1)?.host, "example.com");
    assert.equal(records.at(-1)?.scopeLabel, scopeId("personal", "U_actor"));
    assert.equal(records.at(-1)?.principalId, "U_actor");
    assert.equal(tenants.at(-1), TEST_TENANT);
    const foreign = await withTenant(OTHER_TENANT, () => egressToken({ allowedHosts: [] }));
    assert.equal(await check(port, "example.com:443", foreign), 200);
    assert.equal(tenants.at(-1), OTHER_TENANT, "each decision is attributed to its token's tenant");
  } finally {
    await close(server);
  }
});

test("valid token with a denylist => 403 + audited as denied", async () => {
  const { server, records } = boot();
  const port = await listen(server);
  try {
    assert.equal(
      await check(
        port,
        "evil.example.com:443",
        await egressToken({ allowedHosts: [], deniedHosts: ["evil.example.com"] }),
      ),
      403,
    );
    assert.equal(records.at(-1)?.verdict, "denied");
  } finally {
    await close(server);
  }
});

test("allowlist present => non-matching host is 403 not_allowlisted, matching host 200", async () => {
  const { server, records } = boot();
  const port = await listen(server);
  const token = await egressToken({ allowedHosts: ["github.com"], deniedHosts: [] });
  try {
    assert.equal(await check(port, "api.github.com:443", token), 200);
    assert.equal(records.at(-1)?.verdict, "ok");
    assert.equal(await check(port, "example.com:443", token), 403);
    assert.equal(records.at(-1)?.verdict, "not_allowlisted");
  } finally {
    await close(server);
  }
});

test("NO token asks for proxy credentials by default and is audited as unknown", async () => {
  const { server, records, tenants } = boot();
  const port = await listen(server);
  try {
    assert.equal(await check(port, "example.com:443"), 407);
    assert.equal(tenants.at(-1), undefined);
    assert.equal(records.at(-1)?.verdict, "denied");
    assert.equal(records.at(-1)?.scopeLabel, "unknown");
    assert.equal(records.at(-1)?.principalId, "unknown");
  } finally {
    await close(server);
  }
});

test("wrong-secret / wrong-audience / expired presented tokens fail closed", async () => {
  const { server, records } = boot();
  const port = await listen(server);
  try {
    assert.equal(
      await check(port, "example.com:443", await egressToken({ allowedHosts: [] }, { secret: SOURCE_SECRET })),
      403,
    );
    assert.equal(records.at(-1)?.scopeLabel, "unknown");
    assert.equal(
      await check(port, "example.com:443", await egressToken({ allowedHosts: [] }, { aud: CONTROL_PLANE_AUD })),
      403,
    );
    assert.equal(records.at(-1)?.scopeLabel, "unknown");
    assert.equal(
      await check(port, "example.com:443", await egressToken({ allowedHosts: [] }, { exp: Date.now() - 1000 })),
      403,
    );
    assert.equal(records.at(-1)?.scopeLabel, "unknown");
  } finally {
    await close(server);
  }
});

test("tokenless=open is an explicit compatibility escape hatch; valid tokens still apply their own policy", async () => {
  const { server, records } = boot({ tokenless: "open" });
  const port = await listen(server);
  try {
    assert.equal(await check(port, "example.com:443"), 200);
    assert.equal(records.at(-1)?.verdict, "ok");
    assert.equal(await check(port, "example.com:443", await egressToken({ allowedHosts: [] })), 200);
    assert.equal(records.at(-1)?.verdict, "ok");
  } finally {
    await close(server);
  }
});

test("IMDS + link-local + cloud metadata names are denied even tokenless / with open policy", async () => {
  const { server, records } = boot();
  const port = await listen(server);
  const open = await egressToken({ allowedHosts: [], deniedHosts: [] });
  try {
    for (const authority of [
      "169.254.169.254:80",
      "169.254.0.9:443",
      "[fe80::1]:443",
      "[fd00:ec2::254]:80",
      "metadata.google.internal:80",
      "metadata.google.internal",
    ]) {
      assert.equal(await check(port, authority), 407, `tokenless ${authority}`);
      assert.equal(await check(port, authority, open), 403, `open-policy ${authority}`);
      assert.equal(records.at(-1)?.verdict, "denied");
    }
  } finally {
    await close(server);
  }
});

test("a name RESOLVING to link-local / denied IP is denied (rebind guard)", async () => {
  const { server, records } = boot({ lookup: async () => ["169.254.169.254"] });
  const port = await listen(server);
  try {
    assert.equal(await check(port, "innocent.example.com:443", await egressToken({ allowedHosts: [] })), 403);
    assert.equal(records.at(-1)?.verdict, "denied");
  } finally {
    await close(server);
  }
});

// A forward proxy dials from ITS namespace, so an allowed `CONNECT 127.0.0.1:<port>` would bridge
// any caller to the services colocated with the proxy — this decision service, Envoy's admin.
test("loopback destinations are denied even under an open policy, by literal and by resolved IP", async () => {
  const { server, records } = boot({ lookup: async () => ["127.0.0.1"] });
  const port = await listen(server);
  try {
    const open = await egressToken({ allowedHosts: [] });
    for (const authority of ["127.0.0.1:9901", "127.0.0.1:48081", "[::1]:9901", "127.1.2.3:80"]) {
      assert.equal(await check(port, authority, open), 403, authority);
    }
    assert.equal(await check(port, "rebind.example.com:9901", open), 403);
    assert.equal(records.at(-1)?.verdict, "denied");
  } finally {
    await close(server);
  }
});

test("a name resolving to a policy-denied IP is denied", async () => {
  const { server } = boot({ lookup: async () => ["10.9.9.9"] });
  const port = await listen(server);
  try {
    assert.equal(
      await check(port, "innocent.example.com:443", await egressToken({ allowedHosts: [], deniedHosts: ["10.9.9.9"] })),
      403,
    );
  } finally {
    await close(server);
  }
});

test("denyPrivateNetworks rejects private DNS answers except for an explicit host exception", async () => {
  const { server } = boot({ lookup: async () => ["10.9.9.9"] });
  const port = await listen(server);
  try {
    const denied = await egressToken({ allowedHosts: [], denyPrivateNetworks: true });
    assert.equal(await check(port, "service.example.com:443", denied), 403);
    const excepted = await egressToken({
      allowedHosts: [],
      denyPrivateNetworks: true,
      privateNetworkAllowedHosts: ["core.example.com"],
    });
    assert.equal(await check(port, "core.example.com:443", excepted), 200);
  } finally {
    await close(server);
  }
});

test("denyPrivateNetworks rejects local-use and deprecated IPv6 ranges", async () => {
  const token = await egressToken({ allowedHosts: [], denyPrivateNetworks: true });
  for (const address of ["64:ff9b:1::1", "fec0::1"]) {
    const { server } = boot({ lookup: async () => [address] });
    const port = await listen(server);
    try {
      assert.equal(await check(port, "service.example.com:443", token), 403);
    } finally {
      await close(server);
    }
  }
});

test("authorization returns the vetted upstream address so the data plane cannot re-resolve it", async () => {
  const { server } = boot({ lookup: async () => ["93.184.216.34"] });
  const port = await listen(server);
  try {
    const result = await checkWithHeaders(port, "example.com:443", await egressToken({ allowedHosts: [] }));
    assert.equal(result.status, 200);
    assert.equal(result.headers["x-egress-upstream-address"], "93.184.216.34:443");
  } finally {
    await close(server);
  }
});

test("DNS failure => fail closed (403)", async () => {
  const { server } = boot({
    lookup: async () => {
      throw new Error("nx");
    },
  });
  const port = await listen(server);
  try {
    assert.equal(await check(port, "nx.example.com:443", await egressToken({ allowedHosts: [] })), 403);
  } finally {
    await close(server);
  }
});

test("relay sink: batches decisions into a signed POST to core's /v1/egress-audit", async () => {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 200 });
  }) as typeof fetch;
  const sink = createRelayAuditSink("http://core.example:4000/", SOURCE_SECRET, fakeFetch);
  sink.record(
    {
      source: "proxy",
      host: "api.github.com",
      allowed: true,
      verdict: "ok",
      scopeLabel: scopeId("personal", "U1"),
      principalId: "U1",
    },
    TEST_TENANT,
  );
  sink.record(
    {
      source: "proxy",
      host: "pastebin.com",
      allowed: false,
      verdict: "denied",
      scopeLabel: scopeId("personal", "U1"),
      principalId: "U1",
    },
    TEST_TENANT,
  );
  await sink.flush();

  assert.equal(calls.length, 1, "one batched POST");
  assert.equal(calls[0]!.url, "http://core.example:4000/v1/egress-audit");
  assert.deepEqual(
    calls[0]!.body.records.map((r: any) => [r.host, r.verdict]),
    [
      ["api.github.com", "ok"],
      ["pastebin.com", "denied"],
    ],
  );
  const v = verifySignature(
    SOURCE_SECRET,
    {
      signature: calls[0]!.headers["x-signature"]!,
      timestamp: Number(calls[0]!.headers["x-timestamp"]),
      body: canonicalPayload("POST", "/v1/egress-audit", JSON.stringify(calls[0]!.body), TEST_TENANT),
    },
    Date.now(),
    5 * 60_000,
  );
  assert.equal(v.ok, true, "the POST is source-signed over the canonical payload");
  assert.equal(calls[0]!.headers["x-qm-tenant"], TEST_TENANT);

  await sink.flush();
  assert.equal(calls.length, 1, "an empty buffer does not POST");
});

test("relay sink: signs over the real request path when CORE_API_URL carries a prefix", async () => {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const sink = createRelayAuditSink("http://alb.example/core", SOURCE_SECRET, fakeFetch);
  sink.record(
    { source: "proxy", host: "a.com", allowed: true, verdict: "ok", scopeLabel: scopeId("personal", "U1") },
    TEST_TENANT,
  );
  await sink.flush();
  assert.equal(calls[0]!.url, "http://alb.example/core/v1/egress-audit");
  const v = verifySignature(
    SOURCE_SECRET,
    {
      signature: calls[0]!.headers["x-signature"]!,
      timestamp: Number(calls[0]!.headers["x-timestamp"]),
      body: canonicalPayload("POST", "/core/v1/egress-audit", JSON.stringify(calls[0]!.body), TEST_TENANT),
    },
    Date.now(),
    5 * 60_000,
  );
  assert.equal(v.ok, true, "the signature covers the path core will actually see");
});

test("relay sink: a batch is only dequeued once core acknowledges it", async () => {
  let fail = true;
  const calls: any[] = [];
  const fakeFetch = (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    if (fail) return new Response("nope", { status: 503 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const sink = createRelayAuditSink("http://core.example:4000", SOURCE_SECRET, fakeFetch);
  sink.record(
    {
      source: "proxy",
      host: "a.com",
      allowed: true,
      verdict: "ok",
      scopeLabel: scopeId("personal", "U1"),
      principalId: "U1",
    },
    TEST_TENANT,
  );
  await sink.flush();
  assert.equal(calls.length, 1);
  fail = false;
  await sink.flush();
  assert.equal(calls.length, 2, "the batch is retried");
  assert.deepEqual(
    calls[1].records.map((r: any) => r.host),
    ["a.com"],
    "the same record is re-sent",
  );
  await sink.flush();
  assert.equal(calls.length, 2, "acknowledged records are not re-sent");
});

test("relay sink: posts one signed batch per tenant and drops records with no tenant", async () => {
  const calls: Array<{ body: any; headers: Record<string, string> }> = [];
  const fakeFetch = (async (_url: any, init: any) => {
    calls.push({ body: JSON.parse(init.body), headers: init.headers });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const sink = createRelayAuditSink("http://core.example:4000", SOURCE_SECRET, fakeFetch);
  const rec = (host: string) => ({
    source: "proxy" as const,
    host,
    allowed: true,
    verdict: "ok" as const,
    scopeLabel: scopeId("personal", "U1"),
  });
  sink.record(rec("a.com"), TEST_TENANT);
  sink.record(rec("b.com"), OTHER_TENANT);
  sink.record(rec("c.com"), TEST_TENANT);
  sink.record(rec("untenanted.com"));
  await sink.flush();
  await sink.flush();
  await sink.flush();
  assert.equal(calls.length, 2);
  const byTenant = Object.fromEntries(
    calls.map((c) => [c.headers["x-qm-tenant"], c.body.records.map((r: any) => r.host)]),
  );
  assert.deepEqual(byTenant, { [TEST_TENANT]: ["a.com", "c.com"], [OTHER_TENANT]: ["b.com"] });
  for (const c of calls) {
    const canonical = canonicalPayload("POST", "/v1/egress-audit", JSON.stringify(c.body), c.headers["x-qm-tenant"]);
    const v = verifySignature(
      SOURCE_SECRET,
      { signature: c.headers["x-signature"]!, timestamp: Number(c.headers["x-timestamp"]), body: canonical },
      Date.now(),
      5 * 60_000,
    );
    assert.equal(v.ok, true, "each batch is signed over its own tenant");
  }
});

test("relay sink: a batch core refuses with 4xx is dropped rather than retried forever", async () => {
  const calls: any[] = [];
  const fakeFetch = (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    return new Response("refused", { status: 403 });
  }) as typeof fetch;
  const sink = createRelayAuditSink("http://core.example:4000", SOURCE_SECRET, fakeFetch);
  sink.record(
    { source: "proxy", host: "a.com", allowed: true, verdict: "ok", scopeLabel: scopeId("personal", "U1") },
    OTHER_TENANT,
  );
  await sink.flush();
  await sink.flush();
  assert.equal(calls.length, 1);
});
