import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { connectThroughEgress, egressEventCounts } from "./workload-egress.ts";

test("CONNECT proof validates TLS and preserves native denial without opening an upstream tunnel", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qm-egress-proof-"));
  const cert = join(directory, "cert.pem"),
    key = join(directory, "key.pem"),
    config = join(directory, "openssl.cnf");
  writeFileSync(
    config,
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=fixture.test\n[ext]\nsubjectAltName=DNS:fixture.test\nbasicConstraints=critical,CA:TRUE\n",
    { mode: 0o600 },
  );
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-config", config],
    { stdio: "ignore" },
  );
  let upstreamRequests = 0;
  const upstream = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-fixture-secret");
    assert.equal(req.headers["proxy-authorization"], undefined);
    upstreamRequests++;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sentinel: "native-tunnel" }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as AddressInfo).port;
  const authorities: string[] = [];
  const proxy = createHttpServer();
  proxy.on("connect", (req, socket, head) => {
    assert.equal(req.headers["proxy-authorization"], "Bearer synthetic-capability");
    authorities.push(req.url!);
    if (req.url!.startsWith("denied.test:"))
      return void socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    const target = connect(port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    socket.on("error", () => target.destroy());
    socket.on("close", () => target.destroy());
    target.on("error", () => socket.destroy());
    target.on("close", () => socket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const request = {
    proxyOrigin: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    host: "fixture.test",
    port,
    capability: "synthetic-capability",
    path: "/fixture",
    secret: "synthetic-fixture-secret",
    timeoutMs: 2000,
  };
  try {
    const success = await connectThroughEgress({ ...request, ca: readFileSync(cert) });
    assert.equal(success.connectStatus, 200);
    assert.equal(success.upstreamStatus, 200);
    assert.deepEqual(JSON.parse(success.body!), { sentinel: "native-tunnel" });
    const denied = await connectThroughEgress({ ...request, host: "denied.test", ca: readFileSync(cert) });
    assert.equal(denied.connectStatus, 403);
    assert.equal(denied.body, undefined);
    await assert.rejects(connectThroughEgress(request), /certificate|self-signed/i);
    assert.equal(upstreamRequests, 1);
    assert.deepEqual(authorities, [`fixture.test:${port}`, `denied.test:${port}`, `fixture.test:${port}`]);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "native event accounting includes every campaign-host row, including misattributed events",
  {
    skip: !process.env.QM_PERF_TEST_DATABASE_URL,
  },
  async () => {
    const connectionString = process.env.QM_PERF_TEST_DATABASE_URL!;
    assert.match(new URL(connectionString).pathname, /^\/qm_perf_\w+$/);
    const client = new Client({
      connectionString,
      options: "-c default_transaction_read_only=on -c statement_timeout=5000",
    });
    await client.connect();
    try {
      const expected = [
        {
          host: "allow.test",
          source: "proxy",
          principal_id: "actor",
          scope_label: "personal:actor",
          allowed: true,
          verdict: "ok",
        },
        {
          host: "deny.test",
          source: "proxy",
          principal_id: "actor",
          scope_label: "personal:actor",
          allowed: false,
          verdict: "not_allowlisted",
        },
      ];
      let rows = expected;
      const observed = () =>
        egressEventCounts(
          {
            query: async (query: string, values: unknown[]) =>
              client.query(
                `WITH egress_events AS (SELECT * FROM jsonb_to_recordset($6::jsonb) AS e(host text,source text,principal_id text,scope_label text,allowed boolean,verdict text)) ${query}`,
                [...values, JSON.stringify(rows)],
              ),
          } as Pick<Client, "query">,
          "allow.test",
          "deny.test",
          "actor",
        );
      assert.deepEqual(await observed(), { allowed: 1, denied: 1, total: 2 });
      for (const change of [{ source: "tool" }, { principal_id: "other" }, { scope_label: "personal:other" }]) {
        const extra = { ...expected[0]!, ...change };
        rows = [...expected, extra];
        assert.deepEqual(await observed(), { allowed: 1, denied: 1, total: 3 });
        rows = [extra];
        assert.deepEqual(await observed(), { allowed: 0, denied: 0, total: 1 });
      }
    } finally {
      await client.end();
    }
  },
);
