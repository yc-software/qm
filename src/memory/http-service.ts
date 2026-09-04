import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isStrongSigningSecret, SOURCE_AUTH_REPLAY_WINDOW_MS, verifySignature } from "../auth/source-auth.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { canonicalPayload, sendJson } from "../api/http.ts";
import { parseScopeId, type ScopeId, type ScopeKind } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import {
  MemoryOperationConflictError,
  MemoryOperationErasedError,
  recallBody,
  type IdempotentMemoryService,
  type MemoryCaptureOnceInput,
  type MemoryPurgeOnceInput,
} from "./memory-service.ts";
import { memoryAuditToken, memoryScopeToken } from "./privacy-tokens.ts";

const DEFAULT_MAX_BODY_BYTES = 32_768;
const MAX_FACTS = 20;
const MAX_FACT_CHARS = 1_000;
const MAX_QUERY_CHARS = 500;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface MemoryHttpServiceOptions {
  memory: IdempotentMemoryService;
  auditLog: AuditLog;
  integrationId: string;
  signingSecret: string;
  scopeTokenSecret: string;
  allowedScopeKinds: ReadonlySet<ScopeKind>;
  allowedScopePrefixes: readonly string[];
  maxBodyBytes?: number;
  now?: () => number;
}

class BodyTooLargeError extends Error {}

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

function parseOperationId(body: Record<string, unknown>): string | null {
  const value = body.operationId;
  return typeof value === "string" && OPERATION_ID.test(value) ? value : null;
}

function authorizeScope(
  scopeId: unknown,
  allowedKinds: ReadonlySet<ScopeKind>,
  allowedPrefixes: readonly string[],
): { ok: true; scopeId: ScopeId } | { ok: false; status: number; message: string } {
  if (typeof scopeId !== "string" || !scopeId) return { ok: false, status: 400, message: "scopeId required" };
  const parsed = parseScopeId(scopeId);
  if (!parsed.kind || !parsed.ref) return { ok: false, status: 400, message: "invalid scopeId" };
  if (!allowedKinds.has(parsed.kind) || !allowedPrefixes.some((prefix) => scopeId.startsWith(prefix))) {
    return { ok: false, status: 403, message: "scope is not allowed for this integration" };
  }
  return { ok: true, scopeId };
}

function verifyRequest(
  req: IncomingMessage,
  secret: string,
  canonical: string,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  return verifySignature(
    secret,
    {
      signature: String(req.headers["x-signature"] ?? ""),
      timestamp: Number(req.headers["x-timestamp"] ?? Number.NaN),
      body: canonical,
    },
    now,
    SOURCE_AUTH_REPLAY_WINDOW_MS,
  );
}

function audit(
  options: MemoryHttpServiceOptions,
  operationId: string,
  action: string,
  scopeId: ScopeId,
  status: string,
  request: readonly unknown[],
  detail?: string,
  scopeLabel?: ScopeId,
): Promise<void> {
  const kind = parseScopeId(scopeId).kind ?? "org";
  const eventToken = memoryAuditToken(options.scopeTokenSecret, options.integrationId, operationId, action, request);
  const event = {
    at: (options.now ?? Date.now)(),
    principalId: `service:${options.integrationId}`,
    action,
    resource: `memory-operation:${eventToken}`,
    scopeLabel: scopeLabel ?? `${kind}:audit:${memoryScopeToken(options.scopeTokenSecret, scopeId)}`,
    status,
    ...(detail ? { detail } : {}),
  };
  return options.auditLog.recordOnce
    ? options.auditLog.recordOnce(`memory-integration:${options.integrationId}:${eventToken}`, event)
    : Promise.resolve(options.auditLog.record(event));
}

