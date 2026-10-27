import { isNamedSurface } from "../surfaces/surface.ts";
import { isSessionTurn } from "../core/turn-origin.ts";
import type { Run } from "../runs/run-store.ts";
import { swallow } from "./errors.ts";

export function createProductAnalytics(
  companyId: () => string,
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
    const company = companyId();
    if (!apiKey || !company || !principal || inFlight >= 16) return;
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
            distinct_id: JSON.stringify([company, principal]),
            company_id: company,
            $groups: { company },
            $insert_id: insertId,
            $geoip_disable: true,
            surface: "core",
            ...properties,
          },
        }),
      });
      await response.body?.cancel();
      if (!response.ok) swallow(`product analytics: ${event} capture`, new Error(`HTTP ${response.status}`));
    } catch (e) {
      swallow(`product analytics: ${event} capture`, e);
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
      await capture(event, run.request.actor.id, `${companyId()}:${run.id}:${event}`, {
        surface: isNamedSurface(run.request.surface) ? run.request.surface : "core",
        completion_boundary: "run",
        result_status: status ?? "failed",
      });
    },
  };
}
