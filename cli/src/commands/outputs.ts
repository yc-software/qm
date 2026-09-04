import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QmConfig } from "../config.ts";
import { hostingProvider } from "../backends/registry.ts";
import { CliError, note, ok } from "../log.ts";
import { renderSlackManifests, slackManifestCreationUrl, usesSlackOidc } from "../slack-manifests.ts";

export interface DeploymentOutputs {
  provider: QmConfig["target"];
  providerAccountOrOrganization?: string;
  region?: string;
  webUiUrl: string;
  adminOnboardingUrl: string;
  adminConnectorsUrl: string;
  userConnectionsUrl: string;
  healthUrl: string;
  slack: {
    bot: { manifest: string; createUrl: string };
    sso?: { manifest: string; createUrl: string; signInUrl: string; redirectUrl: string };
  };
}

function manifestPath(configDir: string, name: "slack-app-manifest.yml" | "slack-sso-manifest.yml"): string {
  const path = join(configDir, name);
  if (!existsSync(path)) throw new CliError(`${name} is missing; run \`qm slack render\``);
  return path;
}

export function deploymentOutputs(config: QmConfig, configDir: string): DeploymentOutputs {
  if (
    !config.services.includes("slack") ||
    !config.services.includes("portal") ||
    !config.services.includes("web-ui") ||
    !config.services.includes("admin")
  ) {
    throw new CliError("outputs requires the slack, web-ui, admin, and portal services");
  }
  const botPath = manifestPath(configDir, "slack-app-manifest.yml");
  const bot = readFileSync(botPath, "utf8");
  const expected = renderSlackManifests(config);
  if (bot !== expected.bot) {
    throw new CliError(`Slack manifests do not match the current configuration; run \`qm slack render\``);
  }
  const slackSso = usesSlackOidc(config);
  const ssoPath = slackSso ? manifestPath(configDir, "slack-sso-manifest.yml") : undefined;
  const sso = ssoPath ? readFileSync(ssoPath, "utf8") : undefined;
  if (sso !== undefined && sso !== expected.sso) {
    throw new CliError(`Slack manifests do not match the current configuration; run \`qm slack render\``);
  }
  const base = config.publicUrl.replace(/\/$/, "");
  const redirectUrl = `${base}/auth/callback`;
  const coordinates = hostingProvider(config.target).coordinates(config);
  return {
    provider: config.target,
    ...(coordinates.accountOrOrganization ? { providerAccountOrOrganization: coordinates.accountOrOrganization } : {}),
    ...(coordinates.region ? { region: coordinates.region } : {}),
    webUiUrl: base,
    adminOnboardingUrl: `${base}/admin/onboarding`,
    adminConnectorsUrl: `${base}/admin/connectors`,
    userConnectionsUrl: `${base}/keychain`,
    healthUrl: `${base}/healthz`,
    slack: {
      bot: { manifest: botPath, createUrl: slackManifestCreationUrl(bot) },
      ...(ssoPath && sso
        ? {
            sso: {
              manifest: ssoPath,
              createUrl: slackManifestCreationUrl(sso),
              signInUrl: `${base}/auth/login`,
              redirectUrl,
            },
          }
        : {}),
    },
  };
}

export function runOutputs(config: QmConfig, configDir: string, json: boolean): void {
  const output = deploymentOutputs(config, configDir);
  if (json) {
    note(JSON.stringify(output));
    return;
  }
  note(
    `Provider: ${output.provider}${output.providerAccountOrOrganization ? ` (${output.providerAccountOrOrganization}${output.region ? `, ${output.region}` : ""})` : ""}`,
  );
  note(`Web UI: ${output.webUiUrl}`);
  note(`Admin onboarding: ${output.adminOnboardingUrl}`);
  note(`Admin connector setup: ${output.adminConnectorsUrl}`);
  note(`User connections: ${output.userConnectionsUrl}`);
  note(`Health check: ${output.healthUrl}`);
  note(`qm Slack app: ${output.slack.bot.createUrl}`);
  if (output.slack.sso) {
    note(`qm SSO app: ${output.slack.sso.createUrl}`);
    note(`Slack sign-in: ${output.slack.sso.signInUrl}`);
    note(`Slack SSO callback: ${output.slack.sso.redirectUrl}`);
  }
}

export function renderSlackFiles(config: QmConfig, configDir: string): void {
  const manifests = renderSlackManifests(config);
  const ssoPath = join(configDir, "slack-sso-manifest.yml");
  writeFileSync(join(configDir, "slack-app-manifest.yml"), manifests.bot);
  if (usesSlackOidc(config)) {
    writeFileSync(ssoPath, manifests.sso);
    ok("rendered Slack bot and SSO app manifests");
  } else {
    if (existsSync(ssoPath)) unlinkSync(ssoPath);
    ok("rendered Slack bot app manifest");
  }
}
