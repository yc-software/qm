import { sendJson } from "../http.ts";
import { errMessage } from "../../util/errors.ts";
import type { SwarmCaller } from "../../swarms/swarm-service.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function swarmRequest(ctx: ApiCtx): Promise<void> {
  const { app, res, body, capability, actor, params, method, url } = ctx;
  const query = new URLSearchParams(url.searchParams);
  query.delete("_sourceAuthNonce");
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
      if (query.get("board") === "1") {
        if (caller.kind !== "human") return sendJson(res, 403, { error: "human session required" });
        if (
          [...query.keys()].some(
            (key) =>
              !["board", "visibility", "after", "id", "replyTo", "sender", "recipient", "search", "limit"].includes(
                key,
              ) || query.getAll(key).length !== 1,
          )
        )
          throw new Error("invalid board parameters");
        return sendJson(
          res,
          200,
          await app.swarms.board(caller, {
            ...Object.fromEntries([...query].filter(([key]) => key !== "board" && key !== "limit")),
            visibility: (query.get("visibility") ?? "private") as "private" | "org",
            ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}),
          }),
        );
      }
      if (query.get("discover") === "1") {
        if (
          [...query.keys()].some(
            (key) => !["discover", "after", "limit", "search"].includes(key) || query.getAll(key).length !== 1,
          )
        )
          throw new Error("unsupported discovery parameter");
        return sendJson(
          res,
          200,
          await app.swarms.discover(caller, {
            ...(query.has("after") ? { after: query.get("after")! } : {}),
            ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}),
            ...(query.has("search") ? { search: query.get("search")! } : {}),
          }),
        );
      }
      if (query.has("visibility")) {
        if (
          query.get("visibility") !== "org" ||
          query.get("read") !== "1" ||
          [...query.keys()].some(
            (key) =>
              !["read", "visibility", "after", "id", "replyTo", "limit", "search"].includes(key) ||
              query.getAll(key).length !== 1,
          )
        )
          throw new Error("invalid public read parameters");
        return sendJson(
          res,
          200,
          await app.swarms.readPublic(caller, {
            ...(query.has("after") ? { after: query.get("after")! } : {}),
            ...(query.has("id") ? { id: query.get("id")! } : {}),
            ...(query.has("replyTo") ? { replyTo: query.get("replyTo")! } : {}),
            ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}),
            ...(query.has("search") ? { search: query.get("search")! } : {}),
          }),
        );
      }
      if (query.get("read") === "1") {
        const messages = await app.swarms.read(caller, {
          after: Number(query.get("after") ?? 0),
          waitMs: Number(query.get("waitMs") ?? 0),
          ...(query.has("replyTo") ? { replyTo: query.get("replyTo")! } : {}),
        });
        return sendJson(res, 200, { messages });
      }
      return sendJson(res, 200, await app.swarms.inspect(caller));
    }
    if (!isObj(body)) throw new Error("expected an object");
    if (body.action === "limit") {
      if (
        Object.keys(body).some((key) => !["action", "descendants"].includes(key)) ||
        typeof body.descendants !== "number"
      )
        throw new Error("invalid descendant limit request");
      return sendJson(res, 200, await app.swarms.limit(caller, body.descendants));
    }
    if (body.action === "control") {
      if (caller.kind !== "human") return sendJson(res, 403, { error: "human scope management required" });
      if (
        Object.keys(body).some((key) => !["action", "memberId", "command", "subtree", "version"].includes(key)) ||
        typeof body.memberId !== "string" ||
        !["pause", "resume", "stop"].includes(String(body.command)) ||
        (body.subtree !== undefined && typeof body.subtree !== "boolean") ||
        (body.version !== undefined && typeof body.version !== "number")
      )
        throw new Error("invalid control request");
      return sendJson(res, 200, {
        peers: await app.swarms.control(caller, {
          memberId: body.memberId,
          command: body.command as "pause" | "resume" | "stop",
          ...(typeof body.subtree === "boolean" ? { subtree: body.subtree } : {}),
          ...(typeof body.version === "number" ? { version: body.version } : {}),
        }),
      });
    }
    if (body.action === "character") {
      const allowed = new Set([
        "action",
        "version",
        "name",
        "character",
        ...(caller.kind === "human" ? ["runId"] : []),
      ]);
      if (
        Object.keys(body).some((key) => !allowed.has(key)) ||
        typeof body.version !== "number" ||
        typeof body.name !== "string" ||
        !("character" in body)
      )
        throw new Error("invalid character request");
      return sendJson(
        res,
        200,
        await app.swarms.character(caller, { version: body.version, name: body.name, character: body.character }),
      );
    }
    if (body.visibility === "org" || body.action === "preview") {
      const preview = body.action === "preview";
      const allowed = [
        "action",
        "visibility",
        "audience",
        "versions",
        ...(caller.kind === "human" ? ["runId"] : []),
        ...(preview ? [] : ["requestId", "text", "replyTo", "notify"]),
      ];
      if (
        body.visibility !== "org" ||
        (!preview && body.action !== "send") ||
        Object.keys(body).some((key) => !allowed.includes(key)) ||
        !Array.isArray(body.audience) ||
        (body.versions !== undefined && !isObj(body.versions))
      )
        throw new Error("invalid public message request");
      const audience = body.audience as string[];
      const versions = body.versions as Record<string, number> | undefined;
      if (preview) return sendJson(res, 200, { audience: await app.swarms.preview(caller, { audience, versions }) });
      if (
        typeof body.requestId !== "string" ||
        typeof body.text !== "string" ||
        (body.notify !== undefined && typeof body.notify !== "boolean") ||
        (body.replyTo !== undefined && typeof body.replyTo !== "string")
      )
        throw new Error("invalid public message parameters");
      return sendJson(res, 202, {
        message: await app.swarms.publish(caller, {
          requestId: body.requestId,
          text: body.text,
          audience,
          versions,
          ...(typeof body.notify === "boolean" ? { notify: body.notify } : {}),
          ...(typeof body.replyTo === "string" ? { replyTo: body.replyTo } : {}),
        }),
      });
    }
    const allowed = new Set([
      "action",
      ...(caller.kind === "human" ? ["runId"] : []),
      ...(body.action === "context" ? ["context"] : ["requestId", "text"]),
      ...(body.action === "spawn" ? ["count", "context", "contexts", "forumSandboxId"] : []),
      ...(body.action === "send" ? ["audience", "replyTo", "notify"] : []),
      ...(body.action === "spawn" ? ["settings", "backend"] : []),
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
      if (body.settings !== undefined && !isObj(body.settings)) throw new Error("invalid settings");
      if (body.backend !== undefined && typeof body.backend !== "string") throw new Error("invalid backend");
      const members = await app.swarms.spawn(caller, {
        requestId: body.requestId,
        text: body.text,
        ...(typeof body.count === "number" ? { count: body.count } : {}),
        ...("context" in body ? { context: body.context } : {}),
        ...(Array.isArray(body.contexts) ? { contexts: body.contexts } : {}),
        ...(typeof body.forumSandboxId === "string" ? { forumSandboxId: body.forumSandboxId } : {}),
        ...(isObj(body.settings) ? { settings: body.settings } : {}),
        ...(typeof body.backend === "string" ? { backend: body.backend } : {}),
      });
      return sendJson(res, 202, { members });
    }
    if (body.action === "send") {
      if (
        !(Array.isArray(body.audience) || body.audience === "all") ||
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
