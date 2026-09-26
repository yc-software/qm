import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import type { WorkloadFixture } from "./workload.ts";

export interface ProviderShape {
  name: string;
  modelCalls: number;
  inputBytes: number;
  outputBytes: number;
  delayMs: number;
  chunkBytes: number;
  chunkIntervalMs: number;
  repeatedFraction: number;
  readPath?: string;
}

export interface ProviderProfile {
  schemaVersion: 1;
  fixtureId: string;
  model: string;
  tokenEnv: string;
  host: string;
  port: number;
  shapes: ProviderShape[];
}

export function workloadCheck(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function syntheticText(seed: string, bytes: number, repeatedFraction: number): string {
  const repeated = "Performance fixture text with deterministic synthetic content. ";
  const repeatedBytes = Math.floor(bytes * repeatedFraction);
  let text = repeated.repeat(Math.ceil(repeatedBytes / repeated.length)).slice(0, repeatedBytes);
  for (let i = 0; text.length < bytes; i++)
    text += createHash("sha256").update(`${seed}:${i}`).digest("base64url") + " ";
  return text.slice(0, bytes);
}

export function validateProvider(profile: ProviderProfile, fixture: WorkloadFixture, env = process.env): string {
  workloadCheck(profile.schemaVersion === 1 && fixture.schemaVersion === 1, "Unsupported provider schema");
  workloadCheck(
    profile.fixtureId === fixture.fixtureId && /^qm_perf_\w+$/.test(fixture.databaseName),
    "Provider fixture mismatch",
  );
  workloadCheck(/^[a-zA-Z0-9_.-]+$/.test(profile.fixtureId), "Fixture ID must be safe for a turn marker");
  workloadCheck(typeof profile.model === "string" && profile.model.length > 0, "Provider model required");
  workloadCheck(
    ["127.0.0.1", "localhost", "::1"].includes(profile.host) || env.QM_PERFORMANCE_BIND_HOST === profile.host,
    "Remote bind requires an exact QM_PERFORMANCE_BIND_HOST",
  );
  workloadCheck(Number.isInteger(profile.port) && profile.port >= 0 && profile.port <= 65535, "Invalid provider port");
  const token = env[profile.tokenEnv];
  workloadCheck(
    typeof token === "string" && token.startsWith("qm-perf-") && token.length >= 24,
    "Provider requires an explicitly synthetic qm-perf- token",
  );
  const names = new Set<string>();
  for (const shape of profile.shapes) {
    workloadCheck(/^[a-zA-Z0-9_-]+$/.test(shape.name) && !names.has(shape.name), "Unique safe shape names required");
    names.add(shape.name);
    for (const key of ["modelCalls", "inputBytes", "outputBytes", "chunkBytes"] as const)
      workloadCheck(Number.isSafeInteger(shape[key]) && shape[key] > 0, `Invalid ${key}`);
    workloadCheck(
      shape.modelCalls <= 1000 && shape.inputBytes <= 1_000_000 && shape.outputBytes <= 1_000_000,
      "Provider shape exceeds safety bound",
    );
    for (const key of ["delayMs", "chunkIntervalMs"] as const)
      workloadCheck(Number.isSafeInteger(shape[key]) && shape[key] >= 0 && shape[key] <= 600_000, `Invalid ${key}`);
    workloadCheck(shape.repeatedFraction >= 0 && shape.repeatedFraction <= 1, "Invalid repeated fraction");
    workloadCheck(
      shape.modelCalls === 1 ||
        (typeof shape.readPath === "string" &&
          shape.readPath.length > 0 &&
          !shape.readPath.split("/").includes("..") &&
          !shape.readPath.startsWith("/")),
      "Multi-call shapes require a fixture-relative read path",
    );
  }
  workloadCheck(names.size > 0, "Provider shapes required");
  return token;
}

export function turnMarker(fixtureId: string, shape: string, nonce: string): string {
  workloadCheck(/^[a-zA-Z0-9_.-]+$/.test(nonce), "Unsafe turn nonce");
  return `[qm-perf:${fixtureId}:${shape}:${nonce}]`;
}

export function parseProviderTurn(body: Record<string, unknown>, profile: ProviderProfile) {
  workloadCheck(
    body.model === profile.model && body.stream === true && Array.isArray(body.messages),
    "Expected configured streaming model",
  );
  const messages = body.messages as Array<{ role?: string; content?: unknown }>;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    let content = typeof message.content === "string" ? message.content : "";
    if (Array.isArray(message.content))
      content = message.content
        .filter((item) => item?.type === "text")
        .map((item) => item.text)
        .join("\n");
    const marker = /\[qm-perf:([a-zA-Z0-9_.-]+):([a-zA-Z0-9_-]+):([a-zA-Z0-9_.-]+)\]/.exec(content);
    if (!marker) continue;
    workloadCheck(marker[1] === profile.fixtureId, "Provider turn fixture mismatch");
    const shape = profile.shapes.find((item) => item.name === marker[2]);
    workloadCheck(shape, "Unknown provider shape");
    const nonce = marker[3]!;
    const toolPrefix = `qmperf_${createHash("sha256").update(nonce).digest("hex").slice(0, 16)}_`;
    const step = messages
      .slice(index + 1)
      .flatMap((item) => (item.role === "assistant" && Array.isArray(item.content) ? item.content : []))
      .filter((item) => item?.type === "tool_use" && String(item.id).startsWith(toolPrefix)).length;
    workloadCheck(step < shape.modelCalls, "Provider exceeded configured model calls");
    if (step < shape.modelCalls - 1)
      workloadCheck(
        Array.isArray(body.tools) &&
          body.tools.some((tool) => {
            const definition = tool as {
              name?: string;
              input_schema?: { properties?: { action?: { const?: string; anyOf?: Array<{ const?: string }> } } };
            };
            const action = definition.input_schema?.properties?.action;
            return (
              definition.name === "files" &&
              (action?.const === "read" || action?.anyOf?.some((option) => option.const === "read"))
            );
          }),
        "Real read tool unavailable",
      );
    return { shape, nonce, step, toolId: `${toolPrefix}${step}` };
  }
  throw new Error("Provider refuses unmarked turns and auxiliary model calls");
}