async function handleQuery(
  options: MemoryHttpServiceOptions,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const operationId = parseOperationId(body);
  if (!operationId) return sendJson(res, 400, { error: "bad_request", message: "valid operationId required" });
  const scope = authorizeScope(body.scopeId, options.allowedScopeKinds, options.allowedScopePrefixes);
  if (!scope.ok)
    return sendJson(res, scope.status, {
      error: scope.status === 403 ? "forbidden" : "bad_request",
      message: scope.message,
    });
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > MAX_QUERY_CHARS) {
    return sendJson(res, 400, { error: "bad_request", message: `query must be 1-${MAX_QUERY_CHARS} characters` });
  }
  const limit = typeof body.limit === "number" && Number.isSafeInteger(body.limit) ? body.limit : 20;
  if (limit < 1 || limit > 50) return sendJson(res, 400, { error: "bad_request", message: "limit must be 1-50" });
  const results = await options.memory.query(scope.scopeId, query, limit);
  await audit(
    options,
    operationId,
    "memory.integration.query",
    scope.scopeId,
    "ok",
    [scope.scopeId, query, limit],
    `results=${results.length}`,
  );
  sendJson(res, 200, { operationId, scopeId: scope.scopeId, results });
}

async function handleRead(
  options: MemoryHttpServiceOptions,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const operationId = parseOperationId(body);
  if (!operationId) return sendJson(res, 400, { error: "bad_request", message: "valid operationId required" });
  const scope = authorizeScope(body.scopeId, options.allowedScopeKinds, options.allowedScopePrefixes);
  if (!scope.ok)
    return sendJson(res, scope.status, {
      error: scope.status === 403 ? "forbidden" : "bad_request",
      message: scope.message,
    });
  const head = options.memory.readHead
    ? await options.memory.readHead(scope.scopeId)
    : { content: await options.memory.read(scope.scopeId), revision: "" };
  const content = recallBody(head.content);
  await audit(
    options,
    operationId,
    "memory.integration.read",
    scope.scopeId,
    "ok",
    [scope.scopeId],
    `chars=${content.length}`,
  );
  sendJson(res, 200, {
    operationId,
    scopeId: scope.scopeId,
    content,
    revision: head?.revision ?? "",
    ...(head?.updatedAt === undefined ? {} : { updatedAt: head.updatedAt }),
  });
}

async function handleCapture(
  options: MemoryHttpServiceOptions,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const operationId = parseOperationId(body);
  if (!operationId) return sendJson(res, 400, { error: "bad_request", message: "valid operationId required" });
  const scope = authorizeScope(body.scopeId, options.allowedScopeKinds, options.allowedScopePrefixes);
  if (!scope.ok)
    return sendJson(res, scope.status, {
      error: scope.status === 403 ? "forbidden" : "bad_request",
      message: scope.message,
    });
  if (!Array.isArray(body.facts) || body.facts.length < 1 || body.facts.length > MAX_FACTS) {
    return sendJson(res, 400, { error: "bad_request", message: `facts must contain 1-${MAX_FACTS} strings` });
  }
  const facts = body.facts.map((fact) => (typeof fact === "string" ? fact.trim() : ""));
  if (facts.some((fact) => !fact || fact.length > MAX_FACT_CHARS)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `each fact must be a non-empty string of at most ${MAX_FACT_CHARS} characters`,
    });
  }
  if (typeof body.capturedAt !== "number" || !Number.isSafeInteger(body.capturedAt) || body.capturedAt < 0) {
    return sendJson(res, 400, { error: "bad_request", message: "capturedAt must be a non-negative integer" });
  }
  const capturedAt = body.capturedAt;
  const input: MemoryCaptureOnceInput = {
    integrationId: options.integrationId,
    operationId,
    scopeId: scope.scopeId,
    facts,
    at: capturedAt,
    author: `service:${options.integrationId}`,
  };
  const receipt = await options.memory.captureOnce(input);
  await audit(
    options,
    operationId,
    "memory.integration.capture",
    scope.scopeId,
    "ok",
    [scope.scopeId, facts, capturedAt],
    `added=${receipt.added}`,
  );
  sendJson(res, 200, { operationId, scopeId: scope.scopeId, ...receipt });
}

