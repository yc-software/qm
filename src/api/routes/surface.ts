import type { Grant, ScopeId } from "../../types.ts";
import { parseScopeId, scopeId as makeScopeId } from "../../types.ts";
import type { Skill, SkillResolution } from "../../skills/skill-store.ts";
import { ByteSourceTooLargeError } from "../../files/durable-byte-store.ts";
import {
  defaultModelForHarness,
  isHarnessId,
  modelProviderAvailabilityFor,
  modelSupportedByHarness,
  resolveModel,
  serviceableModelIds,
  ALL_PROVIDERS_AVAILABLE,
  FAST_MODE_MODEL_IDS,
  THINKING_LEVELS,
  type HarnessId,
} from "../../model/pi-models.ts";
import { builtInModelCatalog, selectableCatalogForHarness, selectableModelCatalog } from "../../model/model-catalog.ts";
import { errMessage } from "../../util/errors.ts";
import { renderAgentApis } from "../agent-api-catalog.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../../auth/capability-token.ts";
import { contentTypeWithUtf8Charset, pipeToResponse, sendJson } from "../http.ts";
import { resolveBranding } from "../../resolution/branding.ts";
import { audit, isObj, orgScope } from "./shared.ts";
import {
  UI_STATE_KEY_PATTERN,
  UI_STATE_MAX_BYTES,
  UI_STATE_MAX_FUTURE_SKEW_MS,
  storeUiState,
  uiStateId,
} from "../../surfaces/ui-state.ts";
import { type ApiCtx, type Route } from "./route.ts";
import {
  ARTIFACT_TYPES,
  isArtifactType,
  livePersonCapability,
  splitToScope,
  SHARED_SKILL_TRIGGER_REFUSAL,
} from "../artifact-share.ts";

function isGrant(b: unknown): b is Grant {
  return (
    isObj(b) &&
    typeof b.ownerScopeId === "string" &&
    typeof b.ref === "string" &&
    typeof b.granteeScopeId === "string" &&
    (b.permission === "read" || b.permission === "write") &&
    typeof b.grantedBy === "string"
  );
}

function sharedSkillCreateBlock(capability: ApiCtx["capability"]): string | null {
  if (!capability) return null;
  if (parseScopeId(capability.scopeId).kind === "personal") return null;
  if (livePersonCapability(capability)) return null;
  return SHARED_SKILL_TRIGGER_REFUSAL;
}

function isConversationColor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value));
}

async function regenerateSessionTitle(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const id = ctx.params.id!;
  const principalId = (body as { principalId?: unknown }).principalId;
  if (typeof principalId !== "string" || !principalId) {
    return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  }
  const out = await app.regenerateTitle(id, principalId);
  if (!out) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, out);
}

async function forkSession(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const id = ctx.params.id!;
  const b = body as { principalId?: unknown; upToSeq?: unknown };
  if (typeof b.principalId !== "string" || !b.principalId) {
    return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  }
  if (b.upToSeq !== undefined && (typeof b.upToSeq !== "number" || !Number.isInteger(b.upToSeq) || b.upToSeq < 0)) {
    return sendJson(res, 400, { error: "bad_request", message: "upToSeq must be a non-negative integer" });
  }
  const out = await app.forkSession(id, b.principalId, b.upToSeq !== undefined ? { upToSeq: b.upToSeq } : undefined);
  if (!out) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, out);
}

async function spawnAgentConversation(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  }
  if (!livePersonCapability(capability)) {
    return sendJson(res, 403, {
      error: "human_attended_only",
      message:
        "starting a fresh conversation requires a turn a person is attending — not a cron, trigger, or other automation",
    });
  }
  const b = isObj(body) ? body : {};
  if (typeof b.text !== "string" || !b.text.trim()) {
    return sendJson(res, 400, { error: "bad_request", message: "text required — the new session's first message" });
  }
  if (b.title !== undefined && typeof b.title !== "string") {
    return sendJson(res, 400, { error: "bad_request", message: "title must be a string" });
  }
  const out = await app.spawnSession(capability.actorId, {
    scopeId: capability.scopeId,
    ...(typeof b.title === "string" ? { title: b.title } : {}),
  });
  if (!out) return sendJson(res, 404, { error: "not_found", message: "cannot start a session in this scope" });
  const session = out.session;
  const sessionScope = parseScopeId(session.scopeId);
  const turn = await app.turn({
    surface: session.surface ?? "web",
    actor: { externalId: capability.actorId },
    conversation: {
      kind: session.type,
      threadRef: session.threadRef,
      ...(sessionScope.kind === "channel" || sessionScope.kind === "group" ? { channelRef: sessionScope.ref } : {}),
      ...(session.channelName ? { channelName: session.channelName } : {}),
    },
    text: b.text,
    spawned: true,
    async: true,
  });
  if (turn.status === "refused") {
    await app.discardSession(session.id, capability.actorId);
    return sendJson(res, 409, {
      error: "seed_turn_refused",
      message: (turn as { reason?: string }).reason ?? "the first message was refused",
    });
  }
  const runId = (turn as { runId?: string }).runId;
  return sendJson(res, 202, { session, turn: { status: turn.status, ...(runId ? { runId } : {}) } });
}

async function forkAgentConversation(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  }
  const b = isObj(body) ? body : {};
  if (b.upToSeq !== undefined && (typeof b.upToSeq !== "number" || !Number.isInteger(b.upToSeq) || b.upToSeq < 0)) {
    return sendJson(res, 400, { error: "bad_request", message: "upToSeq must be a non-negative integer" });
  }
  const out = await app.forkSession(
    ctx.params.id!,
    capability.actorId,
    b.upToSeq !== undefined ? { upToSeq: b.upToSeq } : undefined,
  );
  if (!out) return sendJson(res, 404, { error: "not_found", message: "not a conversation you can see" });
  return sendJson(res, 200, out);
}

function transcriptWindow(
  url: URL,
  defaultTailTurns?: number,
): { tailTurns?: number; sinceSeq?: number; beforeSeq?: number } | null {
  const windowParam = (name: "tailTurns" | "sinceSeq" | "beforeSeq", min: number): number | undefined | null => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min ? n : null;
  };
  const requestedTailTurns = windowParam("tailTurns", 1);
  const sinceSeq = windowParam("sinceSeq", 0);
  const beforeSeq = windowParam("beforeSeq", 1);
  if (requestedTailTurns === null || sinceSeq === null || beforeSeq === null) return null;
  const tailTurns = requestedTailTurns ?? (sinceSeq === undefined ? defaultTailTurns : undefined);
  if (tailTurns === undefined && sinceSeq === undefined && beforeSeq === undefined) return {};
  return {
    ...(tailTurns !== undefined ? { tailTurns } : {}),
    ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
  };
}

async function getSession(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const id = ctx.params.id!;
  const viewer = url.searchParams.get("viewer");
  if (!viewer) return sendJson(res, 400, { error: "bad_request", message: "viewer required" });
  const window = transcriptWindow(url);
  if (!window) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "tailTurns and beforeSeq must be positive integers, sinceSeq a non-negative one",
    });
  }
  const found = await app.getSessionForViewer(id, viewer, Object.keys(window).length ? window : undefined);
  if (!found) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, found);
}

async function getSessionEntry(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const id = ctx.params.id!;
  const viewer = url.searchParams.get("viewer");
  if (!viewer) return sendJson(res, 400, { error: "bad_request", message: "viewer required" });
  const seq = Number(ctx.params.seq);
  if (!Number.isInteger(seq) || seq < 0) {
    return sendJson(res, 400, { error: "bad_request", message: "seq must be a non-negative integer" });
  }
  const found = await app.getSessionEntryForViewer(id, viewer, seq);
  if (!found) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, found);
}

