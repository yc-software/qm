import { execFile, spawn } from "node:child_process";
import { chmod, chown, lchown, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);

export async function startSqliteBackup({ dataDir, env, uid, gid }) {
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "AWS_ENDPOINT_URL_S3",
    "S3_BUCKET",
    "S3_PREFIX",
  ])
    if (!env[key]) throw new Error(`Render app backups require ${key}`);
  const sqlitePath = join(dataDir, "app.db");
  const directory = await mkdtemp(join(tmpdir(), "qm-render-sqlite-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  const configPath = join(directory, "litestream.json");
  let child;
  let exited;
  try {
    await mkdir(dataDir, { recursive: true });
    if (uid !== undefined) await chown(dataDir, uid, gid);
    await writeFile(
      configPath,
      JSON.stringify({
        addr: "127.0.0.1:9090",
        dbs: [
          {
            path: sqlitePath,
            replicas: [
              {
                type: "s3",
                bucket: env.S3_BUCKET,
                path: `${env.S3_PREFIX}litestream`,
                region: env.AWS_REGION,
                endpoint: env.AWS_ENDPOINT_URL_S3,
                "force-path-style": true,
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    );
    await chmod(directory, 0o700);
    const options = { env, timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 };
    const config = ["-config", configPath, "-no-expand-env"];
    const probe = new URL(env.AWS_ENDPOINT_URL_S3);
    probe.pathname = `/${[env.S3_BUCKET, ...`${env.S3_PREFIX}litestream/.write-probe`.split("/")].map(encodeURIComponent).join("/")}`;
    for (const method of ["PUT", "GET", "DELETE"]) {
      const request = exec("curl", ["--config", "-"], options);
      request.child.stdin.end(
        [
          "silent",
          "show-error",
          "fail-with-body",
          "max-time = 30",
          `aws-sigv4 = ${JSON.stringify(`aws:amz:${env.AWS_REGION}:s3`)}`,
          `user = ${JSON.stringify(`${env.AWS_ACCESS_KEY_ID}:${env.AWS_SECRET_ACCESS_KEY}`)}`,
          `url = ${JSON.stringify(probe.href)}`,
          `request = ${JSON.stringify(method)}`,
          ...(method === "PUT" ? ['data-binary = ""'] : []),
        ].join("\n"),
      );
      await request.catch((error) => {
        const detail = [error.stderr, error.stdout].filter(Boolean).join("\n").trim().slice(0, 2048);
        throw new Error(`Render app backup ${method} probe failed: ${detail || error.message}`, { cause: error });
      });
    }
    await exec("litestream", ["restore", ...config, "-if-replica-exists", "-if-db-not-exists", sqlitePath], options);
    if (uid !== undefined)
      await lchown(sqlitePath, uid, gid).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    child = spawn("litestream", ["replicate", ...config], { env, stdio: "inherit" });
    let failure;
    exited = new Promise((done) => {
      child.once("error", (error) => {
        failure = new Error(`Render app backup process failed: ${error.message}`, { cause: error });
        done(failure);
      });
      child.once("exit", (code, signal) => {
        failure = new Error(`Render app backup process exited (${signal ?? code})`);
        done(failure);
      });
    });
    await new Promise((ready, reject) => {
      child.once("spawn", ready);
      child.once("error", reject);
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (failure) throw failure;
      const response = await fetch("http://127.0.0.1:9090/metrics", { signal: AbortSignal.timeout(500) }).catch(
        () => null,
      );
      await response?.body?.cancel();
      if (response?.ok) break;
      if (Date.now() >= deadline) throw new Error("Render app backup process did not become ready");
      await delay(50);
    }
    return {
      exited,
      assertRunning() {
        if (failure) throw failure;
      },
      async stop() {
        let timer;
        try {
          if (!failure) child.kill("SIGTERM");
          await Promise.race([
            exited,
            new Promise((done) => {
              timer = setTimeout(done, 5_000);
            }),
          ]);
          if (!failure) {
            child.kill("SIGKILL");
            await exited;
            throw new Error("Render app backup process did not stop before its deadline");
          }
          if (child.exitCode !== 0) throw failure;
        } finally {
          clearTimeout(timer);
          await cleanup();
        }
      },
    };
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await cleanup();
    throw new Error(`Render app SQLite restore failed: ${error.stderr?.trim() || error.message}`, { cause: error });
  }
}
