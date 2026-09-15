import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { sleep } from "../src/util/async.ts";

const databaseUrl = process.env.DATABASE_URL;

test(
  "HTTP project mutation survives loss of its advisory-lock socket and recovers",
  {
    skip: databaseUrl ? false : "requires DATABASE_URL",
    timeout: 60_000,
  },
  async (t) => {
    const cleanup = new AsyncDisposableStack();
    t.after(() => cleanup.disposeAsync());
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    cleanup.defer(() => admin.end());
    const database = `advisory_http_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${database}`);
    cleanup.defer(async () => {
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    });
    const target = new URL(databaseUrl!);
    target.pathname = `/${database}`;
    const sockets = new Set<Socket>();
    const connections = new Map<number, Socket>();
    const proxy = createServer((front) => {
      const back = connect(Number(target.port || 5432), target.hostname);
      for (const socket of [front, back]) {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));
      }
      back.once("connect", () => connections.set(back.localPort!, front));
      back.once("close", () => {
        for (const [port, socket] of connections) if (socket === front) connections.delete(port);
      });
      front.once("close", () => back.destroy());
      front.pipe(back).pipe(front);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    cleanup.defer(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });

    const proxied = new URL(target);
    proxied.hostname = "127.0.0.1";
    proxied.port = String((proxy.address() as AddressInfo).port);
    const dataDir = await mkdtemp(join(tmpdir(), "advisory-http-"));
    cleanup.defer(() => rm(dataDir, { recursive: true, force: true }));

    const child = fork(new URL("./support/advisory-lock-server.ts", import.meta.url), [], {
      env: { PATH: process.env.PATH, HOME: dataDir, DATABASE_URL: proxied.toString() },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let logs = "";
    child.stdout!.on("data", (chunk) => {
      logs += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      logs += chunk;
    });
    const exited = once(child, "exit");
    cleanup.defer(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    });
    const ready = await Promise.race([
      once(child, "message").then(([message]) => message as { base: string }),
      exited.then(() => {
        throw new Error(`server exited before ready: ${logs}`);
      }),
    ]);
    const request = (path: string, method = "GET", body?: unknown) =>
      fetch(`${ready.base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    const created = await request("/v1/projects", "POST", { principalId: "owner", name: "Before" });
    assert.equal(created.status, 201, await created.clone().text());
    const { project } = (await created.json()) as { project: { id: string } };
    const observer = new pg.Client({ connectionString: target.toString() });
    observer.on("error", () => {});
    await observer.connect();
    cleanup.defer(() => observer.end());
    await observer.query("BEGIN");
    cleanup.defer(async () => {
      await observer.query("ROLLBACK");
    });
    await observer.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [project.id]);
    const mutation = request(`/v1/projects/${project.id}`, "PATCH", { principalId: "owner", name: "Interrupted" }).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    let lockSocket: Socket | undefined;
    for (let attempt = 0; attempt < 200 && !lockSocket; attempt++) {
      await observer.query("SELECT pg_stat_clear_snapshot()");
      const { rows } = await observer.query<{ client_port: number }>(
        `SELECT a.client_port FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
       WHERE l.locktype = 'advisory' AND l.granted AND a.datname = current_database()
         AND a.query = 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked'`,
      );
      for (const row of rows) lockSocket = connections.get(row.client_port) ?? lockSocket;
      if (!lockSocket) await sleep(10);
    }
    assert.ok(lockSocket, `project mutation did not acquire its lock: ${logs}`);
    lockSocket.destroy();
    await sleep(100);
    assert.equal(child.exitCode, null, `database disconnect crashed server: ${logs}`);
    await observer.query("ROLLBACK");
    const result = await mutation;
    assert.ok("response" in result, `request connection was lost: ${logs}`);
    assert.equal(result.response.status, 500, "lock loss must not be reported as success");
    await result.response.arrayBuffer();
    assert.equal((await request("/healthz")).status, 200);
    const recovered = await request(`/v1/projects/${project.id}`, "PATCH", { principalId: "owner", name: "Recovered" });
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.equal(((await recovered.json()) as { project: { name: string } }).project.name, "Recovered");
    assert.equal(child.exitCode, null, logs);
    await observer.query("DELETE FROM projects WHERE id = $1", [project.id]);
  },
);
