import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderMinioInitCommand } from "../src/render-minio.ts";

test("MinIO initialization executes as Render job arguments, re-attaches its policy, and reports failed operations", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-minio-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls");
  writeFileSync(
    join(dir, "timeout"),
    `#!/bin/sh
shift 5
exec "$@"
`,
  );
  writeFileSync(
    join(dir, "mc"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$QM_TEST_MC_LOG"
case "$*" in
  *'alias set'*)
    read -r user
    read -r password
    [ "$user" = "$MINIO_ROOT_USER" ] && [ "$password" = "$MINIO_ROOT_PASSWORD" ] || exit 1
    ;;
  *'admin user add'*)
    read -r secret
    [ "$secret" = "$QM_STORAGE_SECRET_KEY" ] || exit 1
    ;;
  *'admin policy attach'*)
    [ -e "$QM_TEST_MC_STATE" ] && exit 1
    : > "$QM_TEST_MC_STATE"
    ;;
  *'admin policy detach'*)
    rm -f "$QM_TEST_MC_STATE"
    ;;
esac
if [ "$QM_TEST_FAIL" = 1 ]; then printf 'AccessDenied\\n' >&2; exit 42; fi
`,
  );
  for (const name of ["timeout", "mc"]) chmodSync(join(dir, name), 0o755);
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    MINIO_ROOT_USER: "test-root",
    MINIO_ROOT_PASSWORD: "test-root-password",
    QM_STORAGE_SECRET_KEY: "test-storage-secret",
    QM_TEST_MC_LOG: log,
    QM_TEST_MC_STATE: join(dir, "attached"),
    QM_TEST_FAIL: "0",
  };
  const [shell, ...args] = renderMinioInitCommand("minio-private").split(" ");
  assert.equal(shell, "/bin/sh");
  assert.equal(args.length, 2);
  assert.doesNotMatch(args[1]!, /[\s"']/);
  const result = spawnSync(shell, args, { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "MinIO storage is ready\n");
  const operations = readFileSync(log, "utf8");
  assert.match(operations, /alias set qm http:\/\/minio-private:9000/);
  assert.match(operations, /mb --ignore-existing qm\/qm-storage/);
  assert.match(operations, /admin policy attach qm qm-storage --user qm-storage/);
  for (const secret of [env.MINIO_ROOT_PASSWORD, env.QM_STORAGE_SECRET_KEY]) assert.ok(!operations.includes(secret));
  const rerunLog = join(dir, "rerun-calls");
  const rerun = spawnSync(shell, args, { encoding: "utf8", env: { ...env, QM_TEST_MC_LOG: rerunLog } });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(rerun.stdout, "MinIO storage is ready\n");
  assert.match(
    readFileSync(rerunLog, "utf8"),
    /admin policy attach qm qm-storage --user qm-storage\n[^\n]*admin policy detach qm qm-storage --user qm-storage\n[^\n]*admin policy attach qm qm-storage --user qm-storage\n$/,
  );
  const failed = spawnSync(shell, args, { encoding: "utf8", env: { ...env, QM_TEST_FAIL: "1" } });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /MinIO initialization failed: root connection/);
  assert.match(failed.stderr, /AccessDenied/);
  assert.match(failed.stderr, /exit 42/);
  assert.equal(failed.stdout, "");
});
