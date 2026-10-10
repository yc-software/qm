import { randomUUID } from "node:crypto";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { collectNamedOutbound, MAX_OUTBOUND_FILES, type ArtifactRegistration } from "../../core/attachments.ts";
import { hasParentPathSegment } from "../../sandbox/sandbox.ts";
import { resolveEnvironmentId } from "../../environments/environment-store.ts";
import { errMessage } from "../../util/errors.ts";
import { scopeId, type OutgoingAttachment } from "../../types.ts";
import { awaitContextOutcome } from "../surface-context-puller.ts";
import { askAgentAvailable } from "../../resolution/sharing-posture.ts";

type ReachBody = {
  recipient?: unknown;
  channel?: unknown;
  participants?: unknown;
  text?: unknown;
  message?: unknown;
  threadTs?: unknown;
  unfurlLinks?: unknown;
  react?: unknown;
  delete?: unknown;
  files?: unknown;
  task?: unknown;
};

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;

async function askAgent(ctx: ApiCtx, b: ReachBody, task: string): Promise<void> {
  const { res, app, deps } = ctx;
  const cap = ctx.capability!;
  const extra = [b.channel, b.participants, b.react, b.delete, b.files, b.threadTs].some((v) => v !== undefined);
  if (typeof b.recipient !== "string" || extra) {
    return sendJson(res, 400, { error: "bad_request", message: "task goes to one recipient, with no other options" });
  }
  const where = { surface: cap.surface, scopeId: cap.scopeId, external: !!cap.externalSlack };
  const posture =
    cap.runId && (await deps.config?.resolveSharingPostureDurable(scopeId("personal", cap.actorId), cap.scopeId));
  if (!cap.runId || !askAgentAvailable({ ...where, posture: posture || "isolated" })) {
    return sendJson(res, 409, {
      error: "unavailable",
      message:
        "asking a personal agent works only during a live turn in an internal, Isolated Slack channel; in Open conversations do the work yourself with the requester's own access",
    });
  }
  let person = b.recipient.trim();
  let recipient: { principalId: string; displayName: string } | undefined;
  if (!SLACK_USER_ID.test(person)) {
    const r = await app.resolveReachTarget({ recipient: person }, cap.actorId);
    if (!r.ok) {
      return sendJson(res, r.status, {
        error: r.error,
        message: r.message,
        ...(r.candidates && { candidates: r.candidates }),
      });
    }
    recipient = r.recipient;
    person = r.recipient?.slackId ?? r.recipient?.principalId ?? "";
    if (!SLACK_USER_ID.test(person)) {
      return sendJson(res, 404, {
        error: "recipient_not_found",
        message: `${b.recipient} has no linked Slack account`,
      });
    }
  }
  const request = await app.createContextRequest("slack", {
    count: 1,
    askAgent: { runId: cap.runId, targetUserId: person, task: task.slice(0, 4000) },
  });
  const outcome = await awaitContextOutcome(app, request.id, { waitMs: 25_000, pollMs: 100 });
  if (outcome.status === "done" && outcome.result.handoff) {
    return sendJson(res, 200, {
      ok: true,
      requestId: outcome.result.handoff.requestId,
      ...(recipient && { recipient }),
      message: `Sent the request to ${outcome.result.handoff.target} for approval and posted its status in this thread. Nothing has run yet; the result posts here only if they approve.`,
    });
  }
  if (outcome.status === "timeout") {
    return sendJson(res, 504, {
      error: "timeout",
      message: "Slack didn't confirm the request in time; sending the same recipient and task again is safe",
    });
  }
  return sendJson(res, 409, {
    error: "not_sent",
    message: outcome.status === "failed" && outcome.error ? outcome.error : "the request was not sent",
  });
}

function parseFiles(v: unknown): { ok: true; files: string[] } | { ok: false; message: string } {
  if (v === undefined) return { ok: true, files: [] };
  if (!Array.isArray(v) || v.some((p) => typeof p !== "string" || !p.trim())) {
    return {
      ok: false,
      message: 'files must be an array of workspace-relative path strings, e.g. ["work/report.pdf"]',
    };
  }
  if (v.length > MAX_OUTBOUND_FILES) return { ok: false, message: `too many files (max ${MAX_OUTBOUND_FILES})` };
  if ((v as string[]).some(hasParentPathSegment)) {
    return { ok: false, message: "files must stay inside the workspace — no .. path segments" };
  }
  return { ok: true, files: v as string[] };
}

function parseReact(v: unknown): { messageTs: string; emoji: string } | undefined {
  if (!isObj(v)) return undefined;
  const ts = (v as { ts?: unknown }).ts;
  const emoji = (v as { emoji?: unknown }).emoji;
  if (typeof ts !== "string" || !ts.trim() || typeof emoji !== "string" || !emoji.trim()) return undefined;
  return { messageTs: ts, emoji };
}

function parseDelete(v: unknown): { messageTs: string } | undefined {
  if (!isObj(v)) return undefined;
  const ts = (v as { ts?: unknown }).ts;
  if (typeof ts !== "string" || !ts.trim()) return undefined;
  return { messageTs: ts };
}