async function handleErase(
  options: MemoryHttpServiceOptions,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const operationId = parseOperationId(body);
  if (!operationId) return sendJson(res, 400, { error: "bad_request", message: "valid operationId required" });
  const scope = authorizeScope(body.scopeId, options.allowedScopeKinds, options.allowedScopePrefixes);
  if (!scope.ok)
    return sendJson(res, scope.status, {
      error: scope.status === 403 ? "forbidden" : "bad_request",
      message: scope.message,
    });
  if (typeof body.erasedAt !== "number" || !Number.isSafeInteger(body.erasedAt) || body.erasedAt < 0) {
    return sendJson(res, 400, { error: "bad_request", message: "erasedAt must be a non-negative integer" });
  }
  const input: MemoryPurgeOnceInput = {
    integrationId: options.integrationId,
    operationId,
    scopeId: scope.scopeId,
    at: body.erasedAt,
  };
  const receipt = await options.memory.purgeOnce(input);
  const kind = parseScopeId(scope.scopeId).kind ?? "org";
  await audit(
    options,
    operationId,
    "memory.integration.erase",
    scope.scopeId,
    "ok",
    [receipt.scopeHash, input.at],
    `revisions=${receipt.erasedRevisions};operations=${receipt.tombstonedOperations}`,
    `${kind}:erased:${receipt.scopeHash}` as ScopeId,
  );
  sendJson(res, 200, { operationId, ...receipt });
}

export function createMemoryHttpService(options: MemoryHttpServiceOptions): Server {
  if (!isStrongSigningSecret(options.signingSecret))
    throw new Error("memory service signing secret must be at least 32 characters");
  if (!isStrongSigningSecret(options.scopeTokenSecret))
    throw new Error("memory service scope token secret must be at least 32 characters");
  if (!OPERATION_ID.test(options.integrationId)) throw new Error("memory service integrationId is invalid");
  if (!options.allowedScopeKinds.size || !options.allowedScopePrefixes.length) {
    throw new Error("memory service requires non-empty scope kind and prefix allowlists");
  }
  if (
    options.allowedScopePrefixes.some((prefix) => {
      const parsed = parseScopeId(prefix);
      return !prefix.endsWith(":") || !parsed.kind || !parsed.ref || !options.allowedScopeKinds.has(parsed.kind);
    })
  ) {
    throw new Error("memory service scope prefixes must end at a segment boundary and match an allowed kind");
  }
  const now = options.now ?? Date.now;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://memory-service.internal");
    if (method === "GET" && url.pathname === "/healthz") {
      try {
        await options.memory.read("org:__memory-service-health__");
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 503, { ok: false });
      }
    }
    if (
      method !== "POST" ||
      !["/v1/memory/read", "/v1/memory/query", "/v1/memory/capture", "/v1/memory/erase"].includes(url.pathname)
    ) {
      return sendJson(res, 404, { error: "not_found" });
    }

    try {
      const raw = await readBody(req, maxBodyBytes);
      const verified = verifyRequest(
        req,
        options.signingSecret,
        canonicalPayload(method, url.pathname + url.search, raw),
        now(),
      );
      if (!verified.ok) return sendJson(res, 401, { error: "unauthorized", message: verified.reason });
      const body = parseJson(raw);
      if (!body) return sendJson(res, 400, { error: "bad_request", message: "JSON object body required" });
      if (url.pathname === "/v1/memory/read") return await handleRead(options, body, res);
      if (url.pathname === "/v1/memory/query") return await handleQuery(options, body, res);
      if (url.pathname === "/v1/memory/capture") return await handleCapture(options, body, res);
      return await handleErase(options, body, res);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return sendJson(res, 413, { error: "payload_too_large" });
      }
      if (error instanceof MemoryOperationConflictError) {
        return sendJson(res, 409, { error: "operation_conflict", message: error.message });
      }
      if (error instanceof MemoryOperationErasedError) {
        return sendJson(res, 410, { error: "operation_erased", message: error.message });
      }
      console.error("[memory-service] request failed:", errMessage(error));
      return sendJson(res, 500, { error: "internal_error", message: "request failed" });
    }
  });
}
