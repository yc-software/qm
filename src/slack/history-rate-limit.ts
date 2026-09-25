export const SHARED_SLACK_HISTORY_LIMIT = 15;

export function slackHistoryRateLimitMessage(
  error: unknown,
  opts: { setupUrl?: string; managed?: boolean; format?: "slack" } = {},
): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; retryAfter?: unknown; data?: { error?: unknown } };
  if (value.code !== "slack_webapi_rate_limited_error" && value.data?.error !== "ratelimited") return undefined;
  const seconds = Number(value.retryAfter);
  const retry = Number.isFinite(seconds) && seconds > 0 ? `in ${Math.ceil(seconds)} seconds` : "shortly";
  const message = `Slack is temporarily limiting history reads, so I may be missing earlier context. Try again ${retry}`;
  if (!opts.managed) return opts.format === "slack" ? undefined : `${message}.`;
  let setupUrl: string | undefined;
  try {
    const url = new URL(opts.setupUrl ?? "");
    if (url.protocol === "https:" && !url.username && !url.password) setupUrl = url.href;
  } catch {
    setupUrl = undefined;
  }
  if (!setupUrl) return opts.format === "slack" ? undefined : `${message}.`;
  const setup =
    opts.format === "slack"
      ? `<${setupUrl.replace(/&/g, "&amp;").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\|/g, "%7C")}|set up your own Slack app>`
      : `[set up your own Slack app](${setupUrl})`;
  return `${message}, or ${setup}.`;
}
