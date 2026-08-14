import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { json, readBody } from "../../chassis/src/http.ts";
import { portFromEnv } from "../../chassis/src/env.ts";
import { environmentEmailProblems, environmentEmailSettings, readConfig, staticBootProblems } from "./config.ts";
import { coreClaimStore } from "../../chassis/src/claims.ts";
import { loadSigningKey } from "./keys.ts";
import { TokenSigner } from "./tokens.ts";
import { createAuthHandler } from "./server.ts";
import { createSignedRequestVerifier } from "../../chassis/src/source-auth-verify.ts";
import type { AuthEmailSettings } from "../../chassis/src/auth-email.ts";
import { AuthEmailRuntime, redactAuthEmailError } from "./runtime-email.ts";

const PORT = portFromEnv(8099);
const IS_PROD = process.env.NODE_ENV === "production";
const CFG = readConfig(process.env);

export function bootChecks(): void {
  const problems = staticBootProblems(CFG, IS_PROD);
  if (!problems.length) return;
  for (const problem of problems) console.error(`[auth] FATAL: ${problem}`);
  throw new Error(`auth broker refusing to start: ${problems.length} misconfiguration(s)`);
}

export async function startServer(): Promise<void> {
  bootChecks();
  const signingKey = await loadSigningKey(CFG.signingJwk!);
  const email = new AuthEmailRuntime({
    cfg: CFG,
    production: IS_PROD,
    coreApiUrl: CFG.coreApiUrl,
    signingSecret: CFG.coreSigningSecret,
  });
  await email.refresh();
  email.start();
  const handle = createAuthHandler({
    cfg: CFG,
    signingKey,
    signer: new TokenSigner(CFG.tokenSecret, CFG.issuer),
    claims: coreClaimStore(CFG.coreApiUrl, CFG.coreSigningSecret, "auth"),
    email: () => email.current(),
  });
  const internalAuth = createSignedRequestVerifier(CFG.coreSigningSecret);
  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const pathWithQuery = req.url ?? "/";
      const pathname = new URL(pathWithQuery, "http://auth.local").pathname;
      if (method === "GET" && pathname === "/healthz") {
        return json(res, 200, { ok: true, email: email.status() });
      }
      if (pathname.startsWith("/internal/email-settings/")) {
        const body = method === "POST" ? await readBody(req, 64 * 1024) : "";
        const signature = req.headers["x-signature"];
        const timestamp = req.headers["x-timestamp"];
        if (
          !internalAuth.verify({
            method,
            pathWithQuery,
            body,
            timestamp: Array.isArray(timestamp) ? timestamp[0] : timestamp,
            signature: Array.isArray(signature) ? signature[0] : signature,
          })
        ) {
          return json(res, 401, { error: "unauthorized" });
        }
        if (method === "GET" && pathname === "/internal/email-settings/status") {
          return json(res, 200, email.status());
        }
        if (method === "POST" && pathname === "/internal/email-settings/validate") {
          let parsed: { settings?: AuthEmailSettings; recipient?: string };
          try {
            parsed = JSON.parse(body) as typeof parsed;
          } catch {
            return json(res, 400, { error: "bad_request" });
          }
          if (!parsed.settings || typeof parsed.recipient !== "string") {
            return json(res, 400, { error: "bad_request" });
          }
          try {
            return json(res, 200, { ok: true, ...(await email.validate(parsed.settings, parsed.recipient)) });
          } catch (error) {
            return json(res, 400, {
              error: "validation_failed",
              message: redactAuthEmailError(error, parsed.settings),
            });
          }
        }
        if (method === "POST" && pathname === "/internal/email-settings/validate-environment") {
          let parsed: { recipient?: string };
          try {
            parsed = JSON.parse(body) as typeof parsed;
          } catch {
            return json(res, 400, { error: "bad_request" });
          }
          if (typeof parsed.recipient !== "string") return json(res, 400, { error: "bad_request" });
          try {
            return json(res, 200, { ok: true, ...(await email.validateEnvironment(parsed.recipient)) });
          } catch (error) {
            return json(res, 400, {
              error: "validation_failed",
              message: redactAuthEmailError(error, environmentEmailSettings(CFG)),
            });
          }
        }
        return json(res, 404, { error: "not_found" });
      }
      return handle(req, res);
    })().catch((err: unknown) => {
      console.error("[auth] 500 %s %s: %s", req.method ?? "?", (req.url ?? "?").split("?")[0], String(err));
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
      else res.end();
    });
  });
  server.listen(PORT, () => {
    const emailState = email.status();
    console.log(
      `[auth] sign-in broker on http://localhost:${PORT} (issuer ${CFG.issuer}, key ${signingKey.kid}, email ${emailState.state})`,
    );
    const environmentProblems = environmentEmailProblems(CFG, IS_PROD);
    if (environmentProblems.length && emailState.source !== "admin") {
      console.warn("[auth] deployment email fallback is not configured");
    }
    if (!CFG.coreSigningSecret)
      console.warn(
        "[auth] CORE_SIGNING_SECRET unset — core will reject the single-use claims that make links and codes one-shot",
      );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
