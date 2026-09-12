import { sendJson } from "../http.ts";
import { errMessage } from "../../util/errors.ts";
import type { SwarmCaller } from "../../swarms/swarm-service.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function swarmRequest(ctx: ApiCtx): Promise<void> {
  const { app, res, body, capability, actor, params, method, url } = ctx;
  if (!app.swarms) return sendJson(res, 503, { error: "swarm service unavailable" });
  let caller: SwarmCaller;
  if (capability && !params.id) caller = { kind: "agent", claims: capability };
  else if (actor && params.id && !capability) {
    if (!(await app.getSessionForViewer(params.id, actor.p)))
      return sendJson(res, 403, { error: "session access denied" });
    caller = {
      kind: "human",
      actorId: actor.p,
      sessionId: params.id,
      ...(isObj(body) && typeof body.runId === "string" ? { runId: body.runId } : {}),
    };
  } else return sendJson(res, 403, { error: "session-bound authentication required" });
  try {
    if (method === "GET") {
      if (url.searchParams.get("read") === "1") {
        const messages = await app.swarms.read(caller, {
          after: Number(url.searchParams.get("after") ?? 0),
          waitMs: Number(url.searchParams.get("waitMs") ?? 0),
          ...(url.searchParams.has("replyTo") ? { replyTo: url.searchParams.get("replyTo")! } : {}),
        });
        return sendJson(res, 200, { messages });
      }
      return sendJson(res, 200, await app.swarms.inspect(caller));
    }
    if (!isObj(body)) throw new Error("expected an object");
    const allowed = new Set([
      "action",
      ...(caller.kind === "human" ? ["runId"] : []),
      ...(body.action === "context" ? ["context"] : ["requestId", "text"]),
      ...(body.action === "spawn" ? ["count", "context", "contexts", "forumSandboxId"] : []),
      ...(body.action === "send" ? ["audience", "replyTo", "notify"] : []),
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("unsupported swarm request field");
    if (body.action === "context") {
      if (!("context" in body)) throw new Error("context required");
      return sendJson(res, 200, await app.swarms.context(caller, body.context));
    }
    if (typeof body.requestId !== "string" || typeof body.text !== "string")
      throw new Error("requestId and text required");
    if (body.action === "spawn") {
      if (body.count !== undefined && typeof body.count !== "number") throw new Error("invalid count");
      if (body.contexts !== undefined && !Array.isArray(body.contexts)) throw new Error("invalid contexts");
      if (body.forumSandboxId !== undefined && typeof body.forumSandboxId !== "string")
        throw new Error("invalid forumSandboxId");
      const members = await app.swarms.spawn(caller, {
        requestId: body.requestId,
        text: body.text,
        ...(typeof body.count === "number" ? { count: body.count } : {}),
        ...("context" in body ? { context: body.context } : {}),
        ...(Array.isArray(body.contexts) ? { contexts: body.contexts } : {}),
        ...(typeof body.forumSandboxId === "string" ? { forumSandboxId: body.forumSandboxId } : {}),
      });
      return sendJson(res, 202, { members });
    }
    if (body.action === "send") {
      if (
        typeof body.audience !== "string" ||
        (body.notify !== undefined && typeof body.notify !== "boolean") ||
        (body.replyTo !== undefined && typeof body.replyTo !== "string")
      )
        throw new Error("invalid message parameters");
      const message = await app.swarms.send(caller, {
        requestId: body.requestId,
        text: body.text,
        audience: body.audience,
        ...(typeof body.notify === "boolean" ? { notify: body.notify } : {}),
        ...(typeof body.replyTo === "string" ? { replyTo: body.replyTo } : {}),
      });
      return sendJson(res, 202, { message });
    }
    throw new Error("unknown swarm action");
  } catch (error) {
    return sendJson(res, 400, { error: errMessage(error) });
  }
}

export const swarmRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/swarm", auth: "either", handle: swarmRequest },
  { method: "POST", path: "/v1/swarm", auth: "either", handle: swarmRequest },
  { method: "GET", path: "/v1/sessions/:id/swarm", auth: "source", handle: swarmRequest },
  { method: "POST", path: "/v1/sessions/:id/swarm", auth: "source", handle: swarmRequest },
];
