import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { json } from "../../chassis/src/http.ts";
import { portFromEnv } from "../../chassis/src/env.ts";
import { bootProblems, readConfig } from "./config.ts";
import { coreClaimStore } from "../../chassis/src/claims.ts";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { createBrandingCache } from "../../chassis/src/branding.ts";
import { mailerFor } from "./email.ts";
import { loadSigningKey } from "./keys.ts";
import { TokenSigner } from "./tokens.ts";
import { createAuthHandler } from "./server.ts";

const PORT = portFromEnv(8099);
const IS_PROD = process.env.NODE_ENV === "production";
const CFG = readConfig(process.env);

export function bootChecks(): void {
  const problems = bootProblems(CFG, IS_PROD);
  if (!problems.length) return;
  for (const problem of problems) console.error(`[auth] FATAL: ${problem}`);
  throw new Error(`auth broker refusing to start: ${problems.length} misconfiguration(s)`);
}

export async function startServer(): Promise<void> {
  bootChecks();
  const signingKey = await loadSigningKey(CFG.signingJwk!);
  const mailer = mailerFor(CFG);
  const branding = createBrandingCache(async () => {
    const path = withSourceAuthNonce("/v1/surface-config", CFG.coreSigningSecret);
    const r = await fetch(`${CFG.coreApiUrl}${path}`, {
      headers: signedHeaders(CFG.coreSigningSecret, "GET", path),
      signal: AbortSignal.timeout(2_000),
    });
    if (!r.ok) throw new Error(`surface-config ${r.status}`);
    const b = ((await r.json()) as { branding?: { selfLabel?: unknown } }).branding;
    return typeof b?.selfLabel === "string" ? { selfLabel: b.selfLabel } : {};
  });
  const handle = createAuthHandler({
    cfg: CFG,
    signingKey,
    signer: new TokenSigner(CFG.tokenSecret, CFG.issuer),
    claims: coreClaimStore(CFG.coreApiUrl, CFG.coreSigningSecret, "auth"),
    mailer,
    brandName: () => {
      void branding.forRender();
      return branding.current().selfLabel || CFG.brandName;
    },
  });
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      console.error("[auth] 500 %s %s: %s", req.method ?? "?", (req.url ?? "?").split("?")[0], String(err));
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
      else res.end();
    });
  });
  server.listen(PORT, () => {
    console.log(
      `[auth] sign-in broker on http://localhost:${PORT} (issuer ${CFG.issuer}, key ${signingKey.kid}, ${mailer ? `${CFG.transport} email` : "email not configured"})`,
    );
    if (!CFG.coreSigningSecret)
      console.warn(
        "[auth] CORE_SIGNING_SECRET unset — core will reject the single-use claims that make links and codes one-shot",
      );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
