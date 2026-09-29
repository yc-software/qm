import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
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
  const partialBytes = 'data: {"fixture":"partial"}\n\n';
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers["x-api-key"], "qm-perf-upstream-token-only");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-amz-security-token"], undefined);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(input.model, "fixture-model");
    forwarded++;
    if (input.fixtureMode === "timeout") return;
    if (input.fixtureMode === "partial") {
      res.writeHead(200, { "content-type": "text/event-stream" }).write(partialBytes);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"fixture":true}\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const rows: Record<string, unknown>[] = [];
  const nativeReceipts = Promise.withResolvers<void>();
  const partialReceipt = Promise.withResolvers<Record<string, unknown>>();
  const timeoutReceipt = Promise.withResolvers<Record<string, unknown>>();
  let partialSha256 = "",
    timeoutSha256 = "";
  let cancelled: (row: Record<string, unknown>) => void;
  const cancelledReceipt = new Promise<Record<string, unknown>>((resolve) => {
    cancelled = resolve;
  });
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const payload = "a".repeat(4000),
    denied = "qm-perf-denied-input";
  const childId = randomUUID(),
    runId = randomUUID(),
    stamp = "2026-09-27T00:00:00.123Z";
  const nativeText = "known-child:" + "x".repeat(1560) + childId + ":" + stamp + ":8:" + childId;
  const nativeSurface = "session_message_subagent-mail-" + runId;
  const nativeBodies: Array<Record<string, any>> = [];
  const capture = createSecurityScreenProxy({
    provider: "fixture",
    endpoint: "https://fixture.invalid/security-screen",
    token: "qm-perf-capture-token-only",
    timeoutMs: 1000,
    shadow: false,
    fetch: (async (_, init) => {
      nativeBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ score: 0.1, threshold: 0.5 });
    }) as typeof fetch,
  });
  await capture.classify({
    payload: nativeText,
    hook: "tool_response",
    metadata: {
      surface: nativeSurface,
      origin: "automation",
      request: { origin: "automation", text: "exact parent task", truncated: false },
    },
  });
  const fragments: NonNullable<Parameters<typeof createGatewayFixture>[0]["security"]["nativeFragments"]>["fragments"] =
    [];
  let offset = 0;
  for (const [index, body] of nativeBodies.entries()) {
    const fields: (typeof fragments)[number]["text"]["fields"] = [];
    for (const [name, value, starts] of [
      ["childSessionId", childId, [nativeText.indexOf(childId), nativeText.lastIndexOf(childId)]],
      ["mailAt", stamp, [nativeText.indexOf(stamp)]],
      ["remainingSlots", "8", [nativeText.indexOf(":8:") + 1]],
    ] as const)
      for (const start of starts) {
        const lo = Math.max(start, offset),
          hi = Math.min(start + value.length, offset + body.text.length);
        if (lo < hi) fields.push({ name, offset: lo - offset, from: lo - start, length: hi - lo });
      }
    fields.sort((a, b) => a.offset - b.offset);
    fragments.push({
      id: "child-" + index,
      hook: "tool_response",
      chunkIndex: index,
      chunkCount: nativeBodies.length,
      surface: {
        text: nativeSurface,
        fields: [{ name: "childRunId", offset: nativeSurface.indexOf(runId), from: 0, length: 36 }],
      },
      request: { textSha256: hash("exact parent task"), truncated: false },
      text: { text: body.text, fields },
    });
    offset += body.text.length - 256;
  }
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
    upstreamTimeoutMs: 1000,
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
      nativeFragments: { provider: "fixture", treeRunCap: 10, fragments },
    },
  };
  const gateway = createGatewayFixture(profile, (row) => {
    rows.push(row);
    if (rows.filter((value) => value.nativeScreen).length === nativeBodies.length) nativeReceipts.resolve();
    if (row.requestId === "qm-perf-cancelled") cancelled(row);
    if (row.bodySha256 === partialSha256) partialReceipt.resolve(row);
    if (row.bodySha256 === timeoutSha256) timeoutReceipt.resolve(row);
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
    const completed = rows.find((row) => row.bodySha256 === hash(body))!;
    assert.equal(completed.responseBytes, Buffer.byteLength('data: {"fixture":true}\n\n'));
    const partialBody = JSON.stringify({ ...JSON.parse(body), fixtureMode: "partial" });
    partialSha256 = hash(partialBody);
    const partial = await signedFetch(url + "/v1/messages", { method: "POST", body: partialBody });
    const reader = partial.body!.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value!).toString(), partialBytes);
    await reader.cancel();
    const partialRow = await partialReceipt.promise;
    assert.equal(partialRow.responseBytes, Buffer.byteLength(partialBytes));
    assert.equal(partialRow.completed, false);
    assert.equal(partialRow.aborted, true);
    assert.equal(partialRow.failed, true);
    const timeoutBody = JSON.stringify({ ...JSON.parse(body), fixtureMode: "timeout" });
    timeoutSha256 = hash(timeoutBody);
    const timedOut = await signedFetch(url + "/v1/messages", { method: "POST", body: timeoutBody });
    assert.equal(timedOut.status, 400);
    const timeoutText = await timedOut.text();
    const timeoutRow = await timeoutReceipt.promise;
    assert.equal(timeoutRow.failed, true);
    assert.equal(timeoutRow.responseBytes, Buffer.byteLength(timeoutText));
    assert.equal(timeoutRow.upstreamTimeoutMs, profile.upstreamTimeoutMs);
    assert.ok(Number(timeoutRow.durationMs) >= profile.upstreamTimeoutMs - 50);
    for (const upstreamTimeoutMs of [0, -1, 0.5, NaN, Infinity, 900001])
      assert.throws(() => createGatewayFixture({ ...profile, upstreamTimeoutMs }, () => {}));
    createGatewayFixture({ ...profile, upstreamTimeoutMs: 900000 }, () => {}).close();
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
    assert.ok(fragments[0]!.text.fields.some((field) => field.name === "childSessionId" && field.length < 36));
    assert.equal(
      (
        await native.classify({
          payload: nativeText,
          hook: "tool_response",
          metadata: {
            surface: nativeSurface,
            origin: "automation",
            request: { origin: "automation", text: "exact parent task", truncated: false },
          },
        })
      ).verdict.decision,
      "auto",
    );
    await Promise.race([
      nativeReceipts.promise,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Missing native fragment receipts")), 2000);
        timer.unref();
      }),
    ]);
    const dynamicRows = rows.filter((row) => row.nativeScreen);
    assert.equal(dynamicRows.length, 2);
    assert.ok(dynamicRows.every((row) => (row.nativeScreen as any).reconstructionRequired === true));
    assert.ok(!JSON.stringify(dynamicRows).includes("exact parent task"));
    const sendScreen = async (body: string) => {
      const response = await request(url + "/security-screen", {
        method: "POST",
        headers: { "x-api-key": profile.security.token },
        body,
        dispatcher: agent,
      });
      await response.body?.cancel();
      return response.status;
    };
    const nativeBody = nativeBodies[1]!;
    const changed = (modify: (value: Record<string, any>) => void) => {
      const copy = structuredClone(nativeBody);
      modify(copy);
      return JSON.stringify(copy);
    };
    for (const mutate of [
      (value: Record<string, any>) => {
        value.text += "\n";
      },
      (value: Record<string, any>) => {
        value.text = value.text.replace(childId, childId.toUpperCase());
      },
      (value: Record<string, any>) => {
        value.text = value.text.replace(stamp, "2026-02-31T00:00:00.123Z");
      },
      (value: Record<string, any>) => {
        value.text = value.text.replace(":8:", ":9:");
      },
      (value: Record<string, any>) => {
        value.text = value.text.replace(childId, randomUUID());
      },
      (value: Record<string, any>) => {
        value.text = "!" + value.text.slice(1);
      },
      (value: Record<string, any>) => {
        value.hook = "user_input";
      },
      (value: Record<string, any>) => {
        value.metadata.origin = "direct";
      },
      (value: Record<string, any>) => {
        value.metadata.extra = true;
      },
      (value: Record<string, any>) => {
        value.metadata.request.text += "!";
      },
      (value: Record<string, any>) => {
        value.metadata.request.truncated = true;
      },
      (value: Record<string, any>) => {
        value.metadata.request.origin = "direct";
      },
      (value: Record<string, any>) => {
        value.metadata.fixture.chunk_index = 0;
      },
      (value: Record<string, any>) => {
        value.metadata.qm.request_id = "not-a-native-uuid";
        value.metadata.fixture.request_id = "not-a-native-uuid";
      },
      (value: Record<string, any>) => {
        value.metadata.qm.request_id += "\n";
        value.metadata.fixture.request_id += "\n";
      },
      (value: Record<string, any>) => {
        delete value.metadata.request;
      },
    ])
      assert.equal(await sendScreen(changed(mutate)), 400);
    assert.equal(await sendScreen(JSON.stringify(nativeBody) + " "), 400);
    assert.equal(await sendScreen(JSON.stringify(nativeBody).replace('{"text":', '{"text":"ignored","text":')), 400);
    const duplicate = {
      ...profile,
      security: {
        ...profile.security,
        nativeFragments: {
          ...profile.security.nativeFragments,
          fragments: [...fragments, { ...fragments[0]!, id: "ambiguous" }],
        },
      },
    };
    const ambiguous = createGatewayFixture(duplicate, () => {});
    await new Promise<void>((resolve) => ambiguous.listen(0, "127.0.0.1", resolve));
    try {
      const response = await request(`https://127.0.0.1:${(ambiguous.address() as AddressInfo).port}/security-screen`, {
        method: "POST",
        headers: { host: profile.authority, "x-api-key": profile.security.token },
        body: JSON.stringify(nativeBodies[0]),
        dispatcher: agent,
      });
      assert.equal(response.status, 400);
      await response.body?.cancel();
    } finally {
      await new Promise<void>((resolve) => ambiguous.close(() => resolve()));
    }
    for (const mutate of [
      (value: typeof profile) => {
        value.security.nativeFragments.fragments[0]!.hook = "user_input";
      },
      (value: typeof profile) => {
        value.security.nativeFragments.treeRunCap = 11;
      },
      (value: typeof profile) => {
        value.security.nativeFragments.fragments[0]!.text.fields[0]!.from = 36;
      },
      (value: typeof profile) => {
        value.security.nativeFragments.fragments[0]!.chunkCount = 13;
      },
      (value: typeof profile) => {
        value.security.nativeFragments.fragments[0]!.text.fields[0]!.offset = -1;
      },
    ]) {
      const copy = { ...profile, security: structuredClone(profile.security) };
      mutate(copy);
      assert.throws(() => createGatewayFixture(copy, () => {}));
    }
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
    assert.equal(terminal.responseBytes, 0);
    assert.ok(
      rows.every(
        (row) =>
          Number.isSafeInteger(row.startedAt) &&
          Number.isSafeInteger(row.finishedAt) &&
          Number(row.finishedAt) >= Number(row.startedAt) &&
          row.durationMs === Number(row.finishedAt) - Number(row.startedAt) &&
          Number.isSafeInteger(row.responseBytes) &&
          Number(row.responseBytes) >= 0,
      ),
    );
    assert.ok(
      rows.filter((row) => row.verified && !row.failed).every((row) => row.completed === true && row.aborted === false),
    );
    assert.equal(forwarded, 3);
    assert.equal(rows.filter((row) => row.verified && row.path !== "/security-screen").length, 6);
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
