import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { Destination, ScopeId } from "../types.ts";
import type { GrantMode, KeychainCredentialMeta } from "./keychain.ts";
import { encryptSecret, decryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";
import type { DurableTasks } from "../durable/tasks.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";

export interface SecretDropSubmission {
  secret?: string;
  fields?: Array<{ envKey: string; value: string; secret: boolean }>;
  attestation?: Pick<CapabilityClaims, "botActor" | "liveActor" | "members">;
}

export interface SecretDropField {
  key: string;
  label?: string;
  secret?: boolean;
}

export interface SecretDropRecord {
  ownerId: string;
  orgId?: string;
  service: string;
  envKey?: string;
  host?: string;
  fields?: SecretDropField[];
  purpose: string;
  requestedBy: string;
  audienceScopeId?: ScopeId;
  scopeVersion?: string;
  grantMode?: GrantMode;
  destination?: Destination;
  threadRef?: string;
  requiresToken?: boolean;
  createdAt: number;
  submission?: { acceptedAt: number; savedAt?: number; encrypted?: string; credential?: KeychainCredentialMeta };
}

type SecretDropResult = { ok: true; rec: SecretDropRecord } | { ok: false; reason: "not_found" | "expired" };

export interface SecretDropStore {
  mint(rec: Omit<SecretDropRecord, "createdAt">, now?: number): Promise<{ dropId: string }>;
  peek(dropId: string, now?: number): Promise<SecretDropResult>;
  redeem(dropId: string, now?: number): Promise<SecretDropResult>;
  siblings(rec: SecretDropRecord, now?: number): Promise<SecretDropRecord[]>;
  submit?(dropId: string, input: SecretDropSubmission): Promise<KeychainCredentialMeta | null>;
  submission(dropId: string): Promise<{ rec: SecretDropRecord; input?: SecretDropSubmission } | null>;
  markSubmissionSaved(dropId: string): Promise<void>;
  completeSubmission(dropId: string, credential: KeychainCredentialMeta): Promise<void>;
  recoverSubmissions(): Promise<void>;
}

export const SECRET_DROP_TTL_MS = 7 * 24 * 60 * 60_000;

export function createSecretDropStore(
  backing: DurableMap<SecretDropRecord>,
  opts: { ttlMs?: number; now?: () => number; key?: SecretKey; tasks?: DurableTasks } = {},
): SecretDropStore {
  const ttl = opts.ttlMs ?? SECRET_DROP_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  const judge = (rec: SecretDropRecord | null, at: number): SecretDropResult => {
    if (!rec || rec.submission) return { ok: false, reason: "not_found" };
    if (at - rec.createdAt > ttl) return { ok: false, reason: "expired" };
    return { ok: true, rec };
  };
  const schedule = (dropId: string) =>
    opts.tasks!.spawn(
      "keychain.drop-redeem",
      { dropId },
      { idempotencyKey: `drop-redeem:${dropId}`, maxAttempts: null },
    );
  return {
    ...(opts.tasks && opts.key
      ? {
          async submit(dropId: string, input: SecretDropSubmission): Promise<KeychainCredentialMeta | null> {
            if (!backing.update) throw new Error("Secret drops require atomic submission updates");
            let accepted = false;
            await backing.update(dropId, (rec) => {
              if (!judge(rec, clock()).ok) return rec;
              accepted = true;
              return {
                ...rec,
                submission: { acceptedAt: clock(), encrypted: encryptSecret(JSON.stringify(input), opts.key!) },
              };
            });
            if (!accepted) return null;
            const { taskId } = await schedule(dropId);
            return opts.tasks!.result<KeychainCredentialMeta>(taskId);
          },
        }
      : {}),
    async submission(dropId) {
      const rec = await backing.get(dropId);
      if (!rec?.submission) return null;
      return {
        rec,
        ...(rec.submission.encrypted && opts.key
          ? {
              input: JSON.parse(decryptSecret(rec.submission.encrypted, opts.key)) as SecretDropSubmission,
            }
          : {}),
      };
    },
    async markSubmissionSaved(dropId) {
      if (!backing.update) throw new Error("Secret drops require atomic submission updates");
      await backing.update(dropId, (rec) =>
        rec.submission
          ? {
              ...rec,
              submission: { ...rec.submission, savedAt: rec.submission.savedAt ?? clock() },
            }
          : rec,
      );
    },
    async completeSubmission(dropId, credential) {
      if (!backing.update) throw new Error("Secret drops require atomic submission updates");
      await backing.update(dropId, (rec) =>
        rec.submission
          ? {
              ...rec,
              submission: { acceptedAt: rec.submission.acceptedAt, credential },
            }
          : rec,
      );
    },
    async recoverSubmissions() {
      if (!opts.tasks) return;
      for (const [id, rec] of await backing.entries()) {
        if (rec.submission?.encrypted) await schedule(id);
      }
    },
    async mint(rec, now) {
      const dropId = `${randomUUID()}${randomUUID().replace(/-/g, "")}`;
      await backing.put(dropId, { ...rec, createdAt: now ?? clock() });
      return { dropId };
    },
    async peek(dropId, now) {
      return judge(await backing.get(dropId), now ?? clock());
    },
    async redeem(dropId, now) {
      return judge(await backing.take(dropId), now ?? clock());
    },
    async siblings(rec, now) {
      const at = now ?? clock();
      const out: SecretDropRecord[] = [];
      for (const [id, r] of await backing.entries()) {
        if (r.submission?.savedAt !== undefined || r.submission?.credential) continue;
        if (!r.submission && at - r.createdAt > ttl) {
          void backing.delete(id).catch(() => {});
          continue;
        }
        if (
          r.orgId === rec.orgId &&
          r.audienceScopeId === rec.audienceScopeId &&
          r.threadRef === rec.threadRef &&
          r.service !== rec.service
        )
          out.push(r);
      }
      return out;
    },
  };
}
