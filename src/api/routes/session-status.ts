import { runFailed, type Run } from "../../runs/run-store.ts";
import { sessionTreeWorking } from "../../sessions/session-syscalls.ts";
import { bearerMatches, sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

type SessionState = "accepted" | "running" | "idle" | "failed";

const MAX_KEY_LENGTH = 512;

function settledState(run: Run | null, deliveryFailed: boolean): SessionState {
  if (!run) return deliveryFailed ? "failed" : "accepted";
  return runFailed(run) ? "failed" : "idle";
}

async function sessionStatus(ctx: BaseCtx): Promise<void> {
  const { req, res, deps, url } = ctx;
  const token = deps.sessionStatusToken;
  if (!token) return sendJson(res, 404, { error: "not_found" });
  if (!bearerMatches(req, token)) return sendJson(res, 401, { error: "unauthorized" });
  const { sessions, runs, webhookReceiver } = deps;
  if (!sessions || !runs || !webhookReceiver) return sendJson(res, 503, { error: "session_status_unavailable" });
  const key = url.searchParams.get("session") ?? "";
  if (!key || key.length > MAX_KEY_LENGTH)
    return sendJson(res, 400, { error: "bad_request", message: "session must be a sessionRef or sessionId" });
  const session = (await sessions.getByThread(key)) ?? (await sessions.get(key));
  if (session && session.surface !== "webhook") return sendJson(res, 404, { error: "not_found" });
  const delivery = session ? null : await webhookReceiver.delivery(key);
  if (!session && !delivery) return sendJson(res, 404, { error: "not_found" });
  const sessionRef = session?.threadRef ?? key;
  const [run, working] = await Promise.all([
    runs.latestForThread(sessionRef, { excludePrivateMessages: true }),
    session ? sessionTreeWorking(sessions, runs, session) : runs.activeForThread(sessionRef).then(Boolean),
  ]);
  sendJson(res, 200, {
    sessionRef,
    sessionId: session?.id ?? null,
    state: working ? "running" : settledState(run, delivery?.failed === true),
    outcome: run?.result?.status ?? null,
    runId: run?.id ?? null,
    queuedAt: run?.createdAt ?? null,
    startedAt: run?.startedAt ?? null,
    finishedAt: run?.finishedAt ?? null,
  });
}

export const sessionStatusRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/v1/session-status", auth: "public", handle: sessionStatus },
];
