import { WebClient } from "@slack/web-api";
import type { SlackInstallationStore } from "../surfaces/slack-installation.ts";
import { claimAcrossTenants } from "../tenants/claim.ts";
import { withTenant } from "../tenants/context.ts";
import { NO_RETRY, normalizeSlackApiUrl, slackPluginConfigFromEnv } from "./config.ts";

export type SlackWorkspaceOf = (botToken: string) => Promise<{ teamId?: string; teamName?: string }>;

export function slackWorkspaceOf(env: Record<string, string | undefined>): SlackWorkspaceOf {
  return async (botToken) => {
    const auth = await new WebClient(botToken, {
      ...NO_RETRY,
      ...(env.SLACK_API_URL ? { slackApiUrl: normalizeSlackApiUrl(env.SLACK_API_URL) } : {}),
    }).auth.test();
    return {
      ...(auth.team_id ? { teamId: auth.team_id } : {}),
      ...(typeof auth.team === "string" && auth.team ? { teamName: auth.team } : {}),
    };
  };
}

export async function adoptEnvironmentSlack(opts: {
  env: Record<string, string | undefined>;
  installation: SlackInstallationStore;
  workspaceOf: SlackWorkspaceOf;
}): Promise<string | null> {
  const environment = slackPluginConfigFromEnv(opts.env);
  if (!environment) return null;
  const [presence] = (await claimAcrossTenants("SELECT to_regclass('qm_tenant') IS NOT NULL AS present")).rows;
  if (!presence?.present) return null;
  const [original] = (await claimAcrossTenants("SELECT id::text AS id FROM qm_tenant")).rows;
  if (!original) return null;
  if ((await claimAcrossTenants("SELECT 1 FROM slack_installation LIMIT 1")).rowCount) return null;
  const { teamId, teamName } = await opts.workspaceOf(environment.botToken);
  if (!teamId) throw new Error("The Slack bot token in the environment names no workspace");
  const tenant = String(original.id);
  await withTenant(tenant, () =>
    opts.installation.set({
      botToken: environment.botToken,
      ...(environment.appToken ? { appToken: environment.appToken } : {}),
      teamId,
      ...(teamName ? { teamName } : {}),
      updatedBy: "environment",
    }),
  );
  return tenant;
}