async function getAgentConversation(ctx: ApiCtx): Promise<void> {
  const { res, app, url, capability } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  }
  if (url.searchParams.has("sinceSeq")) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "agent transcript paging supports tailTurns and beforeSeq",
    });
  }
  const window = transcriptWindow(url, 20);
  if (!window) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "tailTurns and beforeSeq must be positive integers, sinceSeq a non-negative one",
    });
  }
  const found = await app.getSessionForViewer(ctx.params.id!, capability.actorId, window);
  if (!found) return sendJson(res, 404, { error: "not_found", message: "not a conversation you can see" });
  return sendJson(res, 200, found);
}

async function listSessionApprovals(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const id = ctx.params.id!;
  const viewer = url.searchParams.get("viewer");
  if (!viewer) return sendJson(res, 400, { error: "bad_request", message: "viewer required" });
  return sendJson(res, 200, { approvals: await app.listSessionApprovals(id, viewer) });
}

async function getSessionBackground(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const id = ctx.params.id!;
  const viewer = url.searchParams.get("viewer");
  if (!viewer) return sendJson(res, 400, { error: "bad_request", message: "viewer required" });
  const view = await app.sessionBackground(id, viewer);
  if (!view) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, view);
}

async function getSessionBackgroundOutput(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const id = ctx.params.id!;
  const processId = ctx.params.pid!;
  const viewer = url.searchParams.get("viewer");
  if (!viewer) return sendJson(res, 400, { error: "bad_request", message: "viewer required" });
  const sinceCursor = Math.max(0, Number(url.searchParams.get("sinceCursor") ?? "0") || 0);
  const read = await app.readSessionBackgroundOutput(id, processId, viewer, sinceCursor);
  if (!read) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, read);
}

