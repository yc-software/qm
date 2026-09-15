export function slackHistoryRateLimitMessage(
  error: unknown,
  opts: { setupUrl?: string; managed?: boolean } = {},
): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; retryAfter?: unknown; data?: { error?: unknown } };
  if (value.code !== "slack_webapi_rate_limited_error" && value.data?.error !== "ratelimited") return undefined;
  const seconds = Number(value.retryAfter);
  const retry =
    Number.isFinite(seconds) && seconds > 0 ? ` Retry after ${Math.ceil(seconds)} seconds.` : " Try again shortly.";
  const message = `Slack is temporarily limiting history reads for this workspace. Earlier context may be incomplete.${retry}`;
  if (!opts.managed) return message;
  let setupUrl: string | undefined;
  try {
    const url = new URL(opts.setupUrl ?? "");
    if (url.protocol === "https:" && !url.username && !url.password) setupUrl = url.href;
  } catch {
    setupUrl = undefined;
  }
  const setup = setupUrl
    ? `[set up a workspace-owned Slack app](${setupUrl})`
    : "set up a workspace-owned Slack app in QM's Slack settings";
  return `${message} A workspace admin can ${setup} for this company. Keep using the available context; do not repeatedly retry the history request.`;
}
