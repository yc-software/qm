import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SecretKey } from "../connectors/connector-client-store.ts";
import { currentTenant } from "../tenants/context.ts";
import { createEncryptedSecretStore, VAULT_REF, type SecretStore, type SecretStoreFactory } from "./secret-store.ts";

export type VaultAuth =
  | { method: "token"; token?: string; tokenFile?: string }
  | { method: "kubernetes" | "jwt"; mount: string; role: string; jwtFile: string };

export interface VaultSettings {
  addr: string;
  kvMount: string;
  namespace?: string;
  auth: VaultAuth;
}

const REQUEST_TIMEOUT_MS = 10_000;
const LOGIN_RENEW_MARGIN_MS = 60_000;

class VaultError extends Error {
  readonly status: number;
  constructor(status: number, method: string, path: string, detail: string) {
    super(`Vault answered ${method} ${path} with ${status}: ${detail.slice(0, 200)}`);
    this.status = status;
  }
}

function sanitizeKeySegment(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    const ok =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      ch === "." ||
      ch === "_" ||
      ch === "-";
    out += ok ? ch : "-";
  }
  return out;
}

export function createVaultSecretStores(settings: VaultSettings, fetchImpl: typeof fetch = fetch): SecretStoreFactory {
  const auth = settings.auth;
  let session: { token: string; expiresAt: number } | undefined;
  let pendingLogin: Promise<string> | undefined;

  const call = async (method: string, path: string, token: string | undefined, body?: object): Promise<Response> => {
    const response = await fetchImpl(`${settings.addr}/v1/${path}`, {
      method,
      headers: {
        ...(token ? { "x-vault-token": token } : {}),
        ...(settings.namespace ? { "x-vault-namespace": settings.namespace } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new VaultError(response.status, method, path, detail);
    }
    return response;
  };

  const login = async (): Promise<string> => {
    if (auth.method === "token") throw new Error("Vault token auth has no login");
    const jwt = (await readFile(auth.jwtFile, "utf8")).trim();
    const response = await call("POST", `auth/${auth.mount}/login`, undefined, { role: auth.role, jwt });
    const { auth: issued } = (await response.json()) as { auth: { client_token: string; lease_duration: number } };
    session = {
      token: issued.client_token,
      expiresAt:
        issued.lease_duration > 0
          ? Date.now() + issued.lease_duration * 1000 - LOGIN_RENEW_MARGIN_MS
          : Number.POSITIVE_INFINITY,
    };
    return issued.client_token;
  };

  const clientToken = async (): Promise<string> => {
    if (auth.method === "token") {
      if (auth.tokenFile) return (await readFile(auth.tokenFile, "utf8")).trim();
      if (auth.token) return auth.token;
      throw new Error("Vault token auth needs VAULT_TOKEN or VAULT_TOKEN_FILE");
    }
    if (session && Date.now() < session.expiresAt) return session.token;
    pendingLogin ??= login().finally(() => {
      pendingLogin = undefined;
    });
    return pendingLogin;
  };

  const authorized = async (method: string, path: string, body?: object): Promise<Response> => {
    try {
      return await call(method, path, await clientToken(), body);
    } catch (e) {
      if (!(e instanceof VaultError) || e.status !== 403 || auth.method === "token") throw e;
      session = undefined;
      return call(method, path, await clientToken(), body);
    }
  };

  const secretPath = (kind: "data" | "metadata", key: string) =>
    `${settings.kvMount}/${kind}/${currentTenant()}/${encodeURIComponent(key)}`;
  const keyOf = (ref: string) => ref.slice(VAULT_REF.length);

  return (key: SecretKey): SecretStore => {
    const encrypted = createEncryptedSecretStore(key);
    return {
      async put(name, value) {
        const secretKey = `${sanitizeKeySegment(name)}@${randomUUID()}`;
        await authorized("POST", secretPath("data", secretKey), { data: { value } });
        return VAULT_REF + secretKey;
      },
      async get(ref) {
        if (!ref.startsWith(VAULT_REF)) return encrypted.get(ref);
        const response = await authorized("GET", secretPath("data", keyOf(ref)));
        const { data } = (await response.json()) as { data: { data: { value?: unknown } } };
        if (typeof data.data.value !== "string") throw new Error(`Vault secret ${ref} has no string value`);
        return data.data.value;
      },
      async delete(ref) {
        if (!ref.startsWith(VAULT_REF)) return encrypted.delete(ref);
        try {
          await authorized("DELETE", secretPath("metadata", keyOf(ref)));
        } catch (e) {
          if (!(e instanceof VaultError) || e.status !== 404) throw e;
        }
      },
    };
  };
}
