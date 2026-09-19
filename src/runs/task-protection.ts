import { errMessage } from "../util/errors.ts";

export interface TaskProtection {
  set(enabled: boolean): Promise<void>;
}

const PROTECTION_EXPIRES_MINUTES = 60;

function createSharedProtection(agentUri: string, fetchFn: typeof fetch) {
  const owners = new Set<object>();
  let version = 0;
  let pending: Promise<void> | null = null;
  let lastFailure: string | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const update = (): Promise<void> => {
    if (pending) return pending;
    let observed = -1;
    pending = Promise.resolve()
      .then(async () => {
        do {
          observed = version;
          const enabled = owners.size > 0;
          try {
            const res = await fetchFn(`${agentUri}/task-protection/v1/state`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(
                enabled
                  ? { ProtectionEnabled: true, ExpiresInMinutes: PROTECTION_EXPIRES_MINUTES }
                  : { ProtectionEnabled: false },
              ),
            });
            if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.trim());
            lastFailure = null;
            if (retry) clearTimeout(retry);
            retry = null;
          } catch (e) {
            const msg = errMessage(e);
            if (msg !== lastFailure) {
              lastFailure = msg;
              console.error(`[task-protection] set(${enabled}) failed (turns fall back to drain+resume): ${msg}`);
            }
            if (!retry) {
              retry = setTimeout(() => {
                retry = null;
                void update();
              }, 1_000);
              retry.unref?.();
            }
          }
        } while (observed !== version);
      })
      .finally(() => {
        pending = null;
        if (observed !== version) return update();
      });
    return pending;
  };

  return {
    set(owner: object, enabled: boolean): Promise<void> {
      if (owners.has(owner) !== enabled) {
        if (enabled) owners.add(owner);
        else owners.delete(owner);
        version++;
      }
      return update();
    },
  };
}

const shared = new Map<string, ReturnType<typeof createSharedProtection>>();

export function createEcsTaskProtection(agentUri: string, opts?: { fetchFn?: typeof fetch }): TaskProtection {
  const uri = agentUri.replace(/\/+$/, "");
  let protection = shared.get(uri);
  if (!protection) {
    protection = createSharedProtection(uri, opts?.fetchFn ?? fetch);
    shared.set(uri, protection);
  }
  const owner = {};
  const target = protection;
  return { set: (enabled) => target.set(owner, enabled) };
}
