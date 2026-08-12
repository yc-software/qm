import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { EncryptedEnvelope, RelayRequest } from "../common/protocol.js";
import { PairingStore } from "./store.js";

interface RelayOptions {
  stateFile?: string;
  publicUrl?: string;
  requestTimeoutMs?: number;
  pairingTtlMs?: number;
}

interface PendingResponse {
  resolve: (envelope: EncryptedEnvelope) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class Broker {
  private readonly queues = new Map<string, RelayRequest[]>();
  private readonly waiters = new Map<
    string,
    Array<(request?: RelayRequest) => void>
  >();
  private readonly responses = new Map<string, PendingResponse>();

  dispatch(
    deviceId: string,
    request: RelayRequest,
    timeoutMs: number,
  ): Promise<EncryptedEnvelope> {
    if (this.responses.has(request.requestId)) {
      return Promise.reject(new Error("Duplicate request id"));
    }
    const response = new Promise<EncryptedEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(request.requestId);
        this.removeQueued(deviceId, request.requestId);
        reject(
          new Error("Inwise Desktop is offline or did not respond in time"),
        );
      }, timeoutMs);
      this.responses.set(request.requestId, { resolve, reject, timer });
    });
    const waiter = this.waiters.get(deviceId)?.shift();
    if (waiter) waiter(request);
    else
      this.queues.set(deviceId, [
        ...(this.queues.get(deviceId) ?? []),
        request,
      ]);
    return response;
  }

  poll(deviceId: string, waitMs: number): Promise<RelayRequest | undefined> {
    const queue = this.queues.get(deviceId);
    const next = queue?.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      const wrapped = (request?: RelayRequest): void => {
        clearTimeout(timer);
        resolve(request);
      };
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(deviceId) ?? [];
        this.waiters.set(
          deviceId,
          waiters.filter((item) => item !== wrapped),
        );
        resolve(undefined);
      }, waitMs);
      this.waiters.set(deviceId, [
        ...(this.waiters.get(deviceId) ?? []),
        wrapped,
      ]);
    });
  }

  respond(requestId: string, envelope: EncryptedEnvelope): boolean {
    const pending = this.responses.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.responses.delete(requestId);
    pending.resolve(envelope);
    return true;
  }

  private removeQueued(deviceId: string, requestId: string): void {
    const queue = this.queues.get(deviceId) ?? [];
    this.queues.set(
      deviceId,
      queue.filter((item) => item.requestId !== requestId),
    );
  }
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer "))
    throw new ApiError(401, "Missing bearer token");
  return value.slice("Bearer ".length);
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new ApiError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
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

export function createRelayServer(options: RelayOptions = {}): Server {
  const store = new PairingStore(options.stateFile);
  const broker = new Broker();
  const requestTimeoutMs = options.requestTimeoutMs ?? 45_000;
  const pairingTtlMs = options.pairingTtlMs ?? 10 * 60_000;

  return createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://relay.invalid");
      const segments = url.pathname.split("/").filter(Boolean);

      if (method === "GET" && url.pathname === "/healthz") {
        send(response, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/pairings") {
        const body = await readJson(request);
        const created = store.create(
          stringField(body, "cliPublicKey"),
          pairingTtlMs,
        );
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
        const claimed = store.claim(
          stringField(body, "code").toUpperCase(),
          stringField(body, "edgePublicKey"),
          stringField(body, "deviceName"),
        );
        send(response, 200, claimed);
        return;
      }

      if (
        segments[0] === "v1" &&
        segments[1] === "pairings" &&
        segments.length === 3
      ) {
        if (method !== "GET") throw new ApiError(405, "Method not allowed");
        const record = store.authenticateCli(segments[2], bearer(request));
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

      if (
        segments[0] === "v1" &&
        segments[1] === "pairings" &&
        segments[3] === "requests" &&
        segments.length === 4
      ) {
        if (method !== "POST") throw new ApiError(405, "Method not allowed");
        const record = store.authenticateCli(segments[2], bearer(request));
        if (!record) throw new ApiError(401, "Invalid pairing credentials");
        if (!record.deviceId)
          throw new ApiError(409, "Inwise has not been paired yet");
        const body = await readJson(request);
        const requestId = stringField(body, "requestId");
        const result = await broker.dispatch(
          record.deviceId,
          { pairingId: record.id, requestId, envelope: envelopeField(body) },
          requestTimeoutMs,
        );
        send(response, 200, { requestId, envelope: result });
        return;
      }

      if (
        segments[0] === "v1" &&
        segments[1] === "devices" &&
        segments[3] === "requests" &&
        segments.length === 4
      ) {
        if (method !== "GET") throw new ApiError(405, "Method not allowed");
        const record = store.authenticateEdge(segments[2], bearer(request));
        if (!record) throw new ApiError(401, "Invalid device credentials");
        const waitSeconds = Math.min(
          30,
          Math.max(1, Number(url.searchParams.get("wait") ?? 25)),
        );
        const next = await broker.poll(segments[2], waitSeconds * 1_000);
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
        const record = store.authenticateEdge(segments[2], bearer(request));
        if (!record) throw new ApiError(401, "Invalid device credentials");
        const body = await readJson(request);
        if (!broker.respond(segments[4], envelopeField(body))) {
          throw new ApiError(404, "Request is no longer pending");
        }
        send(response, 204);
        return;
      }

      throw new ApiError(404, "Not found");
    } catch (error) {
      if (error instanceof ApiError) {
        send(response, error.status, { error: error.message });
      } else {
        const message =
          error instanceof Error ? error.message : "Unexpected relay error";
        const status = message.includes("offline") ? 504 : 400;
        send(response, status, { error: message });
      }
    }
  });
}
