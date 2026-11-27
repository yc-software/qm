import { FORWARD_OAUTH_HEADERS, FORWARD_WEBHOOK_HEADERS } from "./proxy.ts";

export interface PublicPassthroughMatch {
  readonly headers: readonly string[];
  readonly forwardSearch: boolean;
}

const MANAGED_SLACK_HEADERS = ["authorization", "content-type"] as const;

const GENERIC_CHAT_HEADERS = [
  "content-type",
  "content-length",
  "x-agent-app-request-timestamp",
  "x-agent-app-signature",
] as const;

const SLACK_EVENT_HEADERS = [
  ...FORWARD_WEBHOOK_HEADERS,
  "content-length",
  "x-slack-retry-num",
  "x-slack-retry-reason",
] as const;

const EXPORT_HEADERS = ["authorization", "accept"] as const;
const WEBHOOK_HEADERS = [...FORWARD_WEBHOOK_HEADERS, "authorization"] as const;

export function matchPublicPassthrough(method: string, pathname: string): PublicPassthroughMatch | null {
  if (
    (pathname === "/v1/slack/managed/installation" && (method === "POST" || method === "DELETE")) ||
    (pathname === "/v1/slack/managed/events" && method === "POST")
  ) {
    return { headers: MANAGED_SLACK_HEADERS, forwardSearch: false };
  }
  if (pathname === "/v1/surfaces/generic-chat/events" && method === "POST") {
    return { headers: GENERIC_CHAT_HEADERS, forwardSearch: false };
  }
  if (method === "POST" && (pathname === "/slack/events" || /^\/slack\/events\/app\/[^/]+$/.test(pathname))) {
    return { headers: SLACK_EVENT_HEADERS, forwardSearch: true };
  }
  if (method === "GET" && (pathname === "/v1/spend/export" || pathname === "/v1/apps/export")) {
    return { headers: EXPORT_HEADERS, forwardSearch: true };
  }
  if (
    method === "POST" &&
    (/^\/v1\/webhooks\/incoming\/[^/]+$/.test(pathname) || /^\/v1\/loop-ingress\/[^/]+$/.test(pathname))
  ) {
    return { headers: WEBHOOK_HEADERS, forwardSearch: true };
  }
  if (
    method === "GET" &&
    (/^\/v1\/connectors\/oauth\/[^/]+\/callback$/.test(pathname) || pathname === "/v1/slack/oauth/callback")
  ) {
    return { headers: FORWARD_OAUTH_HEADERS, forwardSearch: true };
  }
  return null;
}
