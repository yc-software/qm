import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import {
  createWorkloadProvider,
  parseProviderTurn,
  validateProvider,
  workloadCheck,
  type ProviderProfile,
} from "./workload-provider.ts";
import type { WorkloadFixture } from "./workload.ts";
import { materializeReply, validateMaterializeShape, type MaterializeShape } from "./workload-materialize.ts";
import { nativeReply, validateNativeShapes, type NativeShape } from "./workload-native.ts";

interface ResponsePacing {
  delayMs: number;
  chunkCharacters: number;
  chunkIntervalMs: number;
}

export interface CompanionProfile {
  schemaVersion: 1;
  fixtureId: string;
  host: string;
  port: number;
  tokenEnv: string;
  utilities: Array<ResponsePacing & { name: string; model: string; systemSha256: string; response: string }>;
  loop?: ResponsePacing & { model: string; shipAction: string };
  materialize?: MaterializeShape;
  nativeShapes?: NativeShape[];
}

export function promptSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function textContent(content: unknown, strict = false): string {
  if (typeof content === "string") return content;
  workloadCheck(Array.isArray(content), "Expected text content");
  if (strict)
    workloadCheck(
      content.every((block) => block?.type === "text" && typeof block.text === "string"),
      "Text only",
    );
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function companionReply(body: Record<string, unknown>, profile: CompanionProfile) {
  workloadCheck(Array.isArray(body.messages) && body.messages.length > 0, "Messages required");
  workloadCheck(body.stream === undefined || typeof body.stream === "boolean", "Invalid stream flag");
  const messages = body.messages as Array<{ role?: string; content?: unknown }>;
  const lastUser = messages.findLast((message) => message.role === "user");
  workloadCheck(lastUser, "User message required");
  const latest = textContent(lastUser.content);
  const systemSha256 = promptSha256(body.system === undefined ? "" : textContent(body.system, true));
  const utility = profile.utilities.find((rule) => rule.model === body.model && rule.systemSha256 === systemSha256);
  if (utility) {
    workloadCheck(messages.length === 1 && messages[0]?.role === "user", "Utility requires one user message");
    textContent(lastUser.content, true);
    workloadCheck(
      body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0),
      "Utility tools forbidden",
    );
    return { rule: utility.name, systemSha256, text: utility.response, pacing: utility };
  }
  const native = nativeReply(body, profile.fixtureId, profile.nativeShapes);
  if (native) return { ...native, systemSha256 };
  const materialize = materializeReply(body, profile.fixtureId, profile.materialize);
  if (materialize)
    return { ...materialize, systemSha256, pacing: { delayMs: 0, chunkCharacters: 1024, chunkIntervalMs: 0 } };
  const stages = [...latest.matchAll(/^\[Loop (intake|work|judge)\]$/gm)];
  if (stages.length) {
    workloadCheck(profile.loop && body.model === profile.loop.model, "Loop model not allowed");
    workloadCheck(stages.length === 1, "Ambiguous loop stage");
    const stage = stages[0]![1]!;
    workloadCheck(latest.includes(`[End loop ${stage}]`), "Incomplete loop stage");
    const markers = [...latest.matchAll(/\[qm-perf-loop:([a-zA-Z0-9_.-]+):([a-zA-Z0-9_.-]+)\]/g)];
    workloadCheck(
      markers.length > 0 && new Set(markers.map((match) => match[0])).size === 1,
      "Unique loop marker required",
    );
    workloadCheck(markers[0]![1] === profile.fixtureId, "Loop fixture mismatch");
    const marker = markers[0]![0];
    let value: Record<string, unknown>;
    if (stage === "intake")
      value = {
        items: [
          {
            sourceKey: `${marker}/${promptSha256(JSON.stringify(body)).slice(0, 20)}`,
            sourceSummary: "Synthetic performance fixture item",
          },
        ],
      };
    else if (stage === "work")
      value = {
        outputs: [
          {
            shipAction: profile.loop.shipAction,
            title: "Synthetic fixture output",
            summary: "Prepared for fixture review",
          },
        ],
      };
    else value = { outcome: "met", reason: "Synthetic fixture output prepared for review", checks: [] };
    return { rule: `loop-${stage}`, systemSha256, text: JSON.stringify(value), pacing: profile.loop };
  }
  return null;
}

