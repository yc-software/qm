import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGitCliSmokeCommand } from "../scripts/git-cli-smoke.ts";

function writeExecutable(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function runSmokeCommand(
  options: Parameters<typeof buildGitCliSmokeCommand>[0],
  pathDir: string,
): { code: number; output: string } {
  try {
    const output = execFileSync("/bin/sh", ["-c", buildGitCliSmokeCommand(options)], {
      env: { ...process.env, PATH: `${pathDir}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function fakeBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-cli-smoke-bin-"));
  writeExecutable(
    dir,
    "git",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "git version 2.51.0"; exit 0; fi
exit 2
`,
  );
  return dir;
}

test("git CLI smoke reports sanitized missing GitHub auth by default", () => {
  const dir = fakeBin();
  writeExecutable(
    dir,
    "gh",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.80.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo "not logged in token SECRET_GH_TOKEN" >&2; exit 1; fi
exit 2
`,
  );

  const result = runSmokeCommand({}, dir);

  assert.equal(result.code, 0);
  assert.match(result.output, /git cli ok:/);
  assert.match(result.output, /gh_auth=auth_missing/);
  assert.match(result.output, /glab=missing/);
  assert.match(result.output, /glab_auth=skipped/);
  assert.doesNotMatch(result.output, /SECRET_GH_TOKEN/);
});

test("git CLI smoke command is one physical line for the mock !run grammar", () => {
  assert.doesNotMatch(buildGitCliSmokeCommand({}), /\n/);
});

test("git CLI smoke can require GitHub resident auth", () => {
  const dir = fakeBin();
  writeExecutable(
    dir,
    "gh",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.80.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo "not logged in"; exit 1; fi
exit 2
`,
  );

  const result = runSmokeCommand({ requireGhAuth: true }, dir);

  assert.equal(result.code, 1);
  assert.match(result.output, /git cli error: kind=auth_missing tool=gh/);
});

test("git CLI smoke distinguishes host reachability from missing auth", () => {
  const dir = fakeBin();
  writeExecutable(
    dir,
    "gh",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.80.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo "could not resolve host: github.com"; exit 1; fi
exit 2
`,
  );

  const result = runSmokeCommand({ requireGhAuth: true }, dir);

  assert.equal(result.code, 1);
  assert.match(result.output, /git cli error: kind=host_unreachable tool=gh/);
});

test("git CLI smoke can require glab binary and auth explicitly", () => {
  const dir = fakeBin();
  writeExecutable(
    dir,
    "gh",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.80.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
exit 2
`,
  );

  const missing = runSmokeCommand({ requireGlab: true }, dir);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /git cli error: kind=binary_missing tool=glab/);

  writeExecutable(
    dir,
    "glab",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "glab version 1.59.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo "No GitLab hosts configured"; exit 1; fi
exit 2
`,
  );
  const authMissing = runSmokeCommand({ requireGlabAuth: true }, dir);
  assert.equal(authMissing.code, 1);
  assert.match(authMissing.output, /git cli error: kind=auth_missing tool=glab/);
});
