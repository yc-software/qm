import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type {
  AuthEmailAccess,
  AuthEmailSettings,
  AuthEmailTransport,
  SmtpTlsMode,
} from "../../plugins/chassis/src/auth-email.ts";

interface ActiveStoredAuthEmailSettings {
  orgId: string;
  disabled: false;
  transport: AuthEmailTransport;
  from: string;
  access: AuthEmailAccess;
  smtp?: { host: string; port: number; tls: SmtpTlsMode; username: string; passwordEnc: string };
  resend?: { apiKeyEnc: string };
  version: string;
  updatedAt: number;
  updatedBy: string;
}

interface DisabledStoredAuthEmailSettings {
  orgId: string;
  disabled: true;
  version: string;
  updatedAt: number;
  updatedBy: string;
}

interface PendingStoredAuthEmailSettings {
  orgId: string;
  pendingBootstrap: true;
}

export type StoredAuthEmailSettings =
  ActiveStoredAuthEmailSettings | DisabledStoredAuthEmailSettings | PendingStoredAuthEmailSettings;

export interface AuthEmailSettingsStatus {
  configured: boolean;
  managed: boolean;
  source: "admin" | "environment" | "absent";
  transport?: AuthEmailTransport;
  from?: string;
  access?: AuthEmailAccess;
  smtp?: { host: string; port: number; tls: SmtpTlsMode; username: string; passwordSet: true };
  resend?: { apiKeySet: true };
  version?: string;
  updatedAt?: number;
  updatedBy?: string;
}

export interface ManagedAuthEmailSettings {
  settings: AuthEmailSettings;
  version: string;
  updatedAt: number;
  updatedBy: string;
}

export interface AuthEmailSettingsSnapshot {
  current: ManagedAuthEmailSettings | null;
  status: AuthEmailSettingsStatus;
}

export class AuthEmailSettingsConflict extends Error {
  constructor() {
    super("email settings changed; reload before saving");
    this.name = "AuthEmailSettingsConflict";
  }
}

export interface AuthEmailSettingsStore {
  get(): Promise<ManagedAuthEmailSettings | null>;
  status(): Promise<AuthEmailSettingsStatus>;
  snapshot(): Promise<AuthEmailSettingsSnapshot>;
  hasEverBeenManaged(): Promise<boolean>;
  permitBootstrap(): Promise<boolean>;
  set(settings: AuthEmailSettings, updatedBy: string, expectedVersion: string | null): Promise<AuthEmailSettingsStatus>;
  useEnvironment(updatedBy: string, expectedVersion?: string | null): Promise<AuthEmailSettingsStatus>;
}

