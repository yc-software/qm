import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";

interface GatewayFixture {
  fixtureId: string;
  authority: string;
  cert: Buffer;
  key: Buffer;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
  apiKey: string;
  apiKeyHeader: string;
  upstream: string;
  upstreamToken: string;
  models: Array<{
    id: string;
    upstreamModelId: string;
    contextWindow: number;
    maxOutputTokens: number;
    inputCost: number;
    outputCost: number;
  }>;
  security: {
    token: string;
    allowTextSha256: string[];
    denyTextSha256: string[];
    delayMs: number;
  };
}

const sha = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const equal = (actual: string | undefined, expected: string) => {
  const a = Buffer.from(actual ?? ""),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createGatewayFixture(profile: GatewayFixture, record: (row: Record<string, unknown>) => void) {
  assert.match(profile.fixtureId, /^[a-zA-Z0-9_.-]+$/);
  assert.match(profile.authority, /^[a-zA-Z0-9.-]+(?::\d+)?$/);
  assert.match(profile.accessKeyId, /^QM_PERF_[A-Z0-9_]+$/);
  for (const token of [
    profile.secretAccessKey,
    profile.sessionToken,
    profile.apiKey,
    profile.upstreamToken,
    profile.security.token,
  ])
    assert.ok(token.startsWith("qm-perf-") && token.length >= 20, "Synthetic fixture credentials required");
  assert.match(profile.apiKeyHeader, /^[a-z][a-z0-9-]*$/);
  assert.ok(
    !["authorization", "host", "x-amz-date", "x-amz-security-token", "content-length"].includes(profile.apiKeyHeader),
  );
  assert.match(profile.region, /^[a-z]{2}-[a-z]+-\d$/);
  const upstream = new URL(profile.upstream);
  assert.ok(upstream.protocol === "http:" || upstream.protocol === "https:");
  assert.ok(
    ["127.0.0.1", "localhost"].includes(upstream.hostname) ||
      /^[a-z0-9.-]*qm-perf-[a-z0-9.-]+\.internal$/.test(upstream.hostname),
  );
  assert.ok(
    !upstream.username && !upstream.password && !upstream.search && !upstream.hash && upstream.pathname === "/",
  );
  assert.ok(profile.models.length > 0 && profile.models.length <= 1000);
  assert.equal(new Set(profile.models.map((model) => model.id)).size, profile.models.length);
  for (const model of profile.models) {
    assert.match(model.upstreamModelId, /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,191}$/);
    assert.match(model.id, /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,191}$/);
    assert.ok(
      Number.isSafeInteger(model.contextWindow) &&
        Number.isSafeInteger(model.maxOutputTokens) &&
        model.maxOutputTokens > 0 &&
        model.contextWindow > model.maxOutputTokens,
    );
    assert.ok([model.inputCost, model.outputCost].every((value) => Number.isFinite(value) && value >= 0));
  }
  const allow = new Set(profile.security.allowTextSha256),
    deny = new Set(profile.security.denyTextSha256);
  for (const digest of [...allow, ...deny]) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.ok([...allow].every((digest) => !deny.has(digest)));
  assert.ok(
    Number.isSafeInteger(profile.security.delayMs) &&
      profile.security.delayMs >= 0 &&
      profile.security.delayMs <= 60000,
  );
  const signer = new SignatureV4({
    service: "execute-api",
    region: profile.region,
    sha256: Sha256,
    credentials: profile,
    applyChecksum: false,
  });
  const server = createServer({ cert: profile.cert, key: profile.key }, async (req, res) => {
    const start = Date.now();
    let phase = "request";
    const disconnected = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) disconnected.abort();
    });
    let path = "unrecognized",
      verified = false,
      requestBytes = 0,
      status = 400;
    const evidence: Record<string, unknown> = { fixtureId: profile.fixtureId, qualified: false };
    try {
      assert.ok(req.url && ["/v1/models", "/model_group/info", "/v1/messages", "/security-screen"].includes(req.url));
      path = req.url;
      assert.equal(req.headers.host, profile.authority);
      assert.equal(req.method, path === "/v1/messages" || path === "/security-screen" ? "POST" : "GET");
      const limit = path === "/security-screen" ? 65536 : 32 * 1024 * 1024;
      assert.ok(req.headers["content-encoding"] === undefined);
      assert.ok(!req.headers["content-length"] || Number(req.headers["content-length"]) <= limit);
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        requestBytes += chunk.length;
        assert.ok(requestBytes <= limit);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      evidence.bodySha256 = sha(bytes);
      const json = (value: unknown) =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (path === "/security-screen") {
        phase = "security";
        assert.ok(equal(req.headers["x-api-key"] as string | undefined, profile.security.token));
        assert.equal(req.headers.authorization, undefined);
        const input = JSON.parse(bytes.toString());
        assert.ok(input && typeof input === "object" && !Array.isArray(input));
        assert.ok(typeof input.text === "string" && input.text.length <= 1600);
        assert.ok(["user_input", "tool_response"].includes(input.hook));
        const qm = input.metadata?.qm;
        assert.ok(qm && typeof qm.request_id === "string" && qm.request_id.length > 0 && qm.request_id.length <= 256);
        assert.equal(qm.input_index, 0);
        assert.ok(Number.isSafeInteger(qm.chunk_count) && qm.chunk_count > 0 && qm.chunk_count <= 12);
        assert.ok(Number.isSafeInteger(qm.chunk_index) && qm.chunk_index >= 0 && qm.chunk_index < qm.chunk_count);
        const digest = sha(input.text);
        assert.ok(allow.has(digest) || deny.has(digest), "Unrecognized synthetic security text");
        verified = true;
        Object.assign(evidence, {
          hook: input.hook,
          requestId: qm.request_id,
          chunkIndex: qm.chunk_index,
          chunkCount: qm.chunk_count,
          verdict: deny.has(digest) ? "strict" : "auto",
        });
        await delay(profile.security.delayMs, undefined, { signal: disconnected.signal });
        status = 200;
        json({
          score: deny.has(digest) ? 0.9 : 0.1,
          threshold: 0.5,
          primary_outcome: deny.has(digest) ? "fixture_block" : "fixture_allow",
        });
        return;
      }
      phase = "gateway-credentials";
      assert.ok(equal(req.headers[profile.apiKeyHeader] as string | undefined, profile.apiKey));
      const authorization = req.headers.authorization;
      assert.ok(typeof authorization === "string");
      const fields =
        /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/execute-api\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/.exec(
          authorization,
        );
      assert.ok(fields && fields[1] === profile.accessKeyId && fields[3] === profile.region);
      const date = req.headers["x-amz-date"];
      assert.ok(typeof date === "string" && /^\d{8}T\d{6}Z$/.test(date) && date.startsWith(fields[2]!));
      const signingDate = new Date(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
      );
      assert.ok(Math.abs(Date.now() - signingDate.getTime()) <= 300000);
      assert.ok(equal(req.headers["x-amz-security-token"] as string | undefined, profile.sessionToken));
      phase = "gateway-signed-headers";
      const names = fields[4]!.split(";");
      evidence.signedHeaderNames = names;
      assert.deepEqual(names, [...new Set(names)].sort());
      assert.ok(["host", "x-amz-date", "x-amz-security-token"].every((name) => names.includes(name)));
      const headers: Record<string, string> = {};
      for (const name of names) {
        assert.equal(typeof req.headers[name], "string");
        headers[name] = req.headers[name] as string;
      }
      if (req.headers["x-amz-content-sha256"] !== undefined)
        assert.equal(req.headers["x-amz-content-sha256"], sha(bytes));
      phase = "gateway-signature";
      const signed = await signer.sign(
        {
          method: req.method!,
          protocol: "https:",
          hostname: profile.authority.split(":")[0]!,
          path,
          headers,
          body: bytes,
        },
        { signingDate, signableHeaders: new Set(names) },
      );
      assert.ok(equal(authorization, signed.headers.authorization!), "Signature mismatch");
      verified = true;
      phase = "gateway-response";
      if (path === "/v1/models") {
        assert.equal(bytes.length, 0);
        status = 200;
        json({ data: profile.models.map((model) => ({ id: model.id })) });
      } else if (path === "/model_group/info") {
        assert.equal(bytes.length, 0);
        status = 200;
        json({
          data: profile.models.map((model) => ({
            model_group: model.id,
            mode: "chat",
            providers: ["anthropic"],
            supports_function_calling: true,
            max_input_tokens: model.contextWindow,
            max_output_tokens: model.maxOutputTokens,
            input_cost_per_token: model.inputCost / 1000000,
            output_cost_per_token: model.outputCost / 1000000,
          })),
        });
      } else {
        const input = JSON.parse(bytes.toString());
        assert.ok(
          input &&
            typeof input === "object" &&
            !Array.isArray(input) &&
            profile.models.some((model) => model.id === input.model),
        );
        const selected = profile.models.find((model) => model.id === input.model)!;
        const forwarded = JSON.stringify({ ...input, model: selected.upstreamModelId });
        evidence.forwardedBodySha256 = sha(forwarded);
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        const upstreamResponse = await fetch(new URL(path, upstream), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": profile.upstreamToken,
            "anthropic-version": "2023-06-01",
          },
          body: forwarded,
          redirect: "error",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
        });
        status = upstreamResponse.status;
        evidence.upstreamStatus = status;
        res.writeHead(status, {
          "content-type": upstreamResponse.headers.get("content-type") ?? "application/octet-stream",
        });
        assert.ok(upstreamResponse.body);
        await pipeline(Readable.fromWeb(upstreamResponse.body), res);
      }
    } catch {
      status = res.headersSent ? status : 400;
      evidence.failed = true;
      evidence.failurePhase = phase;
      if (!res.headersSent)
        res.writeHead(status, { "content-type": "application/json" }).end('{"error":"Fixture request rejected"}');
      else res.destroy();
    } finally {
      try {
        await finished(res, { cleanup: true });
      } catch {
        disconnected.abort();
      }
      evidence.completed = res.writableFinished && !disconnected.signal.aborted;
      evidence.aborted = disconnected.signal.aborted;
      record({ ...evidence, path, verified, status, requestBytes, durationMs: Date.now() - start });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
