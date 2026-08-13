import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { EncryptedEnvelope } from "../common/protocol.js";
import { MemoryRelayStore, StoreError, type PairingAdmission, type RelayStore, type RequestState } from "./store.js";

export interface RelayOptions {
  store?: RelayStore;
  publicUrl?: string;
  requestTimeoutMs?: number;
  requestLeaseMs?: number;
  pairingTtlMs?: number;
  pairingRateLimit?: number;
  pairingRateWindowMs?: number;
  maxPendingPairingsPerSource?: number;
  maxPendingPairingsGlobal?: number;
  maxPairingsPerSource?: number;
  maxPairingsGlobal?: number;
  cleanupIntervalMs?: number;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) throw new ApiError(401, "Missing bearer token");
  return value.slice("Bearer ".length);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new ApiError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }
}

function send(response: ServerResponse, status: number, body?: unknown, retryAfterMs?: number): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (retryAfterMs !== undefined) {
    response.setHeader("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  }
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, `${name} is required`);
  }
  return value.trim();
}

function envelopeField(body: Record<string, unknown>): EncryptedEnvelope {
  const value = body.envelope as Partial<EncryptedEnvelope> | undefined;
  if (
    !value ||
    value.version !== 1 ||
    typeof value.iv !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.tag !== "string"
  ) {
    throw new ApiError(400, "A valid encrypted envelope is required");
  }
  return value as EncryptedEnvelope;
}

function sourceKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function stateBody(requestId: string, state: RequestState): unknown {
  return {
    requestId,
    status: state.status,
    expiresAt: state.expiresAt,
    ...(state.status === "responded" ? { envelope: state.envelope } : {}),
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createRelayServer(options: RelayOptions = {}): Server {
  const store = options.store ?? new MemoryRelayStore();
  const requestTimeoutMs = options.requestTimeoutMs ?? 45_000;
  const requestLeaseMs = options.requestLeaseMs ?? requestTimeoutMs;
  const pairingTtlMs = options.pairingTtlMs ?? 10 * 60_000;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
  const admissionDefaults: Omit<PairingAdmission, "sourceKey"> = {
    maxPerWindow: options.pairingRateLimit ?? 10,
    windowMs: options.pairingRateWindowMs ?? 60_000,
    maxPendingPerSource: options.maxPendingPairingsPerSource ?? 5,
    maxPendingGlobal: options.maxPendingPairingsGlobal ?? 1_000,
    maxTotalPerSource: options.maxPairingsPerSource ?? 100,
    maxTotalGlobal: options.maxPairingsGlobal ?? 10_000,
  };
  let initialized: Promise<void> | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;

  const ensureInitialized = async (): Promise<void> => {
    initialized ??= store.initialize().then(() => {
      cleanupTimer = setInterval(() => {
        void store.cleanup().catch((error) => {
          console.error("Inwise relay cleanup failed", error);
        });
      }, cleanupIntervalMs);
      cleanupTimer.unref();
    });
    await initialized;
  };

  const server = createServer(async (request, response) => {
    try {
      await ensureInitialized();
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://relay.invalid");
      const segments = url.pathname.split("/").filter(Boolean);

      if (method === "GET" && url.pathname === "/healthz") {
        send(response, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/pairings") {
        const body = await readJson(request);
        const created = await store.createPairing(stringField(body, "cliPublicKey"), pairingTtlMs, {
          ...admissionDefaults,
          sourceKey: sourceKey(request),
        });
        send(response, 201, {
          ...created,
          ...(options.publicUrl
            ? {
                pairCommand: `inwise-qm-edge pair --relay ${options.publicUrl} --code ${created.code}`,
              }
            : {}),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/pairings/claim") {
        const body = await readJson(request);
        const claimed = await store.claimPairing(
          stringField(body, "code").toUpperCase(),
          stringField(body, "edgePublicKey"),
          stringField(body, "deviceName"),
        );
        send(response, 200, claimed);
        return;
      }

      if (segments[0] === "v1" && segments[1] === "pairings" && segments.length === 3) {
        if (method !== "GET") throw new ApiError(405, "Method not allowed");
        const record = await store.authenticateCli(segments[2], bearer(request));
        if (!record) throw new ApiError(401, "Invalid pairing credentials");
        send(
          response,
          200,
          record.deviceId
            ? {
                status: "paired",
                edgePublicKey: record.edgePublicKey,
                deviceName: record.deviceName,
              }
            : { status: "pending", expiresAt: record.expiresAt },
        );
        return;
      }

      if (segments[0] === "v1" && segments[1] === "pairings" && segments[3] === "requests" && segments.length === 4) {
        if (method !== "POST") throw new ApiError(405, "Method not allowed");
        const record = await store.authenticateCli(segments[2], bearer(request));
        if (!record) throw new ApiError(401, "Invalid pairing credentials");
        if (!record.deviceId) throw new ApiError(409, "Inwise has not been paired yet");
        const body = await readJson(request);
        const requestId = stringField(body, "requestId");
        const state = await store.enqueueRequest(
          record.deviceId,
          { pairingId: record.id, requestId, envelope: envelopeField(body) },
          requestTimeoutMs,
        );
        send(response, state.status === "responded" ? 200 : 202, stateBody(requestId, state));
        return;
      }

      if (segments[0] === "v1" && segments[1] === "pairings" && segments[3] === "requests" && segments.length === 5) {
        if (method !== "GET") throw new ApiError(405, "Method not allowed");
        const record = await store.authenticateCli(segments[2], bearer(request));
        if (!record) throw new ApiError(401, "Invalid pairing credentials");
        const state = await store.getRequest(record.id, segments[4]);
        if (!state) throw new ApiError(404, "Request not found");
        if (state.status === "expired") throw new ApiError(504, "Inwise Desktop is offline or did not respond in time");
        send(response, 200, stateBody(segments[4], state));
        return;
      }

      if (segments[0] === "v1" && segments[1] === "devices" && segments[3] === "requests" && segments.length === 4) {
        if (method !== "GET") throw new ApiError(405, "Method not allowed");
        const record = await store.authenticateEdge(segments[2], bearer(request));
        if (!record) throw new ApiError(401, "Invalid device credentials");
        const waitSeconds = Math.min(30, Math.max(0, Number(url.searchParams.get("wait") ?? 25)));
        const deadline = Date.now() + waitSeconds * 1_000;
        let next = await store.leaseRequest(segments[2], requestLeaseMs);
        while (!next && Date.now() < deadline) {
          await delay(Math.min(250, deadline - Date.now()));
          next = await store.leaseRequest(segments[2], requestLeaseMs);
        }
        send(response, next ? 200 : 204, next);
        return;
      }

      if (
        segments[0] === "v1" &&
        segments[1] === "devices" &&
        segments[3] === "requests" &&
        segments[5] === "response" &&
        segments.length === 6
      ) {
        if (method !== "POST") throw new ApiError(405, "Method not allowed");
        const record = await store.authenticateEdge(segments[2], bearer(request));
        if (!record) throw new ApiError(401, "Invalid device credentials");
        const body = await readJson(request);
        if (!(await store.respond(segments[2], segments[4], envelopeField(body)))) {
          throw new ApiError(404, "Request is no longer pending");
        }
        send(response, 204);
        return;
      }

      throw new ApiError(404, "Not found");
    } catch (error) {
      if (error instanceof ApiError || error instanceof StoreError) {
        send(response, error.status, { error: error.message }, error.retryAfterMs);
      } else {
        const message = error instanceof Error ? error.message : "Unexpected relay error";
        send(response, 500, { error: message });
      }
    }
  });

  server.on("close", () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    void store.close();
  });
  return server;
}
