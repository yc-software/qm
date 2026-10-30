import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { CORE_API_URL as CORE, CORE_SIGNING_SECRET } from "../../chassis/src/env.ts";
import { boundTenant } from "../../chassis/src/tenant.ts";

const NEUTRAL_ACCENT = "#4f46e5";
interface SurfaceConfig {
  accent: string;
  modelProviderConfigured?: boolean;
  nextAt: number;
  inflight: Promise<void> | null;
}
const surfaceConfigs = new Map<string, SurfaceConfig>();
export function surfaceConfig(): SurfaceConfig {
  const tenant = boundTenant() ?? "";
  const config = surfaceConfigs.get(tenant) ?? { accent: NEUTRAL_ACCENT, nextAt: 0, inflight: null };
  surfaceConfigs.set(tenant, config);
  return config;
}
export function refreshSurfaceConfig(): Promise<void> {
  const config = surfaceConfig();
  if (Date.now() >= config.nextAt) {
    config.nextAt = Date.now() + 5_000;
    config.inflight = fetchSurfaceConfig(config).finally(() => {
      config.inflight = null;
    });
  }
  return config.inflight ?? Promise.resolve();
}
async function fetchSurfaceConfig(config: SurfaceConfig): Promise<void> {
  try {
    const path = withSourceAuthNonce("/v1/surface-config", CORE_SIGNING_SECRET);
    const r = await fetch(`${CORE}${path}`, {
      headers: signedHeaders(CORE_SIGNING_SECRET, "GET", path),
      signal: AbortSignal.timeout(2_000),
    });
    if (r.ok) {
      const body = (await r.json()) as { branding?: { accent?: unknown }; modelProviderConfigured?: unknown };
      config.accent = typeof body.branding?.accent === "string" ? body.branding.accent : NEUTRAL_ACCENT;
      config.modelProviderConfigured =
        typeof body.modelProviderConfigured === "boolean" ? body.modelProviderConfigured : undefined;
      config.nextAt = Date.now() + (config.modelProviderConfigured === false ? 5_000 : 30_000);
    }
  } catch {
    void 0;
  }
}
