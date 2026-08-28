import { existsSync, readFileSync } from "node:fs";
import type { QmConfig } from "./config.ts";

function template(name: string): string {
  const source = new URL(`../templates/${name}`, import.meta.url);
  const packaged = new URL(`../../templates/${name}`, import.meta.url);
  return readFileSync(existsSync(source) ? source : packaged, "utf8");
}

function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const scalar = (item: unknown): string => {
    if (typeof item !== "string") return String(item);
    const plain = /^[A-Za-z0-9][A-Za-z0-9 _:./-]*$/.test(item) && !item.includes(": ") && !item.endsWith(" ");
    return plain ? item : JSON.stringify(item);
  };
  if (Array.isArray(value)) return value.map((item) => `${pad}- ${scalar(item)}`).join("\n");
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(([key, item]) =>
        typeof item === "object" && item !== null
          ? `${pad}${key}:\n${toYaml(item, indent + 1)}`
          : `${pad}${key}: ${scalar(item)}`,
      )
      .join("\n");
  }
  return `${pad}${scalar(value)}`;
}

export interface SlackManifests {
  bot: string;
  sso: string;
}

function isSlackHost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname;
    return host === "slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
  }
}

export function usesSlackOidc(config: QmConfig): boolean {
  const portal = config.env.portal ?? {};
  return ["OIDC_AUTH_ENDPOINT", "OIDC_TOKEN_ENDPOINT", "OIDC_USERINFO_ENDPOINT", "OIDC_ISSUER"].some((name) =>
    isSlackHost(portal[name]),
  );
}

export function renderSlackManifests(config: QmConfig): SlackManifests {
  const name = config.botName ?? "qm";
  const bot = JSON.parse(template("slack-manifest.json")) as {
    display_information: { name: string; description: string; background_color: string };
    features: { bot_user: { display_name: string }; agent_view: { agent_description: string } };
  };
  const slackEnv = config.env?.slack ?? {};
  const background = slackEnv.SLACK_BACKGROUND_COLOR?.trim();
  if (background && !/^#[0-9a-f]{6}$/i.test(background)) {
    throw new Error("env.slack.SLACK_BACKGROUND_COLOR must be a six-digit hex color");
  }
  bot.display_information.name = name;
  const description = slackEnv.SLACK_APP_DESCRIPTION?.trim() || `${name} workspace agent for ${config.orgId}`;
  if (description.length > 140) throw new Error("env.slack.SLACK_APP_DESCRIPTION must be at most 140 characters");
  bot.display_information.description = description;
  if (background) bot.display_information.background_color = background;
  bot.features.bot_user.display_name = name;
  const agentDescription = slackEnv.SLACK_AGENT_DESCRIPTION?.trim();
  if (agentDescription && agentDescription.length > 300) {
    throw new Error("env.slack.SLACK_AGENT_DESCRIPTION must be at most 300 characters");
  }
  if (agentDescription) bot.features.agent_view.agent_description = agentDescription;

  const sso = JSON.parse(template("slack-sso-manifest.json")) as {
    display_information: { name: string; description: string };
    oauth_config: { redirect_urls: string[] };
  };
  sso.display_information.name = `${name} SSO`;
  sso.display_information.description = `Sign in to your ${name} deployment with Slack`;
  sso.oauth_config.redirect_urls = [`${config.publicUrl.replace(/\/$/, "")}/auth/callback`];

  return {
    bot: `${toYaml(bot)}\n`,
    sso: `${toYaml(sso)}\n`,
  };
}

export function slackManifestCreationUrl(manifest: string): string {
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_yaml", manifest);
  return url.toString();
}
