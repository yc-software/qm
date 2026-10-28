import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { renderMinioCommand, renderMinioInitCommand } from "../cli/src/render-minio.ts";
import { createRenderAppStorage, type StoredRenderAppStorage } from "../src/deploy/render-app-storage.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFakeRenderApi } from "./support/fake-render.ts";

const execute = promisify(execFile);
const minioContext = fileURLToPath(new URL("../deploy/render-minio", import.meta.url));
const skip = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return false;
  } catch {
    return "start a Docker daemon to run the MinIO script tests";
  }
})();

interface ShellResult {
  status: number;
  stdout: string;
  stderr: string;
}

async function docker(...args: string[]): Promise<string> {
  return (await execute("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
}

function run(args: string[]): Promise<ShellResult> {
  return execute("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
    (error: Error & { code?: number; stdout?: string; stderr?: string }) => {
      if (typeof error.code !== "number") throw error;
      return { status: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    },
  );
}

test(
  "MinIO scripts initialize, re-run, enable, and scope app access on the pinned image",
  { skip, timeout: 900_000 },
  async (t) => {
    const image = (await docker("build", "--quiet", "--file", `${minioContext}/Dockerfile`, minioContext)).trim();
    const tools = await run([
      "run",
      "--rm",
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      "command -v sh mc timeout mktemp base64",
    ]);
    assert.equal(
      tools.status,
      0,
      `the MinIO image lacks a tool the Render job scripts need: ${tools.stdout}${tools.stderr}`,
    );
    const container = `qm-minio-${randomUUID()}`;
    const storageSecret = randomUUID();
    await docker(
      "run",
      "--detach",
      "--name",
      container,
      "--publish",
      "127.0.0.1::9000",
      "--mount",
      "type=tmpfs,destination=/data,tmpfs-mode=1777",
      "--env",
      "MINIO_ROOT_USER=test-root",
      "--env",
      `MINIO_ROOT_PASSWORD=${randomUUID()}`,
      "--env",
      `QM_STORAGE_SECRET_KEY=${storageSecret}`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      renderMinioCommand,
    );
    t.after(() => docker("rm", "--force", container));
    const renderJob = (command: string) => {
      const words = command.split(" ");
      for (const word of words) assert.doesNotMatch(word, /[\s"']/, command);
      return run(["exec", container, ...words]);
    };
    const shell = (script: string) => run(["exec", container, "/bin/sh", "-c", script]);
    const endpoint = `http://${(await docker("port", container, "9000/tcp")).split("\n")[0]!.trim()}`;
    const deadline = Date.now() + 120_000;
    while (
      !(await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1_000) }).then(
        (response) => response.ok,
        () => false,
      ))
    ) {
      assert.equal((await docker("inspect", "--format", "{{.State.Running}}", container)).trim(), "true");
      assert.ok(Date.now() < deadline, "MinIO did not become healthy");
      await delay(250);
    }

    const init = renderMinioInitCommand("localhost");
    for (const attempt of [1, 2]) {
      const result = await renderJob(init);
      assert.equal(result.status, 0, `initialization attempt ${attempt}: ${result.stderr}`);
      assert.equal(result.stdout, "MinIO storage is ready\n");
    }

    const jobs = new Map<string, Promise<ShellResult>>();
    const commands: string[] = [];
    const api = createFakeRenderApi(({ method, path, body }) => {
      if (path === "/services/srv-minio" && method === "GET")
        return { ownerId: "tea-test", environmentId: "env-test", type: "web_service" };
      if (path === "/services/srv-minio/jobs" && method === "POST") {
        const command = (body as { startCommand: string }).startCommand;
        commands.push(command);
        const id = `job-${jobs.size + 1}`;
        jobs.set(id, renderJob(command));
        return { id, status: "pending" };
      }
      const job = /^\/services\/srv-minio\/jobs\/(job-\d+)$/.exec(path);
      if (job && method === "GET")
        return jobs
          .get(job[1]!)!
          .then((result) => ({ id: job[1], status: result.status === 0 ? "succeeded" : "failed" }));
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const store = createMemoryMap<StoredRenderAppStorage>();
    const storage = createRenderAppStorage({
      apiKey: "key",
      workspaceId: "tea-test",
      environmentId: "env-test",
      minioServiceId: "srv-minio",
      endpoint: "http://localhost:9000",
      bucket: "qm-storage",
      store,
      keyMaterial: "test-key",
      api,
      pollIntervalMs: 50,
    });
    const deploymentId = randomUUID();
    const credentials = await storage.ensure(deploymentId);
    const accessKey = credentials.AWS_ACCESS_KEY_ID!;
    const user = async () => {
      const result = await shell(
        `mc --config-dir /tmp/qm-test-mc --no-color alias set qm http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc --config-dir /tmp/qm-test-mc --no-color admin user info qm ${accessKey} --json`,
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout) as { userStatus: string; policyName?: string };
    };
    const rerunLatestJob = async () => {
      const result = await renderJob(commands.at(-1)!);
      assert.equal(result.status, 0, result.stderr);
    };
    const put = (key: string) =>
      new S3Client({
        endpoint,
        region: credentials.AWS_REGION,
        forcePathStyle: true,
        maxAttempts: 1,
        requestChecksumCalculation: "WHEN_REQUIRED",
        credentials: { accessKeyId: accessKey, secretAccessKey: credentials.AWS_SECRET_ACCESS_KEY! },
      }).send(new PutObjectCommand({ Bucket: credentials.S3_BUCKET, Key: key, Body: "content" }));
    const forbidden = (error: unknown) =>
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 403;

    let info = await user();
    assert.equal(info.userStatus, "enabled");
    assert.ok(info.policyName?.split(",").includes(`qm-app-${accessKey}`), info.policyName);
    await put(`${credentials.S3_PREFIX}file.txt`);
    await assert.rejects(put("app-data/other/file.txt"), forbidden);
    await rerunLatestJob();
    assert.equal((await user()).userStatus, "enabled");

    assert.deepEqual(await storage.ensure(deploymentId), credentials);
    info = await user();
    assert.equal(info.userStatus, "enabled");
    assert.ok(info.policyName?.split(",").includes(`qm-app-${accessKey}`), info.policyName);
    await put(`${credentials.S3_PREFIX}file.txt`);
    assert.equal(commands.length, 1);

    await t.test("SQLite retains local data and restores its scoped Litestream backup", async () => {
      const runnerContext = fileURLToPath(new URL("../deploy/render-runner", import.meta.url));
      const runnerImage = (await docker("build", "--quiet", runnerContext)).trim();
      const program = `
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { readdir, rm, writeFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startSqliteBackup } from "/opt/qm/sqlite.mjs";
const start = (env = process.env) => startSqliteBackup({ dataDir: "/data", env, uid: 10001, gid: 10001 });
let replica = await start();
const open = () => {
  process.setegid(10001);
  process.seteuid(10001);
  try {
    const db = new DatabaseSync("/data/app.db");
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS entries (value TEXT NOT NULL)");
    return db;
  } finally {
    process.seteuid(0);
    process.setegid(0);
  }
};
const waitForBackup = async (expected) => {
  await writeFile("/tmp/restore.json", JSON.stringify({ dbs: [{ path: "/data/app.db", replicas: [{
    type: "s3", bucket: process.env.S3_BUCKET, path: process.env.S3_PREFIX + "litestream",
    region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL_S3, "force-path-style": true,
  }] }] }));
  const deadline = Date.now() + 20_000;
  for (;;) {
    await rm("/tmp/proof.db", { force: true });
    execFileSync("litestream", ["restore", "-config", "/tmp/restore.json", "-if-replica-exists", "-o", "/tmp/proof.db", "/data/app.db"]);
    let values = [];
    try {
      const proof = new DatabaseSync("/tmp/proof.db", { readOnly: true });
      try { values = proof.prepare("SELECT value FROM entries ORDER BY rowid").all().map(row => row.value); }
      finally { proof.close(); }
    } catch {}
    if (JSON.stringify(values) === JSON.stringify(expected)) return;
    assert.ok(Date.now() < deadline, "Litestream did not back up the committed rows: " + JSON.stringify(values));
    await delay(100);
  }
};
let db = open();
db.prepare("INSERT INTO entries VALUES (?)").run("first");
await writeFile("/data/file.txt", "retained file");
await waitForBackup(["first"]);
replica.assertRunning();
const pid = Number(execFileSync("pidof", ["litestream"], { encoding: "utf8" }).trim());
assert.ok(Number.isInteger(pid) && pid > 1);
assert.throws(() => execFileSync("cat", ["/proc/" + pid + "/environ"], { uid: 10001, gid: 10001, stdio: "pipe" }));
process.kill(pid, "SIGKILL");
await replica.exited;
assert.throws(() => replica.assertRunning(), /SIGKILL/);
await assert.rejects(replica.stop(), /SIGKILL/);
db.close();
for (const name of await readdir("/data"))
  if (name !== "file.txt") await rm("/data/" + name, { recursive: true, force: true });
replica = await start();
db = open();
assert.deepEqual(db.prepare("SELECT value FROM entries").all().map(row => row.value), ["first"]);
assert.equal(await readFile("/data/file.txt", "utf8"), "retained file");
db.close();
await replica.stop();
await assert.rejects(start({ ...process.env, AWS_SECRET_ACCESS_KEY: "incorrect-key" }), /PUT probe failed:.*SignatureDoesNotMatch/s);
await assert.rejects(start({ ...process.env, S3_PREFIX: "app-data/other/" }), /PUT probe failed:.*AccessDenied/s);
db = open();
assert.deepEqual(db.prepare("SELECT value FROM entries").all().map(row => row.value), ["first"]);
db.close();
db = open();
db.prepare("INSERT INTO entries VALUES (?)").run("local-only");
db.close();
replica = await start();
db = open();
assert.deepEqual(db.prepare("SELECT value FROM entries ORDER BY rowid").all().map(row => row.value), ["first", "local-only"]);
db.prepare("INSERT INTO entries VALUES (?)").run("replicated");
await waitForBackup(["first", "local-only", "replicated"]);
db.close();
await replica.stop();
for (const name of await readdir("/data")) await rm("/data/" + name, { recursive: true, force: true });
await assert.rejects(start({ ...process.env, AWS_SECRET_ACCESS_KEY: "incorrect-key" }), /PUT probe failed:.*SignatureDoesNotMatch/s);
assert.equal((await readdir("/data")).includes("app.db"), false);
await assert.rejects(start({ ...process.env, S3_PREFIX: "app-data/other/" }), /PUT probe failed:.*AccessDenied/s);
assert.equal((await readdir("/data")).includes("app.db"), false);
replica = await start();
db = open();
assert.deepEqual(db.prepare("SELECT value FROM entries ORDER BY rowid").all().map(row => row.value), ["first", "local-only", "replicated"]);
db.close();
await replica.stop();
console.log("SQLite retained local data and restored its scoped Litestream backup");
`;
      const result = await run([
        "run",
        "--rm",
        "--network",
        `container:${container}`,
        "--mount",
        "type=tmpfs,destination=/data,tmpfs-mode=1777",
        ...Object.entries(credentials).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        "--entrypoint",
        "node",
        runnerImage,
        "--input-type=module",
        "--eval",
        program,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /SQLite retained local data and restored its scoped Litestream backup/);
    });

    const removed = await shell(`mc --config-dir /tmp/qm-test-mc admin user rm qm ${accessKey}`);
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(await storage.ensure(deploymentId, true), credentials);
    assert.equal(commands.length, 2);
    assert.equal((await user()).userStatus, "enabled");
    await put(`${credentials.S3_PREFIX}file.txt`);
  },
);
