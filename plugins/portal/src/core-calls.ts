import { LRUCache } from "lru-cache";
import { fetchCoreText, type HttpMethod } from "../../chassis/src/core-client.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { errMessage, swallow } from "../../chassis/src/errors.ts";
import { reportFailure } from "../../chassis/src/error-reporting.ts";
import { CORE_API_URL as CORE, coreOrgId, coreSigningSecret, portalIdentitySecret } from "../../chassis/src/env.ts";
import { perEdgeTenant } from "../../chassis/src/tenant-hosts.ts";

const surfaceConfig = perEdgeTenant(() => ({
  modelProviderConfigured: undefined as boolean | undefined,
  brandLabel: "QM",
  nextAt: 0,
  inflight: null as Promise<void> | null,
}));
export const modelProviderConfigured = (): boolean | undefined => surfaceConfig().modelProviderConfigured;
export const brandLabel = (): string => surfaceConfig().brandLabel;
export function refreshSurfaceConfig(): Promise<void> {
  const state = surfaceConfig();
  if (Date.now() >= state.nextAt) {
    state.nextAt = Date.now() + 5_000;
    state.inflight = fetchSurfaceConfig().finally(() => {
      state.inflight = null;
    });
  }
  return state.inflight ?? Promise.resolve();
}
export async function coreCall<T extends object>(
  method: HttpMethod,
  path: string,
  o: { body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; status: number; body: Partial<T> }> {
  const r = await fetchCoreText({ origin: CORE, secret: coreSigningSecret(), method, path, ...o });
  let body: unknown;
  try {
    body = JSON.parse(r.text);
  } catch {
    body = undefined;
  }
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    body: body && typeof body === "object" ? body : {},
  };
}

async function fetchSurfaceConfig(): Promise<void> {
  try {
    const r = await coreCall<{ modelProviderConfigured?: unknown; branding?: { selfLabel?: unknown } }>(
      "GET",
      "/v1/surface-config",
      {
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (r.ok) {
      const body = r.body;
      const state = surfaceConfig();
      state.modelProviderConfigured =
        typeof body.modelProviderConfigured === "boolean" ? body.modelProviderConfigured : undefined;
      const label = body.branding?.selfLabel;
      state.brandLabel = typeof label === "string" && label.trim() ? label.trim() : "QM";
      state.nextAt = Date.now() + (state.modelProviderConfigured === false ? 5_000 : 30_000);
    } else console.warn(`[portal] surface-config returned HTTP ${r.status}`);
  } catch (error) {
    swallow("portal: surface-config fetch (retrying)", error);
  }
}

const ADMIN_TTL_MS = 60_000;
const ADMIN_PROBE_TIMEOUT_MS = 6_500;
const ADMIN_PROBE_ATTEMPTS = 2;
const ADMIN_PROBE_RETRY_DELAY_MS = 250;
export const adminCache = perEdgeTenant(() => new LRUCache<string, boolean>({ max: 10_000, ttl: ADMIN_TTL_MS }));

export function portalIdentityHeaders(sub: string): Record<string, string> {
  const secret = portalIdentitySecret();
  return secret ? { [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: sub, exp: Date.now() + 60_000 }, secret) } : {};
}

export async function adminProbeAttempt(sub: string): Promise<boolean | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ADMIN_PROBE_TIMEOUT_MS);
  try {
    const r = await coreCall<{ isAdmin: unknown }>("GET", "/v1/admin/whoami", {
      headers: { "x-admin-actor": `${sub}@${coreOrgId()}`, ...portalIdentityHeaders(sub) },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`[portal] admin probe returned HTTP ${r.status}`);
      return null;
    }
    const j = r.body;
    if (typeof j.isAdmin !== "boolean") {
      console.warn("[portal] admin probe returned an invalid admin status");
      return null;
    }
    return j.isAdmin;
  } catch (error) {
    reportFailure("portal: admin probe", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function isAdmin(sub: string): Promise<boolean> {
  const hit = adminCache().get(sub);
  if (hit !== undefined) return hit;
  for (let attempt = 0; attempt < ADMIN_PROBE_ATTEMPTS; attempt++) {
    const isAdmin = await adminProbeAttempt(sub);
    if (isAdmin === null) {
      if (attempt + 1 < ADMIN_PROBE_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, ADMIN_PROBE_RETRY_DELAY_MS));
      continue;
    }
    adminCache().set(sub, isAdmin);
    return isAdmin;
  }
  return false;
}

const CANONICAL_TTL_MS = 60_000;
const CANONICAL_TIMEOUT_MS = 4_000;
const canonicalCache = perEdgeTenant(() => new LRUCache<string, string>({ max: 10_000, ttl: CANONICAL_TTL_MS }));

export async function canonicalPrincipal(sub: string): Promise<string | null> {
  const hit = canonicalCache().get(sub);
  if (hit !== undefined) return hit;
  try {
    const r = await coreCall<{ canonicalId: unknown }>("GET", `/v1/principals/${encodeURIComponent(sub)}/canonical`, {
      signal: AbortSignal.timeout(CANONICAL_TIMEOUT_MS),
    });
    if (!r.ok) {
      console.warn(`[portal] canonical principal lookup returned HTTP ${r.status}`);
      return null;
    }
    const body = r.body;
    const canonical = typeof body.canonicalId === "string" && body.canonicalId ? body.canonicalId : sub;
    canonicalCache().set(sub, canonical);
    return canonical;
  } catch (error) {
    reportFailure("portal: canonical principal lookup", error);
    return null;
  }
}

export async function coreImpersonate(
  action: "start" | "stop",
  admin: string,
  target: string,
): Promise<{ ok: boolean; status: number; displayName?: string; message?: string }> {
  try {
    const r = await coreCall<{ displayName: string; message: string }>(
      "POST",
      `/v1/admin/impersonate${action === "stop" ? "/stop" : ""}`,
      {
        body: JSON.stringify({ target }),
        headers: { "x-admin-actor": `${admin}@${coreOrgId()}`, ...portalIdentityHeaders(admin) },
      },
    );
    return { ok: r.ok, status: r.status, displayName: r.body.displayName, message: r.body.message };
  } catch (e) {
    return { ok: false, status: 502, message: errMessage(e) };
  }
}
