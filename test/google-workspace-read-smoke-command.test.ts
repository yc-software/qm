import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildGoogleWorkspaceReadSmokeCommand } from "../scripts/google-workspace-read-smoke-command.ts";

const TOKEN_ENV = "VAULT_TOKEN_WWW_GOOGLEAPIS_COM";

function fakeCurl(body: string, argvFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), "google-read-smoke-bin-"));
  const path = join(dir, "curl");
  const script = [
    "#!/bin/sh",
    `: > ${JSON.stringify(argvFile)}`,
    `for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvFile)}; done`,
    `printf '%s' ${JSON.stringify(body)}`,
    "",
  ].join("\n");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return dir;
}

function run(command: string, pathDir: string, extraEnv: Record<string, string>): { code: number; output: string } {
  try {
    const output = execFileSync("/bin/sh", ["-c", command], {
      env: {
        PATH: `${pathDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
        ...extraEnv,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("Google Workspace read smoke command is one physical line", () => {
  assert.doesNotMatch(buildGoogleWorkspaceReadSmokeCommand(), /\n/);
});

test("Google Workspace read smoke fails closed when the connector token env var is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "google-read-smoke-bin-"));
  const result = run(buildGoogleWorkspaceReadSmokeCommand(), dir, {});

  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`missing ${TOKEN_ENV}`));
});

test("Google Workspace read smoke sends Authorization: Bearer from the connector env var (no proxy)", () => {
  const argvFile = join(mkdtempSync(join(tmpdir(), "google-read-smoke-argv-")), "argv");
  const dir = fakeCurl(JSON.stringify({ id: "timezone", value: "SECRET_TIMEZONE" }), argvFile);
  const result = run(buildGoogleWorkspaceReadSmokeCommand(), dir, { [TOKEN_ENV]: "smoke-oauth-token" });

  assert.equal(result.code, 0);
  assert.match(result.output, /google read ok: target=calendar-settings bytes=\d+/);
  assert.doesNotMatch(result.output, /SECRET_TIMEZONE/);

  const argv = readFileSync(argvFile, "utf8");
  assert.match(argv, /^Authorization: Bearer smoke-oauth-token$/m);
  assert.match(argv, /^https:\/\/www\.googleapis\.com\/calendar\/v3\/users\/me\/settings\/timezone$/m);
  assert.doesNotMatch(argv, /--proxy/);
});

test("Google Workspace read smoke fails closed on unexpected response shape", () => {
  const argvFile = join(mkdtempSync(join(tmpdir(), "google-read-smoke-argv-")), "argv");
  const dir = fakeCurl(JSON.stringify({ id: "locale", value: "en-US" }), argvFile);
  const result = run(buildGoogleWorkspaceReadSmokeCommand(), dir, { [TOKEN_ENV]: "smoke-oauth-token" });

  assert.equal(result.code, 1);
  assert.match(result.output, /unexpected calendar settings response/);
});
