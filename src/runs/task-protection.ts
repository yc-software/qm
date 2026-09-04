import { errMessage } from "../util/errors.ts";

export interface TaskProtection {
  set(enabled: boolean): Promise<void>;
}

const PROTECTION_EXPIRES_MINUTES = 60;

export function createEcsTaskProtection(agentUri: string, opts?: { fetchFn?: typeof fetch }): TaskProtection {
  const fetchFn = opts?.fetchFn ?? fetch;
  let lastFailure: string | null = null;
  return {
    async set(enabled: boolean): Promise<void> {
      try {
        const res = await fetchFn(`${agentUri.replace(/\/$/, "")}/task-protection/v1/state`, {
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
      } catch (e) {
        const msg = errMessage(e);
        if (msg !== lastFailure) {
          lastFailure = msg;
          console.error(`[task-protection] set(${enabled}) failed (turns fall back to drain+resume): ${msg}`);
        }
      }
    },
  };
}
