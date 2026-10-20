import { WebClient, type WebClientOptions } from "@slack/web-api";

export type SlackWebClientFactory = (token: string, options: WebClientOptions) => Pick<WebClient, "apiCall">;

export function slackWebClient(
  token: string,
  factory: SlackWebClientFactory = (token, options) => new WebClient(token, options),
  timeout = 20_000,
) {
  return factory(token, {
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    attachOriginalToWebAPIRequestError: false,
    timeout,
  });
}
