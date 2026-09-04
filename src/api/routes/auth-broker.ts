import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

const NAMESPACE = "authbroker:";
const MAX_IDS = 64;
const MAX_ID_LENGTH = 200;
const MAX_HORIZON_MS = 24 * 60 * 60 * 1000;

async function claimBrokerNonce(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  if (!deps.replayDedupe?.durable) {
    return sendJson(res, 503, {
      error: "not_configured",
      message:
        "single-use claims need the Postgres-backed replay store; set DATABASE_URL so a restart cannot resurrect a spent sign-in link",
    });
  }
  const b = isObj(body) ? body : {};
  const ids: unknown[] = Array.isArray(b.ids) ? b.ids : [];
  if (
    ids.length === 0 ||
    ids.length > MAX_IDS ||
    !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH)
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `ids must hold 1 to ${MAX_IDS} non-empty strings of at most ${MAX_ID_LENGTH} characters`,
    });
  }
  const now = Date.now();
  const expiresAtMs = b.expiresAtMs;
  if (
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now ||
    expiresAtMs > now + MAX_HORIZON_MS
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "expiresAtMs must be a future epoch-millisecond timestamp within 24 hours",
    });
  }
  for (const id of ids as string[]) {
    if (await deps.replayDedupe.claim(`${NAMESPACE}${id}`, expiresAtMs)) return sendJson(res, 200, { claimed: id });
  }
  return sendJson(res, 200, { claimed: null });
}

export const authBrokerRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/auth/broker/claim", auth: "source", handle: claimBrokerNonce },
];
