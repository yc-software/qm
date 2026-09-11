import { CoordinationError } from "../../coordination/types.ts";
import { ownPeerSession, peerActor, peerRoute, peerRunFence } from "./peers.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

function board(ctx: ApiCtx) {
  if (!ctx.deps.peerBoard) throw new CoordinationError(404, "coordination_disabled", "coordination is disabled");
  return ctx.deps.peerBoard;
}

function inspection(ctx: ApiCtx) {
  return ctx.deps.peerInspection?.board ?? board(ctx);
}

export const peerMessageRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: "/v1/peer-messages",
    auth: "either",
    handle: peerRoute(
      async (ctx) => {
        const query = ctx.url.searchParams;
        return inspection(ctx).list({
          after: query.has("after") ? Number(query.get("after")) : undefined,
          limit: query.has("limit") ? Number(query.get("limit")) : undefined,
          senderId: query.get("senderId") ?? undefined,
          recipientId: query.get("recipientId") ?? undefined,
          threadId: query.get("threadId") ?? undefined,
          text: query.get("text") ?? undefined,
        });
      },
      { inspection: true },
    ),
  },
  {
    method: "GET",
    path: "/v1/peer-messages/:id",
    auth: "either",
    handle: peerRoute(
      async (ctx) => {
        const { message, deliveries } = await inspection(ctx).get(ctx.params.id!);
        const actor = await peerActor(ctx);
        const safeReasons = new Set([
          "recipient_unavailable",
          "execution_authority_unavailable",
          "recipient_inactive",
          "execution_authority_revoked",
          "recipient_awaiting_approval",
          "recipient_admission_refused",
          "dispatch_retry_pending",
        ]);
        return {
          message,
          deliveries: await Promise.all(
            deliveries.map(
              async ({ id, messageId, recipientId, state, attempts, createdAt, updatedAt, reason, runId }) => {
                const visible = await ctx.app.getSessionForViewer(recipientId, actor);
                const publicReason = reason && safeReasons.has(reason) ? reason : "delivery_unavailable";
                return {
                  id,
                  messageId,
                  recipientId,
                  state,
                  attempts,
                  createdAt,
                  updatedAt,
                  reason: reason ? publicReason : null,
                  ...(visible
                    ? {
                        sessionId: recipientId,
                        runId,
                        runStatus: runId ? ((await ctx.deps.runs?.get(runId))?.status ?? null) : null,
                      }
                    : {}),
                };
              },
            ),
          ),
        };
      },
      { inspection: true },
    ),
  },
  {
    method: "POST",
    path: "/v1/peer-messages/preview",
    auth: "either",
    handle: peerRoute(
      async (ctx) => {
        if (!isObj(ctx.body) || typeof ctx.body.audience !== "string")
          throw new CoordinationError(400, "bad_request", "provide an audience expression");
        return inspection(ctx).preview(ctx.body.audience);
      },
      { inspection: true },
    ),
  },
  {
    method: "POST",
    path: "/v1/peer-messages",
    auth: "either",
    handle: peerRoute(async (ctx) => {
      const senderId = await ownPeerSession(ctx);
      const body = isObj(ctx.body) ? ctx.body : {};
      if (
        typeof body.text !== "string" ||
        typeof body.audience !== "string" ||
        typeof body.idempotencyKey !== "string" ||
        (body.replyTo !== undefined && typeof body.replyTo !== "string")
      )
        throw new CoordinationError(
          400,
          "bad_request",
          "provide text, audience, idempotencyKey, and optionally replyTo",
        );
      return {
        message: await board(ctx).publish(
          {
            senderId,
            senderRunId: ctx.capability!.runId!,
            text: body.text,
            audience: body.audience,
            idempotencyKey: body.idempotencyKey,
            replyTo: body.replyTo as string | undefined,
          },
          peerRunFence(ctx, senderId),
        ),
      };
    }),
  },
];