async function getFileContent(ctx: ApiCtx): Promise<void> {
  const { res, app, capability, actor } = ctx;
  const id = ctx.params.id!;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const opened = await app.openFileForViewer(id, viewer);
  if (!opened) return sendJson(res, 404, { error: "not_found" });
  res.writeHead(200, {
    "content-type": contentTypeWithUtf8Charset(opened.mimetype || "application/octet-stream"),
    "content-length": String(opened.sizeBytes),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(opened.name)}`,
  });
  pipeToResponse(res, opened.stream, "file read failed");
  return;
}

async function listFiles(ctx: ApiCtx): Promise<void> {
  const { res, app, url, capability, actor } = ctx;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const limitRaw = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const scope = url.searchParams.get("scope");
  const page = await app.listFilesForViewer(
    viewer,
    {
      ...(limitRaw ? { limit: Number(limitRaw) } : {}),
      ...(cursor ? { cursor } : {}),
    },
    scope ? (scope as ScopeId) : undefined,
  );
  return sendJson(res, 200, page);
}

async function uploadFile(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body } = ctx;
  if (!deps.blobTransfer)
    return sendJson(res, 501, { error: "not_configured", message: "blob transfer store not wired" });
  const b = isObj(body) ? body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId.trim() : "";
  const blobId = typeof b.blobId === "string" ? b.blobId.trim() : "";
  const name = typeof b.name === "string" ? b.name : "";
  const mimetype = typeof b.mimetype === "string" ? b.mimetype : undefined;
  const scopeId = typeof b.scopeId === "string" && b.scopeId ? (b.scopeId as ScopeId) : undefined;
  if (!principalId || !blobId || !name)
    return sendJson(res, 400, { error: "bad_request", message: "principalId, blobId, and name required" });
  const opened = await deps.blobTransfer.open(blobId);
  if (!opened) return sendJson(res, 404, { error: "not_found", message: "staged blob not found" });
  try {
    const file = await app.uploadFileForViewer(principalId, {
      ...(scopeId ? { scopeId } : {}),
      name,
      ...(mimetype ? { mimetype } : {}),
      data: opened.stream,
    });
    if (!file) {
      opened.stream.destroy();
      return sendJson(res, 403, { error: "forbidden", message: "you can only upload to your own contexts" });
    }
    return sendJson(res, 200, { file });
  } catch (e) {
    if (e instanceof ByteSourceTooLargeError)
      return sendJson(res, 413, { error: "payload_too_large", message: e.message });
    throw e;
  } finally {
    await deps.blobTransfer.delete(blobId);
  }
}

async function patchSession(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const id = ctx.params.id!;
  const b = body as { principalId?: unknown; title?: unknown; archived?: unknown; pinned?: unknown; color?: unknown };
  const principalId = typeof b.principalId === "string" ? b.principalId : null;
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const patch: { title?: string | null; archived?: boolean; pinned?: boolean; color?: string | null } = {};
  if ("title" in b) {
    if (b.title !== null && typeof b.title !== "string") {
      return sendJson(res, 400, { error: "bad_request", message: "title must be a string or null" });
    }
    const trimmed = typeof b.title === "string" ? b.title.trim().slice(0, 200) : null;
    patch.title = trimmed ? trimmed : null;
  }
  if ("archived" in b) {
    if (typeof b.archived !== "boolean") {
      return sendJson(res, 400, { error: "bad_request", message: "archived must be a boolean" });
    }
    patch.archived = b.archived;
  }
  if ("pinned" in b) {
    if (typeof b.pinned !== "boolean") {
      return sendJson(res, 400, { error: "bad_request", message: "pinned must be a boolean" });
    }
    patch.pinned = b.pinned;
  }
  if ("color" in b) {
    if (!isConversationColor(b.color)) {
      return sendJson(res, 400, { error: "bad_request", message: "color must be '#rrggbb' or null" });
    }
    patch.color = typeof b.color === "string" ? b.color.toLowerCase() : null;
  }
  if (
    patch.title === undefined &&
    patch.archived === undefined &&
    patch.pinned === undefined &&
    patch.color === undefined
  ) {
    return sendJson(res, 400, { error: "bad_request", message: "title, archived, pinned, or color required" });
  }
  const session = await app.updateSession(id, principalId, patch);
  if (!session) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { session });
}

async function listAgentConversations(ctx: ApiCtx): Promise<void> {
  const { res, app, capability } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  }
  const sessions = await app.listSessions(capability.actorId);
  return sendJson(res, 200, {
    conversations: sessions.map((s) => ({
      id: s.id,
      scopeId: s.scopeId,
      surface: s.surface ?? "unknown",
      title: s.title ?? null,
      archived: s.archived === true,
      pinned: s.pinned === true,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt ?? s.createdAt,
    })),
  });
}

async function patchAgentConversation(ctx: ApiCtx): Promise<void> {
  const { res, app, capability, body } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "capability_required", message: "this endpoint is for the agent self-API" });
  }
  const b = isObj(body) ? body : {};
  const patch: { title?: string | null; archived?: boolean; pinned?: boolean; color?: string | null } = {};
  if ("archived" in b) {
    if (typeof b.archived !== "boolean") {
      return sendJson(res, 400, { error: "bad_request", message: "archived must be a boolean" });
    }
    patch.archived = b.archived;
  }
  if ("pinned" in b) {
    if (typeof b.pinned !== "boolean") {
      return sendJson(res, 400, { error: "bad_request", message: "pinned must be a boolean" });
    }
    patch.pinned = b.pinned;
  }
  if ("title" in b) {
    if (b.title !== null && typeof b.title !== "string") {
      return sendJson(res, 400, { error: "bad_request", message: "title must be a string or null" });
    }
    const trimmed = typeof b.title === "string" ? b.title.trim().slice(0, 200) : null;
    patch.title = trimmed ? trimmed : null;
  }
  if ("color" in b) {
    if (!isConversationColor(b.color)) {
      return sendJson(res, 400, { error: "bad_request", message: "color must be '#rrggbb' or null" });
    }
    patch.color = typeof b.color === "string" ? b.color.toLowerCase() : null;
  }
  if (
    patch.archived === undefined &&
    patch.pinned === undefined &&
    patch.title === undefined &&
    patch.color === undefined
  ) {
    return sendJson(res, 400, { error: "bad_request", message: "archived, pinned, title, or color required" });
  }
  const session = await app.updateSession(ctx.params.id!, capability.actorId, patch);
  if (!session) return sendJson(res, 404, { error: "not_found", message: "not a conversation you can see" });
  audit(ctx.deps, {
    principalId: capability.actorId,
    action: "conversation.update",
    resource: session.id,
    scopeLabel: session.scopeId,
    detail: JSON.stringify(patch),
  });
  return sendJson(res, 200, {
    conversation: {
      id: session.id,
      title: session.title ?? null,
      archived: session.archived === true,
      pinned: session.pinned === true,
      color: session.color ?? null,
    },
  });
}

async function listSessions(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  return sendJson(res, 200, { sessions: await app.listSessions(principalId) });
}

async function searchSessions(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const query = url.searchParams.get("q") ?? "";
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  return sendJson(res, 200, { hits: await app.searchSessions(principalId, query, limit) });
}

async function listContexts(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  return sendJson(res, 200, { contexts: await app.listContexts(principalId) });
}

async function listScopeResources(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  const scope = url.searchParams.get("scope");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  if (!scope) return sendJson(res, 400, { error: "bad_request", message: "scope required" });
  const out = await app.listScopeResources(principalId, scope as ScopeId);
  if (!out) return sendJson(res, 404, { error: "not_found", message: "not a context you can see" });
  return sendJson(res, 200, {
    files: out.files,
    crons: out.crons,
    deployments: out.deployments,
    skills: out.skills,
    manageable: out.manageable,
  });
}

async function getUiState(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  const key = url.searchParams.get("key") ?? "";
  if (!principalId || !UI_STATE_KEY_PATTERN.test(key))
    return sendJson(res, 400, { error: "bad_request", message: "principalId and a valid key required" });
  if (!deps.uiState) return sendJson(res, 404, { error: "not_found" });
  const rec = await deps.uiState.get(uiStateId(principalId, key));
  return sendJson(res, 200, rec ?? { value: null, updatedAt: 0 });
}

async function putUiState(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const b = body as { principalId?: unknown; key?: unknown; value?: unknown; updatedAt?: unknown };
  const principalId = typeof b.principalId === "string" ? b.principalId : "";
  const key = typeof b.key === "string" ? b.key : "";
  if (!principalId || !UI_STATE_KEY_PATTERN.test(key))
    return sendJson(res, 400, { error: "bad_request", message: "principalId and a valid key required" });
  if (b.value === undefined) return sendJson(res, 400, { error: "bad_request", message: "value required" });
  if (Buffer.byteLength(JSON.stringify(b.value)) > UI_STATE_MAX_BYTES)
    return sendJson(res, 413, { error: "payload_too_large", message: "ui state too large" });
  if (!deps.uiState) return sendJson(res, 404, { error: "not_found" });
  const claimed = typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt) ? b.updatedAt : Date.now();
  const updatedAt = Math.min(claimed, Date.now() + UI_STATE_MAX_FUTURE_SKEW_MS);
  const result = await storeUiState(deps.uiState, uiStateId(principalId, key), { value: b.value, updatedAt });
  return sendJson(res, 200, result);
}

async function getSelfMemory(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });
  const scope = makeScopeId("personal", principalId);
  audit(deps, { principalId, action: "memory.self.read", resource: "memory", scopeLabel: scope });
  const head = await deps.memory.readHead?.(scope);
  return sendJson(res, 200, head ?? { content: await deps.memory.read(scope), revision: "" });
}

async function putSelfMemory(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const b = body as { principalId?: unknown; content?: unknown; revision?: unknown };
  const principalId = typeof b.principalId === "string" ? b.principalId : "";
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  if (typeof b.content !== "string") return sendJson(res, 400, { error: "bad_request", message: "content required" });
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });
  const scope = makeScopeId("personal", principalId);
  const saved =
    typeof b.revision === "string" && b.revision !== "" && deps.memory.replaceIfRevision
      ? await deps.memory.replaceIfRevision(scope, b.content, b.revision, principalId)
      : (await deps.memory.replace(scope, b.content, principalId), true);
  if (!saved) {
    const head = await deps.memory.readHead?.(scope);
    return sendJson(res, 409, { error: "conflict", message: "Memory changed while you were editing.", ...head });
  }
  audit(deps, { principalId, action: "memory.self.update", resource: "memory", scopeLabel: scope });
  const head = await deps.memory.readHead?.(scope);
  return sendJson(res, 200, { ok: true, ...head });
}

async function getSelfMemoryHistory(ctx: ApiCtx): Promise<void> {
  const { res, deps, url, capability, actor } = ctx;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const principalId = capability ? viewer : url.searchParams.get("principalId");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  if (url.searchParams.has("principalId") && url.searchParams.get("principalId") !== viewer) {
    return sendJson(res, 404, { error: "not_found" });
  }
  const requestedScope = capability ? (url.searchParams.get("scope") ?? undefined) : undefined;
  if (requestedScope !== undefined && requestedScope !== "org") {
    return sendJson(res, 400, { error: "bad_request", message: 'scope must be "org" when present' });
  }
  let scope: ScopeId | undefined = makeScopeId("personal", principalId);
  if (capability) scope = requestedScope === "org" ? capability.memory?.orgWrite : capability.memory?.write;
  if (!scope) return sendJson(res, 404, { error: "not_found" });
  if (!deps.memory?.history) return sendJson(res, 200, { revisions: [] });
  return sendJson(res, 200, { revisions: await deps.memory.history(scope, 30) });
}

async function restoreSelfMemory(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability, actor } = ctx;
  const viewer = capability?.actorId ?? actor?.p;
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const b = body as { principalId?: unknown; revision?: unknown; expectedRevision?: unknown; scope?: unknown };
  const principalId = capability ? viewer : b.principalId;
  if (typeof principalId !== "string" || typeof b.revision !== "string" || typeof b.expectedRevision !== "string") {
    return sendJson(res, 400, { error: "bad_request", message: "revision and expectedRevision required" });
  }
  if (b.principalId !== undefined && b.principalId !== viewer) return sendJson(res, 404, { error: "not_found" });
  const requestedScope = capability ? b.scope : undefined;
  if (requestedScope !== undefined && requestedScope !== "org") {
    return sendJson(res, 400, { error: "bad_request", message: 'scope must be "org" when present' });
  }
  let scope: ScopeId | undefined = makeScopeId("personal", principalId);
  if (capability) scope = requestedScope === "org" ? capability.memory?.orgWrite : capability.memory?.write;
  if (!scope) return sendJson(res, 404, { error: "not_found" });
  const restored = await deps.memory?.restore?.(scope, b.revision, b.expectedRevision, viewer);
  if (!restored)
    return sendJson(res, 409, { error: "conflict", message: "Memory changed, or that revision no longer exists." });
  audit(deps, {
    principalId: viewer,
    action: "memory.self.restore",
    resource: `memory:${b.revision}`,
    scopeLabel: scope,
  });
  return sendJson(res, 200, { ok: true, ...(await deps.memory?.readHead?.(scope)) });
}

async function sessionCapability(ctx: ApiCtx): Promise<void> {
  const { res, deps, actor } = ctx;
  if (!actor) return sendJson(res, 401, { error: "unauthorized", message: "portal identity required" });
  const secret = deps.capabilitySecret ?? ctx.secret;
  if (!secret) return sendJson(res, 503, { error: "not_configured", message: "capability secret not set" });
  const token = await mintCapabilityToken(
    { actorId: actor.p, scopeId: makeScopeId("personal", actor.p), exp: Date.now() + CAPABILITY_TTL_MS },
    secret,
  );
  return sendJson(res, 200, { token });
}

async function listAgentApis(ctx: ApiCtx): Promise<void> {
  const { res, deps, capability } = ctx;
  if (!capability) return sendJson(res, 401, { error: "unauthorized", message: "agent capability token required" });
  const admin: { isAdmin: boolean; role?: string } = deps.admin
    ? await deps.admin.adminStatusOf({ id: capability.actorId, type: "internal" }).catch(() => ({ isAdmin: false }))
    : { isAdmin: false };
  audit(deps, {
    principalId: capability.actorId,
    action: "apis.list",
    resource: "apis",
    scopeLabel: capability.scopeId,
  });
  return sendJson(
    res,
    200,
    renderAgentApis(capability, { isAdmin: admin.isAdmin, ...(admin.role ? { role: admin.role } : {}) }),
  );
}

function parseFacts(body: unknown): string[] | string {
  const b = (isObj(body) ? body : {}) as { facts?: unknown };
  const facts = Array.isArray(b.facts)
    ? b.facts.filter((f): f is string => typeof f === "string" && f.trim() !== "")
    : [];
  if (facts.length === 0) return "facts (non-empty string array) required";
  if (facts.length > 20) return "at most 20 facts per call";
  return facts;
}

async function agentMemory(ctx: ApiCtx): Promise<void> {
  const { res, deps, pathname, method, body, capability } = ctx;
  if (!capability) return sendJson(res, 401, { error: "unauthorized", message: "agent capability token required" });
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });

  if (isObj(body) && ["recipient", "channel", "participants"].some((key) => key in body)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "memory can only be changed from its own conversation",
    });
  }

  if (method === "POST" && pathname === "/v1/memory/search") {
    const b = body as { query?: unknown; limit?: unknown };
    if (typeof b.query !== "string" || !b.query.trim()) {
      return sendJson(res, 400, { error: "bad_request", message: "query (string) required" });
    }
    const scopes = capability.memory?.read ?? [];
    if (scopes.length === 0) {
      return sendJson(res, 403, { error: "forbidden", message: "memory recall is not enabled for this conversation" });
    }
    const limit = Math.max(1, Math.min(typeof b.limit === "number" ? Math.floor(b.limit) : 20, 50));
    const results: Array<{ scopeId: string; fact: string }> = [];
    for (const scope of scopes) {
      if (results.length >= limit) break;
      for (const fact of await deps.memory.query(scope, b.query, limit - results.length)) {
        results.push({ scopeId: scope, fact });
      }
    }
    audit(deps, {
      principalId: capability.actorId,
      action: "memory.agent.search",
      resource: "memory",
      scopeLabel: scopes.join(","),
    });
    return sendJson(res, 200, { results });
  }

  const requestedScope =
    method === "GET"
      ? (ctx.url.searchParams.get("scope") ?? undefined)
      : (body as { scope?: unknown } | undefined)?.scope;
  if (requestedScope !== undefined && requestedScope !== "org") {
    return sendJson(res, 400, { error: "bad_request", message: 'scope must be "org" when present' });
  }
  const write = requestedScope === "org" ? capability.memory?.orgWrite : capability.memory?.write;
  if (!write) {
    return sendJson(res, 403, {
      error: "forbidden",
      message:
        requestedScope === "org"
          ? "org memory writes require an org admin"
          : "memory capture is not enabled for this conversation",
    });
  }

  if (method === "POST" && pathname === "/v1/memory/facts") {
    const facts = parseFacts(body);
    if (typeof facts === "string") return sendJson(res, 400, { error: "bad_request", message: facts });
    const added = await deps.memory.capture(write, facts, Date.now(), capability.actorId);
    audit(deps, {
      principalId: capability.actorId,
      action: "memory.agent.capture",
      resource: "memory",
      scopeLabel: write,
    });
    return sendJson(res, 200, { ok: true, added, scopeId: write });
  }
  if (method === "GET" && pathname === "/v1/memory/self") {
    audit(deps, {
      principalId: capability.actorId,
      action: "memory.agent.read",
      resource: "memory",
      scopeLabel: write,
    });
    return sendJson(res, 200, { scopeId: write, content: await deps.memory.read(write) });
  }
  if (method === "PUT" && pathname === "/v1/memory/self") {
    const b = body as { content?: unknown };
    if (typeof b.content !== "string")
      return sendJson(res, 400, { error: "bad_request", message: "content (string) required" });
    await deps.memory.replace(write, b.content, capability.actorId);
    audit(deps, {
      principalId: capability.actorId,
      action: "memory.agent.curate",
      resource: "memory",
      scopeLabel: write,
    });
    return sendJson(res, 200, { ok: true, scopeId: write });
  }

  return sendJson(res, 404, { error: "not_found", message: `${method} ${pathname}` });
}

async function listSkills(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const principalId = url.searchParams.get("principalId");
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const includeShadowed = url.searchParams.get("includeShadowed") === "1";
  const resolved = (await app.listVisibleSkills(principalId)).filter(
    (r): r is SkillResolution & { skill: Skill } => r.skill !== null,
  );
  const archivedChecks = await Promise.all(
    (await app.listSkills())
      .filter((skill) => skill.status === "archived")
      .map(async (skill) => ({ skill, manageable: await app.canManageSkill(skill, principalId) })),
  );
  const archived = archivedChecks.filter((row) => row.manageable).map(({ skill }) => ({ skill, shadowed: [] }));
  const visible = resolved.flatMap((row) => [
    { skill: row.skill, shadowed: row.shadowed },
    ...(includeShadowed ? row.shadowed.map((skill) => ({ skill, shadowed: [] })) : []),
  ]);
  const skills = await Promise.all(
    [...visible, ...archived].map(async (r) => ({
      id: r.skill.id,
      name: r.skill.manifest.name,
      description: r.skill.manifest.description,
      scope: parseScopeId(r.skill.scopeId).kind ?? r.skill.scopeId,
      scopeId: r.skill.scopeId,
      shadowed: r.shadowed.length > 0,
      status: r.skill.status,
      version: r.skill.version,
      source: r.skill.pack ? "pack" : "native",
      pack: r.skill.pack,
      assetCount: r.skill.manifest.files?.length ?? 0,
      requiredCapabilities: r.skill.manifest.requiredCapabilities,
      editable: await app.canManageSkill(r.skill, principalId),
    })),
  );
  return sendJson(res, 200, { skills });
}

async function getSkillDetail(ctx: ApiCtx): Promise<void> {
  const { res, app, url, capability, actor } = ctx;
  const principalId = capability?.actorId ?? actor?.p ?? url.searchParams.get("principalId");
  if (!capability && !actor && ctx.secret) {
    return sendJson(res, 401, { error: "capability_required" });
  }
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const skill = await app.getSkill(ctx.params.id!);
  if (
    !skill ||
    (!(await app.canManageSkill(skill, principalId)) &&
      !(await app.listVisibleSkills(principalId)).some((row) => row.skill?.id === skill.id))
  ) {
    return sendJson(res, 404, { error: "not_found" });
  }
  return sendJson(res, 200, {
    skill: {
      id: skill.id,
      name: skill.manifest.name,
      description: skill.manifest.description,
      body: skill.manifest.body,
      scope: parseScopeId(skill.scopeId).kind ?? skill.scopeId,
      scopeId: skill.scopeId,
      status: skill.status,
      version: skill.version,
      createdBy: skill.createdBy,
      pack: skill.pack,
      files: (skill.manifest.files ?? []).map((file) => ({ path: file.path, executable: file.executable === true })),
      requiredCapabilities: skill.manifest.requiredCapabilities,
      grantedCapabilities: skill.grantedCapabilities,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
      editable: await app.canManageSkill(skill, principalId),
    },
  });
}

async function restoreSkill(ctx: ApiCtx): Promise<void> {
  const b = (ctx.body ?? {}) as { principalId?: unknown };
  const principalId =
    ctx.capability?.actorId ?? ctx.actor?.p ?? (typeof b.principalId === "string" ? b.principalId : "");
  if (!ctx.capability && !ctx.actor && ctx.secret) {
    return sendJson(ctx.res, 401, { error: "capability_required" });
  }
  if (!principalId) return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
  const restored = await ctx.app.restoreOwnedSkill(ctx.params.id!, principalId);
  return restored ? sendJson(ctx.res, 200, { ok: true }) : sendJson(ctx.res, 404, { error: "not_found" });
}

async function updateSkill(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  const id = ctx.params.id!;
  const b = (body ?? {}) as { principalId?: unknown; description?: unknown; body?: unknown };

  let principalId: string;
  if (capability) {
    principalId = capability.actorId;
  } else {
    if (typeof b.principalId !== "string" || !b.principalId) {
      return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
    }
    principalId = b.principalId;
  }
  if (b.description !== undefined && typeof b.description !== "string") {
    return sendJson(res, 400, { error: "bad_request", message: "description must be a string" });
  }
  if (b.body !== undefined && typeof b.body !== "string") {
    return sendJson(res, 400, { error: "bad_request", message: "body must be a string" });
  }
  const patch: { description?: string; body?: string } = {};
  if (typeof b.description === "string") patch.description = b.description;
  if (typeof b.body === "string") patch.body = b.body;
  const liveActor = capability ? livePersonCapability(capability) : true;
  const updated = await app.updateOwnedSkill(id, principalId, patch, { liveActor });
  if (updated === "trigger_blocked")
    return sendJson(res, 403, { error: "forbidden", message: SHARED_SKILL_TRIGGER_REFUSAL });
  if (!updated) return sendJson(res, 404, { error: "not_found", message: "no such skill, or it isn't yours to edit" });
  return sendJson(res, 200, {
    skill: {
      id: updated.id,
      name: updated.manifest.name,
      description: updated.manifest.description,
      body: updated.manifest.body,
      status: updated.status,
      version: updated.version,
    },
  });
}

async function deleteSkill(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  const id = ctx.params.id!;
  const b = (body ?? {}) as { principalId?: unknown };

  let principalId: string;
  if (capability) {
    principalId = capability.actorId;
  } else {
    if (typeof b.principalId !== "string" || !b.principalId) {
      return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
    }
    principalId = b.principalId;
  }
  const liveActor = capability ? livePersonCapability(capability) : true;
  const outcome = await app.deleteOwnedSkill({ principalId, id, liveActor });
  if (outcome === "missing") return sendJson(res, 404, { error: "not_found", message: "no such skill" });
  if (outcome === "trigger_blocked")
    return sendJson(res, 403, { error: "forbidden", message: SHARED_SKILL_TRIGGER_REFUSAL });
  if (outcome === "forbidden")
    return sendJson(res, 403, { error: "forbidden", message: "that skill isn't yours to archive" });
  return sendJson(res, 200, { ok: true });
}

async function createSkill(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  const b = (body ?? {}) as {
    principalId?: unknown;
    scopeId?: unknown;
    name?: unknown;
    description?: unknown;
    body?: unknown;
  };

  const blocked = sharedSkillCreateBlock(capability);
  if (blocked) return sendJson(res, 403, { error: "forbidden", message: blocked });

  let principalId: string;
  let homeScope: ScopeId | undefined;
  if (capability) {
    principalId = capability.actorId;
    homeScope = capability.scopeId;
  } else {
    if (typeof b.principalId !== "string" || !b.principalId) {
      return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
    }
    principalId = b.principalId;
    if (typeof b.scopeId === "string" && b.scopeId !== makeScopeId("personal", principalId)) {
      if (!(await app.managesScope(principalId, b.scopeId as ScopeId))) {
        return sendJson(res, 403, { error: "forbidden", message: "you cannot create a skill in that context" });
      }
      homeScope = b.scopeId as ScopeId;
    }
  }
  if (homeScope && (parseScopeId(homeScope).kind === "org" || parseScopeId(homeScope).kind === "team")) {
    return sendJson(res, 403, {
      error: "forbidden",
      message: "a skill cannot be created in an org or team scope — promote a published skill instead",
    });
  }
  if (typeof b.name !== "string" || !b.name.trim()) {
    return sendJson(res, 400, { error: "bad_request", message: "name required" });
  }
  if (typeof b.description !== "string" || !b.description.trim()) {
    return sendJson(res, 400, { error: "bad_request", message: "description required" });
  }
  if (typeof b.body !== "string" || !b.body.trim()) {
    return sendJson(res, 400, { error: "bad_request", message: "body required" });
  }
  const created = await app.createOwnedSkill({
    principalId,
    ...(homeScope ? { homeScope } : {}),
    name: b.name,
    description: b.description,
    body: b.body,
  });
  if (!created)
    return sendJson(res, 409, {
      error: "exists",
      message: "a skill of that name already exists here — edit it instead",
    });
  return sendJson(res, 201, {
    skill: {
      id: created.id,
      name: created.manifest.name,
      description: created.manifest.description,
      body: created.manifest.body,
      status: created.status,
      version: created.version,
    },
  });
}

async function createGrant(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  if (!isGrant(body)) return sendJson(res, 400, { error: "bad_request", message: "expected a Grant" });
  try {
    await app.grant(body);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 400, { error: "grant_failed", message: errMessage(e) });
  }
}

async function revokeGrant(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const b = body as { ownerScopeId?: string; ref?: string; granteeScopeId?: string; revokedBy?: string };
  if (!b.ownerScopeId || !b.ref || !b.granteeScopeId || typeof b.revokedBy !== "string" || !b.revokedBy) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "ownerScopeId, ref, granteeScopeId, revokedBy required",
    });
  }
  try {
    await app.revokeGrant(b.ownerScopeId, b.ref, b.granteeScopeId, b.revokedBy);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 400, { error: "revoke_failed", message: errMessage(e) });
  }
}

const SHARE_ERROR_STATUS: Record<string, number> = {
  bad_request: 400,
  not_found: 404,
  forbidden: 403,
  recipient_not_found: 404,
  ambiguous_recipient: 409,
  share_failed: 400,
};

export async function shareArtifact(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability } = ctx;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "sharing requires an agent capability token" });
  const b = (isObj(body) ? body : {}) as {
    type?: unknown;
    id?: unknown;
    toScope?: unknown;
    permission?: unknown;
    move?: unknown;
  };
  if (typeof b.type !== "string" || !isArtifactType(b.type)) {
    return sendJson(res, 400, { error: "bad_request", message: `type must be one of: ${ARTIFACT_TYPES.join(", ")}` });
  }
  if (typeof b.id !== "string" || !b.id.trim())
    return sendJson(res, 400, { error: "bad_request", message: "id required" });
  if (typeof b.toScope !== "string" || !b.toScope.trim()) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: 'toScope required ("org", a scope id, or a teammate\'s name)',
    });
  }
  if (b.permission !== undefined && b.permission !== "read" && b.permission !== "write") {
    return sendJson(res, 400, { error: "bad_request", message: 'permission must be "read" or "write"' });
  }
  const result = await deps.control.shareArtifact(
    {
      type: b.type,
      id: b.id,
      ...splitToScope(b.toScope),
      ...(b.permission === "read" || b.permission === "write" ? { permission: b.permission } : {}),
      ...(b.move === true ? { move: true } : {}),
    },
    capability,
  );
  if (!result.ok) {
    return sendJson(res, SHARE_ERROR_STATUS[result.code] ?? 400, {
      error: result.code,
      message: result.message,
      ...(result.candidates ? { candidates: result.candidates } : {}),
    });
  }
  return sendJson(res, 200, {
    ok: true,
    verb: result.verb,
    type: result.type,
    id: result.id,
    target: result.target,
    permission: result.permission,
  });
}

async function getSurfaceConfig(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.config) return sendJson(res, 404, { error: "not_found" });
  const [webuiModels, baseModel, externalSlackParticipants, branding] = await Promise.all([
    deps.config.getWebuiModelsDurable(orgScope(deps)),
    deps.config.getBaseModelDurable(orgScope(deps)),
    deps.config.getExternalSlackParticipantsDurable(orgScope(deps)),
    resolveBranding(deps.config, orgScope(deps), deps.brandingDefault),
  ]);
  const harnessId = deps.harnessId ?? "pi";
  const managedKeys = deps.modelCredentials ? await deps.modelCredentials.availability() : null;
  const catalog = managedKeys?.openrouter
    ? await selectableModelCatalog(deps.modelCredentialFetch)
    : builtInModelCatalog();
  const allowed = selectableCatalogForHarness(catalog, harnessId).map((model) => model.id);
  const configuredPicker = webuiModels?.filter((id) => modelSupportedByHarness(id, harnessId)) ?? [];
  const resolvedBase = modelSupportedByHarness(baseModel ?? undefined, harnessId)
    ? baseModel!
    : defaultModelForHarness(harnessId, deps.baseModelDefault);
  const resolvedBranding = {
    ...(branding.accent ? { accent: branding.accent } : {}),
    ...(branding.mark ? { mark: branding.mark } : {}),
    ...(branding.selfLabel ? { selfLabel: branding.selfLabel } : {}),
  };
  return sendJson(res, 200, {
    webuiModels: configuredPicker.length ? configuredPicker : allowed,
    baseModel: resolvedBase,
    harnessId,
    ...(managedKeys ? { modelProviderConfigured: Object.values(managedKeys).some(Boolean) } : {}),
    externalSlackParticipants,
    ...(Object.keys(resolvedBranding).length ? { branding: resolvedBranding } : {}),
  });
}

function runtimeFallback(ctx: ApiCtx): { harnessId: HarnessId; modelId: string } {
  const harnessId = isHarnessId(ctx.deps.harnessId) ? ctx.deps.harnessId : "pi";
  return { harnessId, modelId: defaultModelForHarness(harnessId, ctx.deps.baseModelDefault) };
}

async function runtimeTarget(ctx: ApiCtx): Promise<{ actorId: string; scope: ScopeId } | null> {
  const actorId =
    ctx.capability?.actorId ??
    (isObj(ctx.body) && typeof ctx.body.principalId === "string"
      ? ctx.body.principalId
      : ctx.url.searchParams.get("principalId"));
  const scope =
    ctx.capability?.scopeId ??
    (isObj(ctx.body) && typeof ctx.body.scopeId === "string" ? ctx.body.scopeId : ctx.url.searchParams.get("scopeId"));
  if (!actorId || !scope) return null;
  const parsed = parseScopeId(scope);
  if (parsed.kind === "personal" && parsed.ref === actorId) return { actorId, scope: scope as ScopeId };
  if (ctx.capability && parsed.kind !== "org") return { actorId, scope: scope as ScopeId };
  if (parsed.kind !== "org" && (await ctx.app.belongsToScope(actorId, scope as ScopeId)))
    return { actorId, scope: scope as ScopeId };
  return null;
}

async function runtimeConfigBody(ctx: ApiCtx, scope: ScopeId): Promise<Record<string, unknown>> {
  const config = ctx.deps.config!;
  const fallback = runtimeFallback(ctx);
  const org = orgScope(ctx.deps);
  const approvedHarnesses = ((await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId]).filter(isHarnessId);
  const firstApproved = approvedHarnesses[0] ?? fallback.harnessId;
  const safeFallback =
    approvedHarnesses.includes(fallback.harnessId) && modelSupportedByHarness(fallback.modelId, fallback.harnessId)
      ? fallback
      : { harnessId: firstApproved, modelId: defaultModelForHarness(firstApproved, fallback.modelId) };
  const configuredKeys = ctx.deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
  const managedKeys = ctx.deps.modelCredentials ? await ctx.deps.modelCredentials.availability() : configuredKeys;
  const providersFor = (harnessId: string) => modelProviderAvailabilityFor(harnessId, configuredKeys, managedKeys);
  const catalog =
    ctx.deps.modelCredentials && managedKeys.openrouter
      ? await selectableModelCatalog(ctx.deps.modelCredentialFetch)
      : builtInModelCatalog();
  const orgStored = await config.getRuntimeSelectionDurable(org);
  const orgLegacyModel = orgStored ? null : await config.getBaseModelOwnDurable(org);
  let orgDefault: {
    harnessId: HarnessId;
    modelId: string;
    effortLevel?: string;
    fastMode?: boolean;
    revision: number;
  } = { ...safeFallback, revision: orgStored?.revision ?? 0 };
  if (
    orgStored &&
    isHarnessId(orgStored.harnessId) &&
    approvedHarnesses.includes(orgStored.harnessId) &&
    modelSupportedByHarness(orgStored.modelId, orgStored.harnessId)
  ) {
    orgDefault = {
      harnessId: orgStored.harnessId,
      modelId: orgStored.modelId,
      ...(orgStored.effortLevel ? { effortLevel: orgStored.effortLevel } : {}),
      ...(typeof orgStored.fastMode === "boolean" ? { fastMode: orgStored.fastMode } : {}),
      revision: orgStored.revision ?? 0,
    };
  } else if (
    orgLegacyModel &&
    approvedHarnesses.includes(fallback.harnessId) &&
    modelSupportedByHarness(orgLegacyModel, fallback.harnessId)
  ) {
    orgDefault = { harnessId: fallback.harnessId, modelId: orgLegacyModel, revision: 0 };
  }
  const stored = scope === org ? orgStored : await config.getRuntimeSelectionDurable(scope);
  const legacyModel = scope === org ? null : await config.getBaseModelOwnDurable(scope);
  let scopeOverride: {
    harnessId: HarnessId;
    modelId: string;
    effortLevel?: string;
    fastMode?: boolean;
    orgRevision?: number;
  } | null = null;
  if (
    stored &&
    isHarnessId(stored.harnessId) &&
    approvedHarnesses.includes(stored.harnessId) &&
    modelSupportedByHarness(stored.modelId, stored.harnessId)
  ) {
    scopeOverride = {
      harnessId: stored.harnessId,
      modelId: stored.modelId,
      ...(stored.effortLevel ? { effortLevel: stored.effortLevel } : {}),
      ...(typeof stored.fastMode === "boolean" ? { fastMode: stored.fastMode } : {}),
      orgRevision: stored.orgRevision,
    };
  } else if (
    legacyModel &&
    approvedHarnesses.includes(fallback.harnessId) &&
    modelSupportedByHarness(legacyModel, fallback.harnessId)
  ) {
    scopeOverride = { harnessId: fallback.harnessId, modelId: legacyModel, orgRevision: 0 };
  }
  const effective = scopeOverride ?? orgDefault;
  const selected = [orgDefault, scopeOverride, effective].filter((choice) => choice !== null);
  const allowlist = await config.getWebuiModelsDurable(org);
  const modelsByHarness = Object.fromEntries(
    approvedHarnesses.map((harnessId) => {
      const ids = allowlist?.length
        ? allowlist.filter((id) => modelSupportedByHarness(id, harnessId))
        : selectableCatalogForHarness(catalog, harnessId).map((model) => model.id);
      for (const choice of selected) {
        if (
          choice.harnessId === harnessId &&
          modelSupportedByHarness(choice.modelId, harnessId) &&
          !ids.includes(choice.modelId)
        )
          ids.push(choice.modelId);
      }
      return [harnessId, serviceableModelIds(ids, providersFor(harnessId))];
    }),
  );
  const advertisedModelIds = new Set(Object.values(modelsByHarness).flat());
  const modelCatalog = Object.fromEntries(
    [...advertisedModelIds].flatMap((id) => {
      const model = catalog.find((candidate) => candidate.id === id);
      if (model) return [[id, { name: model.name, provider: model.provider }]];
      const resolved = resolveModel(id);
      return resolved ? [[id, { name: resolved.name, provider: resolved.provider }]] : [];
    }),
  );
  return {
    scopeId: scope,
    approvedHarnesses,
    modelsByHarness,
    modelCatalog,
    orgDefault,
    scopeOverride,
    effective: {
      harnessId: effective.harnessId,
      modelId: effective.modelId,
      ...(effective.effortLevel ? { effortLevel: effective.effortLevel } : {}),
      ...(typeof effective.fastMode === "boolean" ? { fastMode: effective.fastMode } : {}),
    },
    upgradeAvailable: Boolean(scopeOverride && scopeOverride.orgRevision !== orgDefault.revision),
    fastModeModelIds: FAST_MODE_MODEL_IDS,
    interactiveFastMode: await config.getInteractiveFastModeDurable(),
  };
}

async function getRuntimeConfig(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.config) return sendJson(ctx.res, 404, { error: "not_found" });
  const target = await runtimeTarget(ctx);
  if (!target) return sendJson(ctx.res, 403, { error: "forbidden" });
  return sendJson(ctx.res, 200, await runtimeConfigBody(ctx, target.scope));
}

async function webuiModelEnabled(ctx: ApiCtx, modelId: string): Promise<boolean> {
  const config = ctx.deps.config!;
  const picker = await config.getWebuiModelsDurable(orgScope(ctx.deps));
  if (!picker?.length || picker.includes(modelId)) return true;
  const org = orgScope(ctx.deps);
  const stored = await config.getRuntimeSelectionDurable(org);
  const orgModel = stored?.modelId ?? (await config.getBaseModelOwnDurable(org)) ?? runtimeFallback(ctx).modelId;
  return modelId === orgModel;
}

async function putRuntimeConfig(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.config || !isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request" });
  if (ctx.capability && ctx.capability.liveActor !== true)
    return sendJson(ctx.res, 403, { error: "live_actor_required" });
  const target = await runtimeTarget(ctx);
  if (!target) return sendJson(ctx.res, 403, { error: "forbidden" });
  const config = ctx.deps.config;
  if (ctx.body.inherit === true) await config.setRuntimeSelectionLatest(target.scope, null);
  else if (ctx.body.keep === true) {
    const runtime = await config.getRuntimeSelectionDurable(target.scope);
    if (runtime) await config.acknowledgeRuntimeSelectionLatest(target.scope);
    else {
      const legacyModel = await config.getBaseModelOwnDurable(target.scope);
      const fallback = runtimeFallback(ctx);
      const approved = (await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId];
      if (
        legacyModel &&
        approved.includes(fallback.harnessId) &&
        modelSupportedByHarness(legacyModel, fallback.harnessId) &&
        (await webuiModelEnabled(ctx, legacyModel))
      ) {
        await config.setRuntimeSelectionLatest(target.scope, { harnessId: fallback.harnessId, modelId: legacyModel });
      }
    }
  } else {
    const harnessId = ctx.body.harnessId;
    const modelId = ctx.body.modelId;
    const fallback = runtimeFallback(ctx);
    const approved = (await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId];
    if (!isHarnessId(harnessId) || !approved.includes(harnessId))
      return sendJson(ctx.res, 400, { error: "harness_not_approved" });
    if (typeof modelId !== "string" || !modelSupportedByHarness(modelId, harnessId))
      return sendJson(ctx.res, 400, { error: "model_not_supported" });
    if (!(await webuiModelEnabled(ctx, modelId))) return sendJson(ctx.res, 400, { error: "model_not_enabled" });
    const effortLevel = ctx.body.effortLevel ?? "auto";
    if (typeof effortLevel !== "string" || !(THINKING_LEVELS as readonly string[]).includes(effortLevel))
      return sendJson(ctx.res, 400, { error: "effort_not_supported" });
    const fastMode = ctx.body.fastMode ?? false;
    if (typeof fastMode !== "boolean") return sendJson(ctx.res, 400, { error: "fast_mode_invalid" });
    await config.setRuntimeSelectionLatest(target.scope, {
      harnessId,
      modelId,
      effortLevel,
      fastMode: fastMode && FAST_MODE_MODEL_IDS.includes(modelId),
    });
  }
  audit(ctx.deps, {
    principalId: target.actorId,
    action: "runtime-config.update",
    resource: "runtime-config",
    scopeLabel: target.scope,
  });
  return sendJson(ctx.res, 200, await runtimeConfigBody(ctx, target.scope));
}

async function getChannelHeaderPin(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.config) return sendJson(ctx.res, 404, { error: "not_found" });
  const target = await runtimeTarget(ctx);
  if (!target) return sendJson(ctx.res, 403, { error: "forbidden" });
  const [on, configured, def] = await Promise.all([
    ctx.deps.config.getChannelHeaderPinDurable(target.scope),
    ctx.deps.config.getChannelHeaderPinOverrideDurable(target.scope),
    ctx.deps.config.getChannelHeaderPinDefaultDurable(),
  ]);
  return sendJson(ctx.res, 200, { scopeId: target.scope, on, configured, default: def });
}

async function putChannelHeaderPin(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.config || !isObj(ctx.body)) return sendJson(ctx.res, 400, { error: "bad_request" });
  if (ctx.capability && !livePersonCapability(ctx.capability))
    return sendJson(ctx.res, 403, { error: "live_actor_required" });
  const target = await runtimeTarget(ctx);
  if (!target) return sendJson(ctx.res, 403, { error: "forbidden" });
  if (typeof ctx.body.on !== "boolean" && ctx.body.on !== null)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "expected { on: boolean | null } (null reverts to the org default)",
    });
  await ctx.deps.config.setChannelHeaderPinLatest(target.scope, ctx.body.on);
  audit(ctx.deps, {
    principalId: target.actorId,
    action: "channel-header-pin.update",
    resource: "channel-header-pin",
    scopeLabel: target.scope,
  });
  return sendJson(ctx.res, 200, {
    scopeId: target.scope,
    on: ctx.body.on ?? (await ctx.deps.config.getChannelHeaderPinDefaultDurable()),
    configured: ctx.body.on,
  });
}

function getSoul(ctx: ApiCtx): void {
  const { res, app, url, capability } = ctx;
  const scopeIdVal = capability?.scopeId ?? url.searchParams.get("scopeId");
  if (!scopeIdVal) return sendJson(res, 400, { error: "bad_request", message: "scopeId required" });
  return sendJson(res, 200, app.getSoul(scopeIdVal));
}

export async function postSoul(ctx: ApiCtx): Promise<void> {
  const { res, app, body, capability } = ctx;
  let scopeIdVal: string;
  let content: string;
  let actorId: string;
  if (capability) {
    const b = body as { content?: unknown };
    if (typeof b.content !== "string")
      return sendJson(res, 400, { error: "bad_request", message: "content (string) required" });
    actorId = capability.actorId;
    scopeIdVal = capability.scopeId;
    content = b.content;
  } else {
    const b = body as { scopeId?: string; content?: string; actorId?: string };
    if (typeof b.scopeId !== "string" || typeof b.content !== "string" || typeof b.actorId !== "string") {
      return sendJson(res, 400, { error: "bad_request", message: "scopeId, content, actorId required" });
    }
    scopeIdVal = b.scopeId;
    content = b.content;
    actorId = b.actorId;
  }
  const allowSharedScope =
    Boolean(capability) ||
    (parseScopeId(scopeIdVal).kind !== "personal" && (await app.managesScope(actorId, scopeIdVal as ScopeId)));
  try {
    const version = await app.updateSoul(
      scopeIdVal,
      content,
      actorId,
      allowSharedScope ? { allowSharedScope: true } : undefined,
    );
    return sendJson(res, 200, { ok: true, version });
  } catch (e) {
    const message = errMessage(e);
    const denied = message === "not authorized to update SOUL for this scope";
    return sendJson(res, denied ? 403 : 500, { error: denied ? "soul_update_denied" : "soul_update_failed", message });
  }
}

export const surfaceRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/session-cap", auth: "source", handle: sessionCapability },
  { method: "GET", path: "/v1/sessions/search", auth: "source", handle: searchSessions },
  { method: "POST", path: "/v1/sessions/:id/title", auth: "source", handle: regenerateSessionTitle },
  { method: "POST", path: "/v1/sessions/:id/fork", auth: "source", handle: forkSession },
  { method: "GET", path: "/v1/sessions/:id/approvals", auth: "source", handle: listSessionApprovals },
  { method: "GET", path: "/v1/sessions/:id/background", auth: "source", handle: getSessionBackground },
  {
    method: "GET",
    path: "/v1/sessions/:id/background/:pid/output",
    auth: "source",
    handle: getSessionBackgroundOutput,
  },
  { method: "GET", path: "/v1/sessions/:id/entries/:seq", auth: "source", handle: getSessionEntry },
  { method: "GET", path: "/v1/sessions/:id", auth: "source", handle: getSession },
  { method: "GET", path: "/v1/files/:id/content", auth: "either", handle: getFileContent },
  { method: "POST", path: "/v1/files/upload", auth: "source", handle: uploadFile },
  { method: "GET", path: "/v1/files", auth: "either", handle: listFiles },
  { method: "POST", path: "/v1/sessions/:id", auth: "source", handle: patchSession },
  { method: "GET", path: "/v1/sessions", auth: "source", handle: listSessions },
  { method: "GET", path: "/v1/conversations", auth: "either", handle: listAgentConversations },
  { method: "GET", path: "/v1/conversations/:id", auth: "either", handle: getAgentConversation },
  { method: "POST", path: "/v1/conversations/:id", auth: "either", handle: patchAgentConversation },
  { method: "POST", path: "/v1/conversations", auth: "either", handle: spawnAgentConversation },
  { method: "POST", path: "/v1/conversations/:id/fork", auth: "either", handle: forkAgentConversation },
  { method: "GET", path: "/v1/contexts", auth: "source", handle: listContexts },
  { method: "GET", path: "/v1/scope-resources", auth: "source", handle: listScopeResources },
  { method: "GET", path: "/v1/ui-state", auth: "source", handle: getUiState },
  { method: "PUT", path: "/v1/ui-state", auth: "source", handle: putUiState },
  { method: "GET", path: "/v1/memory", auth: "source", handle: getSelfMemory },
  { method: "PUT", path: "/v1/memory", auth: "source", handle: putSelfMemory },
  { method: "GET", path: "/v1/memory/history", auth: "either", handle: getSelfMemoryHistory },
  { method: "POST", path: "/v1/memory/restore", auth: "either", handle: restoreSelfMemory },
  { method: "GET", path: "/v1/apis", auth: "either", handle: listAgentApis },
  {
    match: (m, p) =>
      (p === "/v1/memory/self" && (m === "GET" || m === "PUT")) ||
      (m === "POST" && (p === "/v1/memory/search" || p === "/v1/memory/facts")),
    auth: "either",
    handle: agentMemory,
  },
  {
    match: (_m, p) => p === "/v1/memory/self" || p === "/v1/memory/search" || p === "/v1/memory/facts",
    auth: "source",
    handle: agentMemory,
  },
  { method: "GET", path: "/v1/skills", auth: "source", handle: listSkills },
  { method: "GET", path: "/v1/skills/:id", auth: "either", handle: getSkillDetail },
  { method: "POST", path: "/v1/skills", auth: "either", handle: createSkill },
  { method: "PUT", path: "/v1/skills/:id", auth: "either", handle: updateSkill },
  { method: "DELETE", path: "/v1/skills/:id", auth: "either", handle: deleteSkill },
  { method: "POST", path: "/v1/skills/:id/restore", auth: "either", handle: restoreSkill },
  { method: "POST", path: "/v1/grants", auth: "source", handle: createGrant },
  { method: "POST", path: "/v1/grants/revoke", auth: "source", handle: revokeGrant },
  { method: "POST", path: "/v1/share", auth: "either", handle: shareArtifact },
  { method: "GET", path: "/v1/surface-config", auth: "source", handle: getSurfaceConfig },
  { method: "GET", path: "/v1/runtime-config", auth: "either", handle: getRuntimeConfig },
  { method: "PUT", path: "/v1/runtime-config", auth: "either", handle: putRuntimeConfig },
  { method: "GET", path: "/v1/channel-header-pin", auth: "either", handle: getChannelHeaderPin },
  { method: "PUT", path: "/v1/channel-header-pin", auth: "either", handle: putChannelHeaderPin },
  { method: "GET", path: "/v1/soul", auth: "either", handle: getSoul },
  { method: "POST", path: "/v1/soul", auth: "either", handle: postSoul },
];
