import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Agent, fetch as request } from "undici";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { createGatewayCatalog } from "../../src/model/gateway-catalog.ts";
import { setGatewayModels } from "../../src/model/gateway-models.ts";
import { createSecurityScreenProxy } from "../../src/security/security-screener.ts";
import { createGatewayFixture } from "./workload-gateway.ts";

test("TLS gateway verifies signed bodies and native catalog and screening clients traverse the real network", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qm-perf-gateway-"));
  const cert = join(directory, "cert.pem"),
    key = join(directory, "key.pem"),
    config = join(directory, "openssl.cnf");
  writeFileSync(
    config,
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=fixture.test\n[ext]\nsubjectAltName=DNS:fixture.test,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
    { mode: 0o600 },
  );
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-config", config],
    { stdio: "ignore" },
  );
  let forwarded = 0;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers["x-api-key"], "qm-perf-upstream-token-only");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-amz-security-token"], undefined);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).model, "fixture-model");
    forwarded++;
    res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"fixture":true}\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const rows: Record<string, unknown>[] = [];
  let cancelled: (row: Record<string, unknown>) => void;
  const cancelledReceipt = new Promise<Record<string, unknown>>((resolve) => {
    cancelled = resolve;
  });
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const payload = "a".repeat(4000),
    denied = "qm-perf-denied-input";
  const profile = {
    fixtureId: "gateway-test",
    authority: "fixture.test",
    cert: readFileSync(cert),
    key: readFileSync(key),
    accessKeyId: "QM_PERF_GATEWAY_TEST",
    secretAccessKey: "qm-perf-signing-secret-only",
    sessionToken: "qm-perf-signing-session-only",
    region: "us-west-2",
    apiKey: "qm-perf-gateway-token-only",
    apiKeyHeader: "api-key",
    upstreamToken: "qm-perf-upstream-token-only",
    upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    models: [
      {
        id: "router/fixture-model",
        upstreamModelId: "fixture-model",
        contextWindow: 100000,
        maxOutputTokens: 1000,
        inputCost: 1,
        outputCost: 2,
      },
    ],
    security: {
      token: "qm-perf-security-token-only",
      allowTextSha256: [hash("a".repeat(1600)), hash("a".repeat(1312))],
      denyTextSha256: [hash(denied)],
      delayMs: 1,
    },
  };
  const gateway = createGatewayFixture(profile, (row) => {
    rows.push(row);
    if (row.requestId === "qm-perf-cancelled") cancelled(row);
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  profile.authority = new URL(url).host;
  const agent = new Agent({ connect: { ca: profile.cert } });
  const signer = new SignatureV4({
    service: "execute-api",
    region: profile.region,
    sha256: Sha256,
    credentials: profile,
  });
  const signed = async (path: string, body = "", date = new Date()) =>
    signer.sign(
      {
        method: body ? "POST" : "GET",
        protocol: "https:",
        hostname: "fixture.test",
        path,
        headers: { host: profile.authority, "api-key": profile.apiKey },
        body,
      },
      { signingDate: date },
    );
  const signedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(input));
    const message = await signed(target.pathname, String(init?.body ?? ""));
    return request(target, {
      method: message.method,
      body: init?.body == null ? undefined : String(init.body),
      signal: init?.signal,
      redirect: "error",
      headers: message.headers,
      dispatcher: agent,
    }) as unknown as Promise<Response>;
  }) as typeof fetch;
  try {
    const catalog = createGatewayCatalog(
      {
        url,
        apiKey: profile.apiKey,
        apiKeyHeader: profile.apiKeyHeader,
        models: { "fixture-alias": "router/fixture-model" },
      },
      signedFetch,
    );
    await catalog.refresh();
    assert.equal(catalog.transport.models["fixture-alias"], "router/fixture-model");
    assert.equal(catalog.transport.models["gateway/router/fixture-model"], "router/fixture-model");
    const unsignedApiKey = await signer.sign(
      {
        method: "GET",
        protocol: "https:",
        hostname: "fixture.test",
        path: "/v1/models",
        headers: { host: profile.authority, "api-key": profile.apiKey },
        body: "",
      },
      { unsignableHeaders: new Set(["api-key"]) },
    );
    const nativeHeaders = await request(url + "/v1/models", { headers: unsignedApiKey.headers, dispatcher: agent });
    assert.equal(nativeHeaders.status, 200);
    await nativeHeaders.body?.cancel();
    const body = JSON.stringify({
      model: "router/fixture-model",
      messages: [{ role: "user", content: "qm-perf-fixture" }],
    });
    const message = await signed("/v1/messages", body);
    const response = await request(url + "/v1/messages", {
      method: "POST",
      headers: message.headers,
      body,
      dispatcher: agent,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'data: {"fixture":true}\n\n');
    for (const [path, headers, wire] of [
      ["/v1/messages", message.headers, body + " "],
      ["/v1/messages", { ...message.headers, "api-key": "qm-perf-wrong-secret-value" }, body],
      ["/v1/messages", (await signed("/v1/messages", body, new Date(Date.now() - 600000))).headers, body],
      ["/unknown", message.headers, body],
      ["//127.0.0.1/v1/messages", message.headers, body],
      ["/v1/messages?upstream=http://127.0.0.1", message.headers, body],
    ] as const) {
      const rejected = await request(url + path, { method: "POST", headers, body: wire, dispatcher: agent });
      assert.equal(rejected.status, 400);
      await rejected.body?.cancel();
    }
    const native = createSecurityScreenProxy({
      provider: "fixture",
      endpoint: url + "/security-screen",
      token: profile.security.token,
      timeoutMs: 5000,
      shadow: false,
      fetch: ((input, init) =>
        request(String(input), {
          method: init?.method,
          body: init?.body == null ? undefined : String(init.body),
          signal: init?.signal,
          redirect: "error",
          headers: { ...Object.fromEntries(new Headers(init?.headers)), host: profile.authority },
          dispatcher: agent,
        }) as unknown as Promise<Response>) as typeof fetch,
    });
    assert.equal(
      (await native.classify({ payload, hook: "user_input", requestId: "qm-perf-chunks" })).verdict.decision,
      "auto",
    );
    assert.equal(
      (await native.classify({ payload: denied, hook: "tool_response", requestId: "qm-perf-denied" })).verdict.decision,
      "strict",
    );
    await assert.rejects(native.classify({ payload: "unrecognized", hook: "user_input" }), /HTTP 400/);
    const chunks = rows
      .filter((row) => row.requestId === "qm-perf-chunks")
      .sort((a, b) => Number(a.chunkIndex) - Number(b.chunkIndex));
    assert.deepEqual(
      chunks.map((row) => [row.chunkIndex, row.chunkCount, row.verdict, row.verified]),
      [
        [0, 3, "auto", true],
        [1, 3, "auto", true],
        [2, 3, "auto", true],
      ],
    );
    profile.security.delayMs = 200;
    const aborted = new AbortController();
    const pending = native.classify({
      payload: "a".repeat(1600),
      hook: "user_input",
      requestId: "qm-perf-cancelled",
      signal: aborted.signal,
    });
    const timer = setTimeout(() => aborted.abort(), 50);
    try {
      await assert.rejects(pending);
    } finally {
      clearTimeout(timer);
    }
    const terminal = await Promise.race([
      cancelledReceipt,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Missing cancelled receipt")), 2000);
        timer.unref();
      }),
    ]);
    assert.equal(terminal.verified, true);
    assert.equal(terminal.completed, false);
    assert.equal(terminal.aborted, true);
    assert.equal(terminal.failed, true);
    assert.ok(
      rows.filter((row) => row.verified && !row.failed).every((row) => row.completed === true && row.aborted === false),
    );
    assert.equal(forwarded, 1);
    assert.equal(rows.filter((row) => row.verified && row.path !== "/security-screen").length, 4);
    await assert.rejects(fetch(url + "/v1/models"), /fetch failed/);
    assert.ok(!JSON.stringify(rows).includes(profile.apiKey));
    assert.ok(!JSON.stringify(rows).includes(payload));
  } finally {
    setGatewayModels([]);
    await agent.close();
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    rmSync(directory, { recursive: true, force: true });
  }
});
