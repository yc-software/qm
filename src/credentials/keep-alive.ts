import type { DurableMap } from "../persistence/durable-map.ts";
import type { CronStore } from "../cron/cron-store.ts";
import { claimManagedCron, nightlyAt, type ManagedCronClaim } from "../cron/managed.ts";
import type { Scheduler } from "../cron/scheduler.ts";
import { DEFAULT_CRON_TIMEZONE } from "../cron/schedule.ts";
import { reportFailure } from "../util/errors.ts";
import { personalScope } from "../types.ts";
import type { Cron } from "../triggers/types.ts";
import type { Keychain } from "./keychain.ts";

const KEEP_ALIVE_TASK = `Keep this person's saved logins working, so their live turns and scheduled tasks never find one dead. Their connected accounts are refreshed before each scheduled run (not a manual run now); GET /v1/keychain/credentials lists those with needsReconnect and refreshError, and their saved logins with each one's last check (never secret values).
- Saved CLI logins (kind "file"): run each one's own read-only identity or status command with only that handle, such as \`aws sts get-caller-identity\` for each profile in its config or \`gh auth status\`. This run saves refreshed tokens only into \`.aws/sso/cache/\`, so skip a login whose check would refresh tokens anywhere else: its new refresh token would be lost and the login broken. Skip browser profiles, other saved files with no status command, and API keys. Record each result with POST /v1/keychain/credentials/:id/check {ok, detail}, where detail is a short reason when it fails.
Never start a sign-in or change a login yourself. If something that worked at its last check now fails, or something dead works again, tell this person once and briefly: what stopped working and since when, which of their enabled scheduled tasks likely use it (the cron tool lists them), and how to fix it (reconnect a connected account on the Keychain page; sign in to a saved login again in a conversation with you). Leave a one-line note of what is dead for the next run. If nothing changed, end with finish_silently.`;

export type LoginKeepAliveProfile = ManagedCronClaim;

export function createLoginKeepAliveService(deps: {
  store: DurableMap<LoginKeepAliveProfile>;
  keychain: Pick<Keychain, "listByOwner" | "listConnectorsByOwners" | "connectorAccessToken">;
  timezone: (principalId: string) => Promise<string | undefined>;
  crons: CronStore;
  scheduler: Pick<Scheduler, "notifyChanged">;
}) {
  const manages = async (cron: Pick<Cron, "id" | "ownerScopeId">): Promise<boolean> =>
    (await deps.store.get(cron.ownerScopeId))?.cronId === cron.id;
  return {
    manages,

    async ensure(ownerId: string): Promise<void> {
      const scope = personalScope(ownerId);
      const claimed = await deps.store.get(scope);
      if (claimed?.cronId && !claimed.arming) return;
      await claimManagedCron(
        deps,
        scope,
        {},
        {
          owner: ownerId,
          createdBy: ownerId,
          ownerScopeId: scope,
          title: "Keep logins alive",
          schedule: {
            cron: nightlyAt(scope, 4),
            timezone: (await deps.timezone(ownerId)) || DEFAULT_CRON_TIMEZONE,
          },
          action: KEEP_ALIVE_TASK,
        },
      );
    },

    async skipFire(cron: Cron): Promise<string | undefined> {
      if (!(await manages(cron))) return undefined;
      const connectorsOf = async () => (await deps.keychain.listConnectorsByOwners([cron.owner])).get(cron.owner) ?? [];
      for (const c of await connectorsOf())
        await deps.keychain
          .connectorAccessToken(c.host, cron.owner, c.accountType)
          .catch((e: unknown) => reportFailure(`login keep-alive: refresh ${c.host} for ${cron.owner}`, e));
      const logins = (await deps.keychain.listByOwner(cron.owner)).filter((c) => c.kind === "file");
      const dead = (await connectorsOf()).filter((c) => c.needsReconnect);
      return logins.length || dead.length
        ? undefined
        : "connected accounts refreshed; no saved logins to check and none needs reconnecting";
    },
  };
}

export function withLoginKeepAlive(keychain: Keychain, ensure: (ownerId: string) => Promise<void>): Keychain {
  const arm = (ownerId: string) =>
    ensure(ownerId).catch((e: unknown) => reportFailure(`login keep-alive: ensure ${ownerId}`, e));
  return {
    ...keychain,
    async save(input) {
      const saved = await keychain.save(input);
      if (saved.kind === "file") await arm(saved.ownerId);
      return saved;
    },
    async setConnectorToken(host, principalId, token, accountType) {
      await keychain.setConnectorToken(host, principalId, token, accountType);
      await arm(principalId);
    },
  };
}