function validateFrozenTurn(body: Record<string, unknown>, profile: ProviderProfile): void {
  const messages = body.messages as Array<{ role?: string; content?: unknown }>;
  let index = messages.length - 1;
  while (index >= 0) {
    const current = messages[index];
    workloadCheck(current?.role === "user", "Current user turn required");
    const content = current.content;
    if (!Array.isArray(content) || !content.some((block) => block?.type === "tool_result")) {
      parseProviderTurn({ ...body, messages: [current] }, profile);
      parseProviderTurn(body, profile);
      return;
    }
    workloadCheck(
      content.length === 1 && content[0]?.type === "tool_result",
      "Only the expected tool result may continue a turn",
    );
    const result = content[0];
    workloadCheck(
      typeof result.tool_use_id === "string" && result.is_error !== true,
      "Successful tool result required",
    );
    textContent(result.content, true);
    const previous = messages[index - 1];
    workloadCheck(
      index >= 2 && previous?.role === "assistant" && Array.isArray(previous.content),
      "Tool result requires its preceding assistant call",
    );
    const calls = previous.content.filter((block) => block?.type === "tool_use");
    const expected = parseProviderTurn({ ...body, messages: messages.slice(0, index - 1) }, profile);
    workloadCheck(
      calls.length === 1 && expected.step < expected.shape.modelCalls - 1,
      "One expected files read required",
    );
    const call = calls[0];
    workloadCheck(
      call.id === expected.toolId &&
        result.tool_use_id === call.id &&
        call.name === "files" &&
        call.input?.action === "read" &&
        call.input?.path === expected.shape.readPath,
      "Tool continuation identity mismatch",
    );
    index -= 2;
  }
  throw new Error("Marked originating turn required");
}

function validateCompanion(
  profile: CompanionProfile,
  provider: ProviderProfile,
  fixture: WorkloadFixture,
  env: NodeJS.ProcessEnv,
) {
  const token = validateProvider(
    { ...provider, host: profile.host, port: profile.port, tokenEnv: profile.tokenEnv },
    fixture,
    env,
  );
  workloadCheck(profile.schemaVersion === 1 && profile.fixtureId === fixture.fixtureId, "Companion fixture mismatch");
  workloadCheck(
    provider.tokenEnv === profile.tokenEnv,
    "Companion and provider must share the synthetic token binding",
  );
  workloadCheck(Array.isArray(profile.utilities), "Utility allowlist required");
  const pairs = new Set<string>();
  const names = new Set<string>();
  for (const utility of profile.utilities) {
    workloadCheck(/^[a-zA-Z0-9_-]+$/.test(utility.name) && !names.has(utility.name), "Unique utility names required");
    names.add(utility.name);
    workloadCheck(/^[a-f0-9]{64}$/.test(utility.systemSha256), "Exact utility prompt SHA-256 required");
    const pair = `${utility.model}:${utility.systemSha256}`;
    workloadCheck(!pairs.has(pair), "Duplicate utility prompt/model pair");
    pairs.add(pair);
    workloadCheck(
      typeof utility.response === "string" &&
        utility.response.length > 0 &&
        Buffer.byteLength(utility.response) <= 1_000_000,
      "Bounded utility response required",
    );
  }
  if (profile.materialize) validateMaterializeShape(profile.materialize);
  if (profile.nativeShapes) validateNativeShapes(profile.nativeShapes);
  if (profile.loop) workloadCheck(/^[a-zA-Z0-9_-]+$/.test(profile.loop.shipAction), "Safe loop ship action required");
  for (const rule of [...profile.utilities, ...(profile.loop ? [profile.loop] : [])]) {
    workloadCheck(typeof rule.model === "string" && rule.model.length > 0, "Rule model required");
    for (const field of ["delayMs", "chunkIntervalMs"] as const)
      workloadCheck(Number.isInteger(rule[field]) && rule[field] >= 0 && rule[field] <= 600_000, `Invalid ${field}`);
    workloadCheck(
      Number.isInteger(rule.chunkCharacters) && rule.chunkCharacters > 0 && rule.chunkCharacters <= 1_000_000,
      "Invalid chunkCharacters",
    );
  }
  return token;
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) =>
      error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve(),
    );
  });
}

