import { randomUUID } from "node:crypto";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { tenantOf, type ApiCtx, type Route } from "./route.ts";
import { collectNamedOutbound, parseOutboundFiles, type ArtifactRegistration } from "../../core/attachments.ts";
import type { SandboxHandle } from "../../sandbox/sandbox.ts";
import {
  accessConversationSandbox,
  assertBotMayUseComputer,
  SandboxAccessError,
  type SandboxResource,
} from "../../sandbox/sandbox-resources.ts";
import { resolveEnvironmentId } from "../../environments/environment-store.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { scopeId, type OutgoingAttachment } from "../../types.ts";

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
  edit?: unknown;
  files?: unknown;
  sandbox_id?: unknown;
};

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

const SLACK_TS = /^\d+\.\d+$/;

async function reachNow(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body, capability } = ctx;
  if (!capability)
    return sendJson(res, 403, { error: "forbidden", message: "reach requires an agent capability token" });
  const b = (isObj(body) ? body : {}) as ReachBody;
  let text: string | undefined;
  if (typeof b.text === "string") text = b.text;
  else if (typeof b.message === "string") text = b.message;
  const react = parseReact(b.react);
  const del = parseDelete(b.delete);
  const editTs = isObj(b.edit) ? (b.edit as { ts?: unknown }).ts : undefined;
  if (b.edit !== undefined && (typeof editTs !== "string" || !SLACK_TS.test(editTs.trim()))) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: 'edit needs { ts } — the ts string of your own message, e.g. "1723497600.123456"',
    });
  }
  const edit = typeof editTs === "string" ? { messageTs: editTs.trim() } : undefined;
  const action = react ?? del ?? edit;
  let threadTs: string | undefined;
  if (b.threadTs !== undefined) {
    if (typeof b.threadTs !== "string" || !SLACK_TS.test(b.threadTs.trim())) {
      return sendJson(res, 400, {
        error: "bad_request",
        message:
          'threadTs must be the parent message\'s ts string, e.g. "1723497600.123456" — find it via /v1/surface-context',
      });
    }
    threadTs = b.threadTs.trim();
    if (action) {
      return sendJson(res, 400, {
        error: "bad_request",
        message: "threadTs threads a text post — react/edit/delete already name their target message ts",
      });
    }
  }
  const hasNamedTarget =
    typeof b.recipient === "string" || typeof b.channel === "string" || Array.isArray(b.participants);
  if ([react, del, edit].filter(Boolean).length > 1) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "react, edit and delete are separate actions — send one at a time",
    });
  }
  const filesParsed = parseOutboundFiles(b.files);
  if (!filesParsed.ok) return sendJson(res, 400, { error: "bad_request", message: filesParsed.message });
  const files = filesParsed.files;
  let requestedSandboxId: string | undefined;
  if (b.sandbox_id !== undefined) {
    if (typeof b.sandbox_id !== "string" || !b.sandbox_id.trim()) {
      return sendJson(res, 400, { error: "bad_request", message: "sandbox_id must be a sandbox id string" });
    }
    if (files.some((f) => typeof f === "string")) requestedSandboxId = b.sandbox_id.trim();
  }
  if (files.length && action) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "files compose into a text post — a react/edit/delete carries no attachments",
    });
  }
  if (!(react || del) && (text === undefined || text.trim() === "")) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: edit
        ? "an edit needs top-level text — the complete new message (edit carries only the ts)"
        : "text (the exact message to send), react ({ ts, emoji }), or delete ({ ts }) required",
    });
  }
  if (action && typeof b.recipient === "string") {
    return sendJson(res, 400, {
      error: "bad_request",
      message:
        "react/edit/delete targets a message in a channel, group DM, or this conversation — name a channel or participants, not a recipient",
    });
  }
  if (!del && !edit && !hasNamedTarget) {
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
    const needsSandbox = files.some((f) => typeof f === "string");
    if (!blobTransfer || (needsSandbox && !sandbox) || (requestedSandboxId && !deps.sandboxResources)) {
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
              tenantOf(ctx),
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
    const botMayUse =
      capability.botActor && app.swarms
        ? (computer: SandboxResource) =>
            app.swarms!.botMayUseComputer(computer, {
              actorId: capability.actorId,
              threadRef: capability.threadRef ?? "",
              sessionId: capability.sessionId ?? "",
            })
        : undefined;
    let resource: SandboxResource | undefined;
    if (requestedSandboxId) {
      try {
        resource = await accessConversationSandbox(
          deps.sandboxResources,
          capability.actorId,
          requestedSandboxId,
          (scope) => scope === capability.scopeId || scope === envScope,
          botMayUse,
        );
      } catch (e) {
        if (!(e instanceof SandboxAccessError)) throw e;
        return sendJson(res, 403, {
          error: "forbidden",
          message: "sandbox_id isn't a computer this conversation can read files from",
        });
      }
    } else if (needsSandbox) {
      try {
        await assertBotMayUseComputer(deps.sandboxResources, envScope, undefined, botMayUse);
      } catch (e) {
        if (!(e instanceof SandboxAccessError)) throw e;
        return sendJson(res, 403, { error: "forbidden", message: e.message });
      }
    }
    let provisioned: Promise<SandboxHandle> | undefined;
    const handle = () =>
      (provisioned ??= resource
        ? sandbox!.provision(resource.ownerScopeId, {
            sandboxId: resource.id,
          })
        : sandbox!.provision(envScope));
    try {
      const r = await collectNamedOutbound(sandbox, handle, files, blobTransfer, register, [], (id) =>
        app.openFileForViewer(tenantOf(ctx), id, capability.actorId),
      );
      const bad = [
        ...r.missing.map((p) => `${p} (not found)`),
        ...r.empty.map((p) => `${p} (empty)`),
        ...r.oversized.map((p) => `${p} (too large)`),
      ];
      if (bad.length) {
        return sendJson(res, 400, {
          error: "attach_failed",
          message: `couldn't attach: ${bad.join(", ")} — nothing was sent; fix the file(s) and retry`,
        });
      }
      attachments = r.attachments;
    } finally {
      if (provisioned) {
        const used = await provisioned.catch(() => undefined);
        if (used)
          await sandbox!.teardown(used, { keepWarm: true }).catch(swallowAs("reach: sandbox teardown", undefined));
      }
    }
  }
  const result = await app.reachNow({
    senderId: capability.actorId,
    senderScope: capability.scopeId,
    ...(text !== undefined ? { text } : {}),
    ...(edit ? { edit } : {}),
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
