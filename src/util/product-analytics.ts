import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { Run } from "../runs/run-store.ts";

export function createProductAnalytics(
  companyId: string,
  config: { apiKey?: string; host?: string } = {},
  send: typeof fetch = fetch,
): {
  appPublished(principal: string, deploymentId: string, version: number): Promise<void>;
  responseFinished(run: Run): Promise<void>;
} {
  const apiKey = config.apiKey?.trim();
  const host = (config.host?.trim() || "https://us.i.posthog.com").replace(/\/$/, "");
  let inFlight = 0;
  async function capture(
    event: string,
    principal: string,
    insertId: string,
    properties: Record<string, string> = {},
  ): Promise<void> {
    if (!apiKey || !companyId || !principal || inFlight >= 16) return;
    inFlight++;
    try {
      const response = await send(`${host}/i/v0/e/`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          event,
          timestamp: new Date().toISOString(),
          properties: {
            distinct_id: JSON.stringify([companyId, principal]),
            company_id: companyId,
            $groups: { company: companyId },
            $insert_id: insertId,
            $geoip_disable: true,
            surface: "core",
            ...properties,
          },
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
        resolveTurnOrigin(run.request).kind !== "human" ||
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
