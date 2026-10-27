import { reportBackendError } from "../../chassis/src/error-reporting.ts";
import "./instrument.ts";
import { coreRememberedSessions } from "./sessions.ts";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { json } from "../../chassis/src/http.ts";
import { portFromEnv } from "../../chassis/src/env.ts";
import { bootProblems, readConfig, type AuthConfig } from "./config.ts";
import { coreClaimStore } from "../../chassis/src/claims.ts";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { createBrandingCache } from "../../chassis/src/branding.ts";
import { mailerFor } from "./email.ts";
import { loadSigningKey } from "./keys.ts";
import { TokenSigner } from "./tokens.ts";
import { createAuthHandler } from "./server.ts";
import { edgeTenant, serveForHost, tenantPublicUrl } from "../../chassis/src/tenant-hosts.ts";
import { deriveTenantSecret, type TenantSettings } from "../../chassis/src/tenant-settings.ts";

const PORT = portFromEnv(8099);
const IS_PROD = process.env.NODE_ENV === "production";
const CFG = readConfig(process.env);

export function bootChecks(): void {
  const problems = bootProblems(CFG, IS_PROD);
  if (!problems.length) return;
  for (const problem of problems) console.error(`[auth] FATAL: ${problem}`);
  throw new Error(`auth broker refusing to start: ${problems.length} misconfiguration(s)`);
}

function tenantConfig(tenant: TenantSettings & { id: string }): AuthConfig {
  const origin = tenantPublicUrl(tenant);
  return {
    ...CFG,
    issuer: `${origin}${CFG.publicPath}`,
    redirectUri: `${origin}${new URL(CFG.redirectUri).pathname}`,
    clientSecret: deriveTenantSecret(CFG.clientSecret, tenant.id),
    tokenSecret: deriveTenantSecret(CFG.tokenSecret, tenant.id),
    faviconSvg: tenant.faviconSvg ?? CFG.faviconSvg,
    coreSigningSecret: CFG.coreSigningSecret && deriveTenantSecret(CFG.coreSigningSecret, tenant.id),
  };
}

export async function startServer(
  options: { port?: number; host?: string; trustedSignInLabel?: string } = {},
): Promise<import("node:http").Server> {
  bootChecks();
  const signingKey = await loadSigningKey(CFG.signingJwk!);
  const mailer = mailerFor(CFG);
  const handlerFor = (cfg: AuthConfig, trustedSignInLabel: string | undefined) => {
    const branding = createBrandingCache(async () => {
      const path = withSourceAuthNonce("/v1/surface-config", cfg.coreSigningSecret);
      const r = await fetch(`${cfg.coreApiUrl}${path}`, {
        headers: signedHeaders(cfg.coreSigningSecret, "GET", path),
        signal: AbortSignal.timeout(2_000),
      });
      if (!r.ok) throw new Error(`surface-config ${r.status}`);
      const b = ((await r.json()) as { branding?: { selfLabel?: unknown } }).branding;
      return typeof b?.selfLabel === "string" ? { selfLabel: b.selfLabel } : {};
    });
    return createAuthHandler({
      cfg,
      trustedSignInLabel,
      signingKey,
      signer: new TokenSigner(cfg.tokenSecret, cfg.issuer),
      sessions: coreRememberedSessions(cfg.coreApiUrl, cfg.coreSigningSecret),
      claims: coreClaimStore(cfg.coreApiUrl, cfg.coreSigningSecret, "auth"),
      mailer,
      brandName: () => {
        void branding.forRender();
        return branding.current().selfLabel || cfg.brandName;
      },
    });
  };
  const home = handlerFor(CFG, options.trustedSignInLabel);
  const tenants = new WeakMap<TenantSettings, ReturnType<typeof createAuthHandler>>();
  const handlerOf = (): ReturnType<typeof createAuthHandler> => {
    const tenant = edgeTenant();
    if (!tenant?.id) return home;
    let handle = tenants.get(tenant);
    if (!handle) {
      handle = handlerFor(
        tenantConfig({ ...tenant, id: tenant.id }),
        tenant.oidcClientId ? tenant.oidcLabel?.trim() || undefined : undefined,
      );
      tenants.set(tenant, handle);
    }
    return handle;
  };
  const server = createServer((req, res) =>
    serveForHost(req, res, () => {
      void (async () => handlerOf()(req, res))().catch((err: unknown) => {
        reportBackendError(err);
        console.error("[auth] 500 %s %s: %s", req.method ?? "?", (req.url ?? "?").split("?")[0], String(err));
        if (!res.headersSent) json(res, 500, { error: "internal_error" });
        else res.end();
      });
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? PORT, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(
    `[auth] sign-in broker on http://${options.host ?? "localhost"}:${options.port ?? PORT} (issuer ${CFG.issuer}, key ${signingKey.kid}, ${mailer ? `${CFG.transport} email` : "email not configured"})`,
  );
  if (!CFG.coreSigningSecret)
    console.warn(
      "[auth] CORE_SIGNING_SECRET unset, so core will reject the single-use claims that make links and codes one-shot",
    );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
