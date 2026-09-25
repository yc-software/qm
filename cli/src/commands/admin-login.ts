import { createHmac, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { configPathInDir, loadConfigAt } from "../config.ts";
import { CliError, note } from "../log.ts";
import { deploymentSecretValue, isMissingOrPlaceholder, readEnvFile } from "../util.ts";

export function adminLoginUrl(options: {
  publicUrl: string;
  secret: string;
  adminGrants: string;
  email?: string;
}): string {
  let origin: string;
  try {
    const url = new URL(options.publicUrl);
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.hostname.endsWith(".")
    )
      throw new Error("origin");
    origin = url.origin;
  } catch {
    throw new CliError("admin-login requires an HTTPS public URL (HTTP is allowed only on localhost)");
  }
  if (isMissingOrPlaceholder(options.secret) || options.secret.trim().length < 32) {
    throw new CliError("admin-login requires the deployment's PORTAL_SESSION_SECRET (at least 32 characters)");
  }
  const admins = [
    ...new Set(
      options.adminGrants.split(",").flatMap((entry) => {
        const separator = entry.lastIndexOf(":");
        const email = entry.slice(0, separator).trim().toLowerCase();
        return entry.slice(separator + 1).trim() === "org_admin" &&
          email.length <= 254 &&
          /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(email)
          ? [email]
          : [];
      }),
    ),
  ];
  const email = options.email?.trim().toLowerCase() ?? (admins.length === 1 ? admins[0] : undefined);
  if (!email || !admins.includes(email)) {
    throw new CliError(
      "admin-login requires one email with :org_admin in ADMIN_GRANTS; use --email to choose among configured admins",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    k: "admin-login",
    sub: email,
    aud: origin,
    iat: now,
    exp: now + 300,
    jti: randomBytes(18).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = createHmac("sha256", options.secret).update("portal.admin-login.v1").digest();
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${origin}/auth/admin-login#token=${body}.${signature}`;
}

export function runAdminLogin(options: { configPath?: string; envFile?: string; email?: string }): void {
  const configPath = options.configPath ?? configPathInDir(process.cwd());
  const loaded = configPath ? loadConfigAt(configPath) : undefined;
  if (loaded && (!loaded.config.services.includes("portal") || !loaded.config.services.includes("admin"))) {
    throw new CliError("admin-login requires the portal and admin services");
  }
  const env = readEnvFile(options.envFile ?? join(loaded ? dirname(loaded.path) : process.cwd(), ".env"));
  const secretValue = (name: string): string | undefined => deploymentSecretValue(name, env.get(name));
  const config = loaded?.config;
  note(
    adminLoginUrl({
      publicUrl: config?.publicUrl ?? secretValue("PORTAL_PUBLIC_URL") ?? "",
      secret: secretValue(config?.secretEnv?.portal?.PORTAL_SESSION_SECRET ?? "PORTAL_SESSION_SECRET") ?? "",
      adminGrants:
        config?.env.core?.ADMIN_GRANTS ?? secretValue(config?.secretEnv?.core?.ADMIN_GRANTS ?? "ADMIN_GRANTS") ?? "",
      email: options.email,
    }),
  );
}