export function createAuthEmailSettingsStore(input: {
  orgId: string;
  backing: DurableMap<StoredAuthEmailSettings>;
  keyMaterial: Buffer | string;
}): AuthEmailSettingsStore {
  const key = deriveConnectorKey(input.keyMaterial, "auth-email-settings");
  const record = () => input.backing.get(input.orgId);
  const version = () => `${Date.now()}:${crypto.randomUUID()}`;
  const pending = (saved: StoredAuthEmailSettings): saved is PendingStoredAuthEmailSettings =>
    "pendingBootstrap" in saved;
  const publicStatus = (saved: StoredAuthEmailSettings | null): AuthEmailSettingsStatus => {
    if (!saved || pending(saved)) return { configured: false, managed: false, source: "absent" };
    if (saved.disabled) {
      return {
        configured: false,
        managed: true,
        source: "environment",
        version: saved.version,
        updatedAt: saved.updatedAt,
        updatedBy: saved.updatedBy,
      };
    }
    return {
      configured: true,
      managed: true,
      source: "admin",
      transport: saved.transport,
      from: saved.from,
      access: saved.access,
      ...(saved.smtp
        ? {
            smtp: {
              host: saved.smtp.host,
              port: saved.smtp.port,
              tls: saved.smtp.tls,
              username: saved.smtp.username,
              passwordSet: true as const,
            },
          }
        : {}),
      ...(saved.resend ? { resend: { apiKeySet: true as const } } : {}),
      version: saved.version,
      updatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy,
    };
  };
  const assertExpected = (saved: StoredAuthEmailSettings | null, expected: string | null): void => {
    if ((saved && !pending(saved) ? saved.version : null) !== expected) throw new AuthEmailSettingsConflict();
  };
  const replace = async (
    next: StoredAuthEmailSettings,
    expectedVersion: string | null | undefined,
  ): Promise<StoredAuthEmailSettings> => {
    if (!input.backing.update || !input.backing.insertIfAbsent) {
      throw new Error("auth email settings store requires atomic updates");
    }
    if (expectedVersion === null) {
      const fromPending = await input.backing.update(input.orgId, (saved) => {
        assertExpected(saved, null);
        return next;
      });
      if (fromPending) return fromPending;
      if (await input.backing.insertIfAbsent(input.orgId, next)) return next;
      const raced = await input.backing.update(input.orgId, (saved) => {
        assertExpected(saved, null);
        return next;
      });
      if (!raced) throw new AuthEmailSettingsConflict();
      return raced;
    }
    if (expectedVersion !== undefined) {
      const updated = await input.backing.update(input.orgId, (saved) => {
        assertExpected(saved, expectedVersion);
        return next;
      });
      if (!updated) throw new AuthEmailSettingsConflict();
      return updated;
    }
    const updated = await input.backing.update(input.orgId, () => next);
    if (updated) return updated;
    if (await input.backing.insertIfAbsent(input.orgId, next)) return next;
    const raced = await input.backing.update(input.orgId, () => next);
    if (!raced) throw new Error("auth email settings update failed");
    return raced;
  };
  const managed = (saved: StoredAuthEmailSettings | null): ManagedAuthEmailSettings | null => {
    if (!saved || pending(saved) || saved.disabled) return null;
    const settings: AuthEmailSettings = saved.smtp
      ? {
          transport: "smtp",
          from: saved.from,
          access: saved.access,
          smtp: {
            host: saved.smtp.host,
            port: saved.smtp.port,
            tls: saved.smtp.tls,
            username: saved.smtp.username,
            password: decryptSecret(saved.smtp.passwordEnc, key),
          },
        }
      : {
          transport: "resend",
          from: saved.from,
          access: saved.access,
          resend: { apiKey: decryptSecret(saved.resend!.apiKeyEnc, key) },
        };
    return { settings, version: saved.version, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy };
  };
  return {
    async get() {
      return managed(await record());
    },
    async status() {
      return publicStatus(await record());
    },
    async snapshot() {
      const saved = await record();
      return { current: managed(saved), status: publicStatus(saved) };
    },
    async hasEverBeenManaged() {
      const saved = await record();
      return saved !== null && !pending(saved);
    },
    async permitBootstrap() {
      if (!input.backing.update || !input.backing.insertIfAbsent) {
        throw new Error("auth email settings store requires atomic updates");
      }
      const marker: PendingStoredAuthEmailSettings = { orgId: input.orgId, pendingBootstrap: true };
      let allowed = false;
      const existing = await input.backing.update(input.orgId, (saved) => {
        allowed = pending(saved);
        return saved;
      });
      if (existing) return allowed;
      if (await input.backing.insertIfAbsent(input.orgId, marker)) return true;
      const raced = await input.backing.update(input.orgId, (saved) => {
        allowed = pending(saved);
        return saved;
      });
      return Boolean(raced) && allowed;
    },
    async set(settings, updatedBy, expectedVersion) {
      const updatedAt = Date.now();
      const next: ActiveStoredAuthEmailSettings = {
        orgId: input.orgId,
        disabled: false,
        transport: settings.transport,
        from: settings.from,
        access: settings.access,
        ...(settings.transport === "smtp"
          ? {
              smtp: {
                host: settings.smtp.host,
                port: settings.smtp.port,
                tls: settings.smtp.tls,
                username: settings.smtp.username,
                passwordEnc: encryptSecret(settings.smtp.password, key),
              },
            }
          : { resend: { apiKeyEnc: encryptSecret(settings.resend.apiKey, key) } }),
        version: version(),
        updatedAt,
        updatedBy,
      };
      return publicStatus(await replace(next, expectedVersion));
    },
    async useEnvironment(updatedBy, expectedVersion) {
      const updatedAt = Date.now();
      const next: DisabledStoredAuthEmailSettings = {
        orgId: input.orgId,
        disabled: true,
        version: version(),
        updatedAt,
        updatedBy,
      };
      return publicStatus(await replace(next, expectedVersion));
    },
  };
}
