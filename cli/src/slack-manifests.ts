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
  const bot = JSON.parse(template("slack-manifest.json")) as {
    display_information: { name: string; description: string };
    features: { bot_user: { display_name: string } };
  };
  bot.display_information.name = "qm";
  bot.display_information.description = `qm workspace agent for ${config.orgId}`;
  bot.features.bot_user.display_name = "qm";

  const sso = JSON.parse(template("slack-sso-manifest.json")) as {
    oauth_config: { redirect_urls: string[] };
  };
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
