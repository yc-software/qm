import { WebClient } from "@slack/web-api";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { SlackInstallationStore } from "../surfaces/slack-installation.ts";
import { currentTenant } from "../tenants/context.ts";
import type { TenantResolver } from "../tenants/resolver.ts";
import {
  NO_RETRY,
  normalizeSlackApiUrl,
  slackAccountConfigsFromEnv,
  slackInstallationConfig,
  slackPluginConfigFromEnv,
} from "./config.ts";
import { ENVELOPE_REPLAY } from "./envelope-staging.ts";
import { startSlackPlugin } from "./index.ts";
import {
  claimStagedEnvelopes,
  installedSlackTenants,
  tenantsWithSessionStatus,
  tenantsWithUnsettledAcks,
  type SlackTables,
} from "./slack-tables.ts";
import { createSlackTenants } from "./tenant-runtimes.ts";

export function createSlackRuntime(opts: {
  env: Record<string, string | undefined>;
  core: SlackCoreClient;
  tables: SlackTables;
  installation: SlackInstallationStore;
  resolver: TenantResolver;
  managed: boolean;
}) {
  const { env, installation, resolver, tables } = opts;
  const environment = slackPluginConfigFromEnv(env);
  const extraAccounts = slackAccountConfigsFromEnv(env);
  const witness = environment ?? extraAccounts[0];
  const teams = new Map<string, Promise<string | undefined>>();
  const teamOf = (token: string): Promise<string | undefined> => {
    let team = teams.get(token);
    if (!team) {
      team = new WebClient(token, {
        ...NO_RETRY,
        ...(env.SLACK_API_URL ? { slackApiUrl: normalizeSlackApiUrl(env.SLACK_API_URL) } : {}),
      }).auth
        .test()
        .then((auth) => auth.team_id || undefined);
      teams.set(token, team);
      void team.catch(() => teams.delete(token));
    }
    return team;
  };
  const tenantOfEnvironment = async (): Promise<string | null> => {
    const team = witness ? await teamOf(witness.botToken) : undefined;
    return team ? resolver.forSlackTeam(team) : null;
  };
  const workspaceToken = async (token: string | undefined, teamId: string | undefined) =>
    token && teamId && (await teamOf(token).catch(() => undefined)) === teamId ? token : undefined;
  return createSlackTenants({
    core: opts.core,
    claims: {
      async installedTenants() {
        const environmentOwner = await tenantOfEnvironment().catch(() => null);
        const installed = (await installedSlackTenants(tables.pool)).map((row) => row.tenant_id);
        return environmentOwner ? [...installed, environmentOwner] : installed;
      },
      dueEnvelopes: (accounts) => claimStagedEnvelopes(tables.pool, { now: Date.now(), ...ENVELOPE_REPLAY, accounts }),
      statusAccounts: () => tenantsWithSessionStatus(tables.pool),
      ackTenants: () => tenantsWithUnsettledAcks(tables.pool),
    },
    async load() {
      const owned = (await tenantOfEnvironment().catch(() => null)) === currentTenant();
      const stored = await installation.get();
      const own =
        stored && (!stored.installId || opts.managed)
          ? slackInstallationConfig(env, stored, {
              userToken: await workspaceToken(env.SLACK_USER_TOKEN, stored.teamId),
              copilotBotToken: await workspaceToken(env.SLACK_COPILOT_BOT_TOKEN, stored.teamId),
            })
          : null;
      const fromEnvironment = !stored && owned && !(await installation.status()).managed ? environment : null;
      const main = own ?? fromEnvironment;
      const accounts = [...(main ? [main] : []), ...(owned ? extraAccounts : [])];
      if (!accounts.length) return null;
      return { version: stored?.version ?? "environment", accounts };
    },
    start: (config) => startSlackPlugin(config, opts.core, resolver),
  });
}
