import { SeatError } from "../../seat/seat.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

const STATUS = { feature_disabled: 403, step_closed: 409, bad_request: 400, ask_failed: 502 } as const;

async function seated(ctx: ApiCtx, principalId: unknown, work: (ownerId: string) => Promise<unknown>): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.seat) return sendJson(res, 404, { error: "not_found" });
  if (typeof principalId !== "string" || !principalId)
    return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  try {
    return sendJson(res, 200, await work(principalId));
  } catch (error) {
    if (!(error instanceof SeatError)) throw error;
    return sendJson(res, STATUS[error.code], { error: error.code, message: error.message });
  }
}

const bodyPrincipal = (ctx: ApiCtx) => (isObj(ctx.body) ? ctx.body.principalId : undefined);

async function titled<T extends { sessionId: string }>(ctx: ApiCtx, step: T): Promise<T & { sessionTitle?: string }> {
  const title = (await ctx.deps.sessions?.get(step.sessionId))?.title;
  return title ? { ...step, sessionTitle: title } : step;
}

export const seatRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: "/v1/seat/steps",
    browser: "self",
    auth: "source",
    actor: "query.principalId",
    handle: (ctx) =>
      seated(ctx, ctx.url.searchParams.get("principalId"), async (owner) => ({
        steps: await Promise.all((await ctx.deps.seat!.pending(owner)).map((step) => titled(ctx, step))),
      })),
  },
  {
    method: "GET",
    path: "/v1/seat/steps/:id",
    browser: "self",
    auth: "source",
    actor: "query.principalId",
    handle: (ctx) =>
      seated(ctx, ctx.url.searchParams.get("principalId"), async (owner) => {
        const step = await ctx.deps.seat!.step(owner, ctx.params.id!);
        if (!step) throw new SeatError("step_closed", "This step is no longer waiting for a move.");
        return { step: await titled(ctx, step) };
      }),
  },
  {
    method: "POST",
    path: "/v1/seat/steps/:id/move",
    browser: "self",
    auth: "source",
    actor: "body.principalId",
    maxBodyBytes: 2_000_000,
    handle: (ctx) =>
      seated(ctx, bodyPrincipal(ctx), async (owner) => {
        await ctx.deps.seat!.move(owner, ctx.params.id!, isObj(ctx.body) ? ctx.body.content : undefined);
        return { ok: true };
      }),
  },
  {
    method: "POST",
    path: "/v1/seat/steps/:id/ask",
    browser: "self",
    auth: "source",
    actor: "body.principalId",
    handle: (ctx) => {
      const controller = new AbortController();
      ctx.res.once("close", () => controller.abort());
      return seated(ctx, bodyPrincipal(ctx), (owner) => ctx.deps.seat!.ask(owner, ctx.params.id!, controller.signal));
    },
  },
];
