import { isSessionTurn } from "../core/turn-origin.ts";
import type { Run } from "../runs/run-store.ts";

export function createProductAnalytics(
  companyId: string,
  config: { url?: string; token?: string } = {},
  send: typeof fetch = fetch,
): {
  appPublished(principal: string, deploymentId: string, version: number): Promise<void>;
  responseFinished(run: Run): Promise<void>;
} {
  const { url, token } = config;
  let inFlight = 0;
  async function capture(
    event: string,
    principal: string,
    insertId: string,
    properties: Record<string, string> = {},
  ): Promise<void> {
    if (!url || !companyId || !principal || inFlight >= 16) return;
    inFlight++;
    try {
      const response = await send(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          event,
          timestamp: new Date().toISOString(),
          company: companyId,
          principal,
          insert_id: insertId,
          properties: { surface: "core", ...properties },
        }),
      });
      await response.body?.cancel();
    } catch {
      return;
    } finally {
      inFlight--;
    }
  }
  return {
    appPublished: (principal, deploymentId, version) =>
      capture("app_published", principal, `${deploymentId}:${version}:app_published`),
    async responseFinished(run) {
      if (
        run.request.origin.kind !== "human" ||
        isSessionTurn(run.request) ||
        run.request.botActor ||
        run.request.analyticsSuppressed ||
        run.request.proactiveOpener ||
        run.result?.stopped ||
        (run.status !== "done" && run.status !== "failed")
      )
        return;
      const status = run.result?.status;
      let event: string | undefined;
      if (run.status === "failed" || status === "failed") event = "response_failed";
      else if (status === "ok" || status === "silent" || status === "react") event = "response_completed";
      if (!event) return;
      await capture(event, run.request.actor.id, `${companyId}:${run.id}:${event}`, {
        surface: run.request.surface === "web" || run.request.surface === "slack" ? run.request.surface : "core",
        completion_boundary: "run",
        result_status: status ?? "failed",
      });
    },
  };
}
