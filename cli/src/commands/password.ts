import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { QmConfig } from "../config.ts";
import { CliError, note, ok } from "../log.ts";
import { normalizePasswordEmail, parsePasswordHashes, promptPasswordHash } from "../passwords.ts";
import { deploymentSecretValue, promptHidden, readEnvFile, writeEnvValue } from "../util.ts";

export async function runPassword(opts: {
  config: QmConfig;
  configDir: string;
  email: string;
  envFile?: string;
  askHidden?: (question: string) => Promise<string>;
}): Promise<void> {
  if (!opts.config.services.includes("auth") || opts.config.env.auth?.AUTH_LOGIN_METHOD !== "password") {
    throw new CliError('qm password requires the auth service and env.auth.AUTH_LOGIN_METHOD="password"');
  }
  const email = normalizePasswordEmail(opts.email);
  const envPath = opts.envFile ?? join(opts.configDir, ".env");
  const env = readEnvFile(envPath);
  const existing = deploymentSecretValue("AUTH_PASSWORD_HASHES", env.get("AUTH_PASSWORD_HASHES"));
  const hashes = existing?.trim() ? parsePasswordHashes(existing) : {};
  note("Provision only an identity you have verified; password sign-in does not verify email ownership.");
  hashes[email] = await promptPasswordHash(email, opts.askHidden ?? promptHidden);
  writeEnvValue(envPath, "AUTH_PASSWORD_HASHES", JSON.stringify(hashes));
  chmodSync(envPath, 0o600);
  ok(`saved password for ${email} in ${envPath}; membership is unchanged`);
  note(
    opts.config.target !== "docker"
      ? "Run qm secrets push, then qm up to apply the password."
      : "Run qm up to apply the password.",
  );
}