export async function createWorkloadCompanion(
  profile: CompanionProfile,
  providerProfile: ProviderProfile,
  fixture: WorkloadFixture,
  emit: (record: Record<string, unknown>) => void,
  env = process.env,
) {
  const token = validateCompanion(profile, providerProfile, fixture, env);
  const profileSha256 = promptSha256(JSON.stringify(profile));
  let resolveProviderIdle: (() => void) | undefined;
  let resolveCompanionIdle: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const provider = createWorkloadProvider(
    providerProfile,
    fixture,
    (record) => {
      emit(record);
      if (provider.totals.active === 0) resolveProviderIdle?.();
    },
    env,
  );
  provider.server.listen(0, "127.0.0.1");
  await once(provider.server, "listening");
  const address = provider.server.address();
  workloadCheck(address && typeof address !== "string", "Local provider listener required");
  const providerUrl = `http://127.0.0.1:${address.port}/v1/messages`;
  const totals = { calls: 0, errors: 0, forwarded: 0, active: 0, maxActive: 0, requestBytes: 0, responseBytes: 0 };
  const server = createServer(async (req, res) => {
    if (req.headers["x-api-key"] !== token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && req.url === "/__qm_performance") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          fixtureId: fixture.fixtureId,
          populationSha256: fixture.profileSha256,
          providerProfileSha256: provider.profileSha256,
          companionProfileSha256: profileSha256,
          model: providerProfile.model,
          totals: provider.totals,
          companionTotals: totals,
          qualified: false,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      const models = [
        ...new Set([
          providerProfile.model,
          ...profile.utilities.map((rule) => rule.model),
          ...(profile.loop ? [profile.loop.model] : []),
          ...(profile.materialize ? [profile.materialize.model] : []),
          ...(profile.nativeShapes?.map((shape) => shape.model) ?? []),
        ]),
      ];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: models.map((id) => ({ id, type: "model", display_name: id })), has_more: false }));
      return;
    }
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/messages") {
      res.writeHead(404).end();
      return;
    }
    const startedAt = Date.now();
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    let requestBytes = 0;
    let requestGzipBytes = 0;
    let responseBytes = 0;
    let firstDeltaAt: number | null = null;
    let rule: string | null = null;
    let systemSha256: string | null = null;
    let requestSha256: string | null = null;
    let error: string | null = null;
    let streaming = false;
    let native: Record<string, unknown> | undefined;
    totals.active++;
    totals.maxActive = Math.max(totals.maxActive, totals.active);
    try {
      const buffers: Buffer[] = [];
      for await (const chunk of req) {
        requestBytes += chunk.length;
        workloadCheck(requestBytes <= 32_000_000, "Companion request exceeds safety limit");
        buffers.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(buffers);
      requestGzipBytes = gzipSync(raw).byteLength;
      requestSha256 = promptSha256(raw.toString());
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        throw new Error("Invalid JSON request");
      }
      workloadCheck(body && typeof body === "object" && !Array.isArray(body), "Request object required");
      systemSha256 = promptSha256(body.system === undefined ? "" : textContent(body.system, true));
      const reply = companionReply(body, profile);
      streaming = body.stream === true;
      if (!reply) {
        workloadCheck(
          Array.isArray(body.tools) && body.tools.some((tool) => tool?.name === "files"),
          "Frozen turns require the actual QM tool set",
        );
        validateFrozenTurn(body, providerProfile);
        rule = "frozen-provider";
        totals.forwarded++;
        const forwarded = await fetch(providerUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": token },
          body: raw,
          signal: abort.signal,
          redirect: "error",
        });
        workloadCheck(forwarded.ok && forwarded.body, "Frozen provider rejected request");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for await (const chunk of forwarded.body) {
          responseBytes += chunk.byteLength;
          res.write(chunk);
        }
        res.end();
        return;
      }
      ({ rule, systemSha256 } = reply);
      native = "native" in reply ? reply.native : undefined;
      totals.calls++;
      const tools = "tools" in reply ? reply.tools : "tool" in reply && reply.tool ? [reply.tool] : [];
      const content: Array<
        { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }
      > = [
        ...(tools.length === 0 || native ? [{ type: "text" as const, text: reply.text }] : []),
        ...tools.map((tool) => ({ type: "tool_use" as const, ...tool })),
      ];
      const usage = {
        input_tokens: Math.ceil(requestBytes / 4),
        output_tokens: Math.ceil(
          content.reduce(
            (bytes, block) =>
              bytes + Buffer.byteLength(block.type === "text" ? block.text : JSON.stringify(block.input)),
            0,
          ) / 4,
        ),
      };
      const stopReason = tools.length ? "tool_use" : "end_turn";
      const message = {
        id: `msg_perf_${requestSha256.slice(0, 24)}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage,
      };
      await sleep(reply.pacing.delayMs, undefined, { signal: abort.signal });
      if (!streaming) {
        const json = JSON.stringify(message);
        responseBytes = Buffer.byteLength(json);
        firstDeltaAt = Date.now();
        res.writeHead(200, { "content-type": "application/json" }).end(json);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (type: string, data: Record<string, unknown>) => {
        abort.signal.throwIfAborted();
        const frame = `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        responseBytes += Buffer.byteLength(frame);
        res.write(frame);
      };
      send("message_start", {
        message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } },
      });
      for (const [index, block] of content.entries()) {
        const tool = block.type === "tool_use";
        send("content_block_start", {
          index,
          content_block: tool ? { ...block, input: {} } : { type: "text", text: "" },
        });
        const characters = [...(tool ? JSON.stringify(block.input) : block.text)];
        for (let offset = 0; offset < characters.length; offset += reply.pacing.chunkCharacters) {
          if (offset) await sleep(reply.pacing.chunkIntervalMs, undefined, { signal: abort.signal });
          firstDeltaAt ??= Date.now();
          const chunk = characters.slice(offset, offset + reply.pacing.chunkCharacters).join("");
          send("content_block_delta", {
            index,
            delta: tool ? { type: "input_json_delta", partial_json: chunk } : { type: "text_delta", text: chunk },
          });
        }
        send("content_block_stop", { index });
      }
      send("message_delta", {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      });
      send("message_stop", {});
      res.end();
    } catch (caught) {
      totals.errors++;
      error = caught instanceof Error ? caught.message : "Companion failure";
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: error } }));
    } finally {
      totals.active--;
      totals.requestBytes += requestBytes;
      totals.responseBytes += responseBytes;
      emit({
        schemaVersion: 1,
        type: "companion-call",
        qualified: false,
        fixtureId: fixture.fixtureId,
        profileSha256: fixture.profileSha256,
        companionProfileSha256: profileSha256,
        rule,
        systemSha256,
        requestSha256,
        streaming,
        ...(native ? { native } : {}),
        startedAt,
        finishedAt: Date.now(),
        firstDeltaAt,
        requestBytes,
        requestGzipBytes,
        responseBytes,
        error,
        active: totals.active,
      });
      if (totals.active === 0) resolveCompanionIdle?.();
    }
  });
  return {
    server,
    totals,
    provider,
    profileSha256,
    close: () =>
      (closing ??= (async () => {
        await Promise.all([stop(server), stop(provider.server)]);
        if (totals.active > 0)
          await new Promise<void>((resolve) => {
            resolveCompanionIdle = resolve;
          });
        if (provider.totals.active > 0)
          await new Promise<void>((resolve) => {
            resolveProviderIdle = resolve;
          });
      })()),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      provider: { type: "string" },
      fixture: { type: "string" },
      out: { type: "string" },
    },
  });
  workloadCheck(
    values.profile && values.provider && values.fixture && values.out,
    "Pass --profile, --provider, --fixture and --out",
  );
  const profile = JSON.parse(readFileSync(values.profile, "utf8")) as CompanionProfile;
  const provider = JSON.parse(readFileSync(values.provider, "utf8")) as ProviderProfile;
  const fixture = JSON.parse(readFileSync(values.fixture, "utf8")) as WorkloadFixture;
  validateCompanion(profile, provider, fixture, process.env);
  const fd = openSync(values.out, "wx", 0o600);
  const companion = await createWorkloadCompanion(profile, provider, fixture, (record) =>
    writeSync(fd, JSON.stringify(record) + "\n"),
  );
  companion.server.listen(profile.port, profile.host, () =>
    process.stdout.write(
      JSON.stringify({
        type: "companion-ready",
        fixtureId: fixture.fixtureId,
        profileSha256: companion.profileSha256,
        address: companion.server.address(),
        qualified: false,
      }) + "\n",
    ),
  );
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void companion
        .close()
        .then(() => closeSync(fd))
        .catch(() => {
          process.stderr.write("Companion shutdown failed\n");
          process.exitCode = 1;
        });
    });
}