export function createWorkloadProvider(
  profile: ProviderProfile,
  fixture: WorkloadFixture,
  emit: (record: Record<string, unknown>) => void,
  env = process.env,
) {
  const token = validateProvider(profile, fixture, env);
  const profileSha256 = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  const totals = { calls: 0, errors: 0, active: 0, maxActive: 0, requestBytes: 0, responseBytes: 0, chunks: 0 };
  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const authorized = req.headers["x-api-key"] === token || req.headers.authorization === `Bearer ${token}`;
    if (!authorized) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/__qm_performance") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          fixtureId: fixture.fixtureId,
          populationSha256: fixture.profileSha256,
          providerProfileSha256: profileSha256,
          model: profile.model,
          totals,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ data: [{ id: profile.model, type: "model", display_name: profile.model }], has_more: false }),
      );
      return;
    }
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/messages") {
      res.writeHead(404);
      res.end();
      return;
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    let requestBytes = 0;
    let responseBytes = 0;
    let chunks = 0;
    let shapeName: string | null = null;
    let nonce: string | null = null;
    let step: number | null = null;
    let firstDeltaAt: number | null = null;
    let error: string | null = null;
    let requestGzipBytes = 0;
    totals.active++;
    totals.maxActive = Math.max(totals.maxActive, totals.active);
    try {
      const data: Buffer[] = [];
      for await (const chunk of req) {
        requestBytes += chunk.length;
        workloadCheck(requestBytes <= 32_000_000, "Provider request exceeds safety limit");
        data.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(data);
      requestGzipBytes = gzipSync(raw).byteLength;
      const parsed = parseProviderTurn(JSON.parse(raw.toString()), profile);
      const { shape, toolId } = parsed;
      ({ nonce, step } = parsed);
      shapeName = shape.name;
      totals.calls++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (type: string, data: Record<string, unknown>) => {
        abort.signal.throwIfAborted();
        const frame = `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        responseBytes += Buffer.byteLength(frame);
        res.write(frame);
      };
      send("message_start", {
        message: {
          id: `msg_${toolId}`,
          type: "message",
          role: "assistant",
          content: [],
          model: profile.model,
          stop_reason: null,
          usage: { input_tokens: Math.ceil(requestBytes / 4), output_tokens: 0 },
        },
      });
      await sleep(shape.delayMs, undefined, { signal: abort.signal });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      const text = syntheticText(`${nonce}:${step}`, shape.outputBytes, shape.repeatedFraction);
      for (let offset = 0; offset < text.length; offset += shape.chunkBytes) {
        if (offset) await sleep(shape.chunkIntervalMs, undefined, { signal: abort.signal });
        firstDeltaAt ??= Date.now();
        send("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: text.slice(offset, offset + shape.chunkBytes) },
        });
        chunks++;
      }
      send("content_block_stop", { index: 0 });
      const read = step < shape.modelCalls - 1;
      if (read) {
        send("content_block_start", {
          index: 1,
          content_block: { type: "tool_use", id: toolId, name: "files", input: {} },
        });
        send("content_block_delta", {
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ action: "read", path: shape.readPath }) },
        });
        send("content_block_stop", { index: 1 });
      }
      send("message_delta", {
        delta: { stop_reason: read ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: Math.ceil(shape.outputBytes / 4) },
      });
      send("message_stop", {});
      res.end();
    } catch (caught) {
      totals.errors++;
      error = caught instanceof Error ? caught.message : "Provider failure";
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: error } }));
    } finally {
      totals.active--;
      totals.requestBytes += requestBytes;
      totals.responseBytes += responseBytes;
      totals.chunks += chunks;
      emit({
        schemaVersion: 1,
        type: "provider-call",
        fixtureId: fixture.fixtureId,
        profileSha256: fixture.profileSha256,
        providerProfileSha256: profileSha256,
        shape: shapeName,
        nonce,
        step,
        startedAt,
        finishedAt: Date.now(),
        firstDeltaAt,
        requestBytes,
        requestGzipBytes,
        responseBytes,
        chunks,
        error,
        active: totals.active,
      });
    }
  });
  return { server, totals, profileSha256 };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { profile: { type: "string" }, fixture: { type: "string" }, out: { type: "string" } },
  });
  workloadCheck(values.profile && values.fixture && values.out, "Pass --profile, --fixture and --out");
  const profile = JSON.parse(readFileSync(values.profile, "utf8")) as ProviderProfile;
  const fixture = JSON.parse(readFileSync(values.fixture, "utf8")) as WorkloadFixture;
  validateProvider(profile, fixture);
  const fd = openSync(values.out, "wx", 0o600);
  const { server } = createWorkloadProvider(profile, fixture, (record) => writeSync(fd, JSON.stringify(record) + "\n"));
  server.listen(profile.port, profile.host, () =>
    process.stdout.write(
      JSON.stringify({ type: "provider-ready", fixtureId: fixture.fixtureId, address: server.address() }) + "\n",
    ),
  );
  server.on("close", () => closeSync(fd));
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
}
