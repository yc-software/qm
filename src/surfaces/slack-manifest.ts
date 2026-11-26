import { readFileSync } from "node:fs";

interface SlackBotManifestTemplate {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string } };
  oauth_config?: {
    redirect_urls?: string[];
    scopes?: { bot?: string[] };
  };
  settings?: {
    event_subscriptions?: { request_url?: string; bot_events?: string[] };
    interactivity?: { is_enabled?: boolean; request_url?: string };
    org_deploy_enabled?: boolean;
    socket_mode_enabled?: boolean;
  };
}

let template: string | undefined;

function loadTemplate(): SlackBotManifestTemplate {
  template ??= readFileSync(new URL("../../cli/templates/slack-manifest.json", import.meta.url), "utf8");
  return JSON.parse(template) as SlackBotManifestTemplate;
}

export function buildSlackAppManifest(opts: {
  name?: string;
  description?: string;
  eventsUrl?: string;
  redirectUrl?: string;
  orgDeploy?: boolean;
}): Record<string, unknown> {
  const manifest = loadTemplate();
  const label = [...(opts.name?.trim() || "qm")].slice(0, 35).join("");
  const desc = [...(opts.description?.trim() || `${label} workspace agent`)].slice(0, 140).join("");
  manifest.display_information.name = label;
  manifest.display_information.description = desc;
  manifest.features.bot_user.display_name = label;
  if (opts.eventsUrl) {
    manifest.settings = {
      ...manifest.settings,
      socket_mode_enabled: false,
      org_deploy_enabled: Boolean(opts.orgDeploy),
      event_subscriptions: {
        ...manifest.settings?.event_subscriptions,
        request_url: opts.eventsUrl,
      },
      interactivity: {
        ...manifest.settings?.interactivity,
        is_enabled: true,
        request_url: opts.eventsUrl,
      },
    };
  }
  if (opts.redirectUrl) {
    manifest.oauth_config = {
      ...manifest.oauth_config,
      redirect_urls: [opts.redirectUrl],
    };
  }
  return manifest as unknown as Record<string, unknown>;
}

export function slackBotManifestCreationUrl(name?: string): string {
  const manifest = buildSlackAppManifest({ name });
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_json", JSON.stringify(manifest));
  return url.toString();
}

export function slackOAuthAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const scopes = loadTemplate().oauth_config?.scopes?.bot ?? [];
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}
