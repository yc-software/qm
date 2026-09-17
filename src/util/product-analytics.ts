export function createProductAnalytics(
  companyId: string,
  config: { apiKey?: string; host?: string } = {},
  send: typeof fetch = fetch,
): { appPublished(principal: string, deploymentId: string, version: number): Promise<void> } {
  const apiKey = config.apiKey?.trim();
  const host = (config.host?.trim() || "https://us.i.posthog.com").replace(/\/$/, "");
  let inFlight = 0;
  return {
    async appPublished(principal, deploymentId, version) {
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
            event: "app_published",
            timestamp: new Date().toISOString(),
            properties: {
              distinct_id: JSON.stringify([companyId, principal]),
              company_id: companyId,
              $groups: { company: companyId },
              $insert_id: `${deploymentId}:${version}:app_published`,
              $geoip_disable: true,
              surface: "core",
            },
          }),
        });
        await response.body?.cancel();
      } catch {
        return;
      } finally {
        inFlight--;
      }
    },
  };
}