async function reachNow(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body, capability } = ctx;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "reach requires an agent capability token" });
  const rate = await deps.rateLimiter?.check(`reach:${capability.actorId}`);
  if (rate && !rate.allowed)
    return sendJson(res, 429, { error: "rate_limited", message: "too many outbound actions; try again later" });
  const b = (isObj(body) ? body : {}) as ReachBody;
  if (b.task !== undefined) {
    if (typeof b.task !== "string" || !b.task.trim()) {
      return sendJson(res, 400, { error: "bad_request", message: "task must be a non-empty string" });
    }
    return askAgent(ctx, b, b.task.trim());
  }
  let text: string | undefined;
  if (typeof b.text === "string") text = b.text;
  else if (typeof b.message === "string") text = b.message;
  const react = parseReact(b.react);
  const del = parseDelete(b.delete);
  let threadTs: string | undefined;
  if (b.threadTs !== undefined) {
    if (typeof b.threadTs !== "string" || !/^\d+\.\d+$/.test(b.threadTs.trim())) {
      return sendJson(res, 400, {
        error: "bad_request",
        message:
          'threadTs must be the parent message\'s ts string, e.g. "1723497600.123456" — find it via /v1/surface-context',
      });
    }
    threadTs = b.threadTs.trim();
    if (react || del) {
      return sendJson(res, 400, {
        error: "bad_request",
        message: "threadTs threads a text post — react/delete already name their target message ts",
      });
    }
  }
  const hasNamedTarget =
    typeof b.recipient === "string" || typeof b.channel === "string" || Array.isArray(b.participants);
  if (react && del) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "react and delete are separate actions — send one at a time",
    });
  }
  const filesParsed = parseFiles(b.files);
  if (!filesParsed.ok) return sendJson(res, 400, { error: "bad_request", message: filesParsed.message });
  const files = filesParsed.files;
  if (files.length && (react || del)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "files compose into a text post — a react/delete carries no attachments",
    });
  }
  if (!react && !del && (text === undefined || text.trim() === "")) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "text (the exact message to send), react ({ ts, emoji }), or delete ({ ts }) required",
    });
  }
  if ((react || del) && typeof b.recipient === "string") {
    return sendJson(res, 400, {
      error: "bad_request",
      message:
        "react/delete targets a message in a channel, group DM, or this conversation — name a channel or participants, not a recipient",
    });
  }
  if (!del && !hasNamedTarget) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: react
        ? "react targets a message in a channel or group DM — name a channel or participants"
        : "name a recipient (a teammate), a channel, or a group DM's participants",
    });
  }
  let attachments: OutgoingAttachment[] | undefined;
  if (files.length) {
    const { sandbox, blobTransfer } = deps;
    if (!sandbox || !blobTransfer) {
      return sendJson(res, 501, {
        error: "not_configured",
        message: "file attachments aren't available on this server — the sandbox/blob store isn't wired",
      });
    }
    const pre = await app.resolveReachTarget(
      {
        ...(typeof b.recipient === "string" ? { recipient: b.recipient } : {}),
        ...(typeof b.channel === "string" ? { channel: b.channel } : {}),
        ...(Array.isArray(b.participants)
          ? { participants: b.participants.filter((p): p is string => typeof p === "string") }
          : {}),
      },
      capability.actorId,
    );
    const openedAtSend = !pre.ok && pre.error === "group_not_found" && Array.isArray(b.participants);
    if (!pre.ok && !openedAtSend) {
      return sendJson(res, pre.status, {
        error: pre.error,
        message: pre.message,
        ...(pre.candidates ? { candidates: pre.candidates } : {}),
      });
    }
    const envScope = await resolveEnvironmentId(deps.environments, capability.scopeId);
    const register: ArtifactRegistration | undefined = deps.files
      ? {
          store: deps.files,
          ownerScopeId: scopeId("personal", capability.actorId),
          createdBy: capability.actorId,
          createdInScope: capability.scopeId,
          seed: `reach:${randomUUID()}`,
          onError: (e) =>
            deps.errors?.record(
              {
                category: "file_store",
                code: "register_failed",
                message: errMessage(e),
                scopeLabel: capability.scopeId,
              },
              e,
            ),
        }
      : undefined;
    const handle = await sandbox.provision([{ scopeId: envScope, mountPath: "", mode: "rw" }]);
    try {
      const r = await collectNamedOutbound(sandbox, handle, files, blobTransfer, register);
      const bad = [
        ...r.missing.map((p) => `${p} (not found)`),
        ...r.empty.map((p) => `${p} (empty)`),
        ...r.oversized.map((p) => `${p} (too large)`),
      ];
      if (bad.length) {
        return sendJson(res, 400, {
          error: "attach_failed",
          message: `couldn't attach: ${bad.join(", ")} — nothing was sent; fix the path(s) and retry`,
        });
      }
      attachments = r.attachments;
    } finally {
      await sandbox.teardown(handle, { keepWarm: true }).catch(() => {});
    }
  }
  const result = await app.reachNow({
    senderId: capability.actorId,
    senderScope: capability.scopeId,
    ...(text !== undefined ? { text } : {}),
    ...(threadTs !== undefined ? { threadTs } : {}),
    ...(react ? { react } : {}),
    ...(del ? { delete: del } : {}),
    ...(typeof b.recipient === "string" ? { recipient: b.recipient } : {}),
    ...(typeof b.channel === "string" ? { channel: b.channel } : {}),
    ...(Array.isArray(b.participants)
      ? { participants: b.participants.filter((p): p is string => typeof p === "string") }
      : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(typeof b.unfurlLinks === "boolean" ? { unfurlLinks: b.unfurlLinks } : {}),
    ...(capability.destination ? { currentDestination: capability.destination } : {}),
  });
  if (!result.ok) {
    return sendJson(res, result.status, {
      error: result.error,
      message: result.message,
      ...(result.candidates ? { candidates: result.candidates } : {}),
    });
  }
  return sendJson(res, 200, {
    ok: true,
    deliveryId: result.delivery.id,
    ...(result.recipient ? { recipient: result.recipient } : {}),
    ...(result.channel ? { channel: result.channel } : {}),
    ...(result.group ? { group: result.group } : {}),
  });
}

export const reachRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/reach", auth: "either", handle: reachNow },
];
