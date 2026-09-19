import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { sleep } from "../src/util/async.ts";

test(
  "one host runs separate tenant databases and survives a process restart with identical actor and thread IDs",
  {
    skip: !process.env.DATABASE_URL,
    timeout: 90_000,
  },
  async (t) => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const dir = mkdtempSync(join(tmpdir(), "qm-tenant-host-"));
    const suffix = randomBytes(6).toString("hex");
    const tenants = ["alpha", "beta"].map((id) => {
      const dbName = `qm_tenant_host_${id}_${suffix}`;
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${dbName}`;
      return {
        id,
        dbName,
        url: url.toString(),
        source: randomBytes(24).toString("hex"),
        identity: randomBytes(24).toString("hex"),
        pool: new pg.Pool({ connectionString: url.toString() }),
      };
    });
    let child: ChildProcess | undefined;
    let output = "";
    const stop = async () => {
      const current = child;
      child = undefined;
      if (!current || current.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => current.once("exit", () => resolve()));
      current.kill("SIGTERM");
      const timer = setTimeout(() => current.kill("SIGKILL"), 10_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    };
    t.after(async () => {
      await stop();
      for (const tenant of tenants) {
        await tenant.pool.end();
        await admin.query(`DROP DATABASE IF EXISTS ${tenant.dbName}`);
      }
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    });
    for (const tenant of tenants) {
      await admin.query(`CREATE DATABASE ${tenant.dbName}`);
      writeFileSync(
        join(dir, `${tenant.id}.env`),
        Object.entries({
          DATABASE_URL: tenant.url,
          CORE_SIGNING_SECRET: tenant.source,
          PORTAL_IDENTITY_SECRET: tenant.identity,
          CAPABILITY_SECRET: randomBytes(24).toString("hex"),
          CONNECTOR_SECRET_KEY: randomBytes(24).toString("hex"),
          HARNESS: "mock",
          SANDBOX_BACKEND: "local",
          AUTH_ALLOWED_EMAILS: "same@example.test",
          ADMIN_GRANTS: "same@example.test:org_admin",
          WORKERS: "1",
          SEED_SKILLS: "0",
          SHUTDOWN_DRAIN_MS: "2000",
          MEMORY_CAPTURE: "off",
          MEMORY_RECALL: "off",
        })
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
        { mode: 0o600 },
      );
    }
    const manifest = join(dir, "tenants.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        tenants: tenants.map(({ id }) => ({ id, hosts: [`${id}.example.test`], envFile: `${id}.env` })),
      }),
    );
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const start = async () => {
      output = "";
      child = spawn(process.execPath, ["src/index.ts"], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          QM_TENANTS_FILE: manifest,
          DATA_DIR: join(dir, "data"),
          QM_WORKER_CONCURRENCY: "1",
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.on("data", (data: Buffer) => {
        output += data.toString();
      });
      child.stderr!.on("data", (data: Buffer) => {
        output += data.toString();
      });
      const deadline = Date.now() + 30_000;
      while (!output.includes(`listening on :${port}`)) {
        assert.equal(child.exitCode, null, output);
        assert.ok(Date.now() < deadline, output);
        await sleep(50);
      }
    };
    const call = async (tenant: (typeof tenants)[number], method: "GET" | "POST", path: string, value?: unknown) => {
      const body = value === undefined ? "" : JSON.stringify(value);
      const identity = await mintSignedPayload(
        { p: "same@example.test", orgId: tenant.id, exp: Date.now() + 60_000 },
        tenant.identity,
      );
      return fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...signedHeaders(tenant.source, method, path, body, body, tenant.id),
          "x-portal-identity": identity,
        },
        ...(body ? { body } : {}),
      });
    };
    await start();
    const responses = await Promise.all(
      tenants.map(async (tenant) => {
        const response = await call(tenant, "POST", "/v1/turns", {
          surface: "web",
          actor: { externalId: "same@example.test" },
          conversation: { kind: "dm", threadRef: "shared-thread", audience: [{ externalId: "same@example.test" }] },
          text: `private-marker-${tenant.id}`,
          readOnly: true,
          skipMemory: true,
        });
        const result = (await response.json()) as { status: string; sessionId: string };
        assert.equal(response.status, 200, JSON.stringify(result) + output);
        assert.equal(result.status, "ok", JSON.stringify(result) + output);
        return result;
      }),
    );
    assert.notEqual(responses[0]!.sessionId, responses[1]!.sessionId);
    for (const tenant of tenants) {
      const rows = await tenant.pool.query("SELECT request FROM runs");
      assert.equal(rows.rows.length, 1);
      assert.equal(JSON.parse(rows.rows[0].request).text, `private-marker-${tenant.id}`);
      const sessions = await tenant.pool.query("SELECT id FROM sessions WHERE thread_ref = 'shared-thread'");
      assert.equal(sessions.rows.length, 1);
    }
    const stolen = await call(tenants[1]!, "GET", `/v1/sessions/${responses[0]!.sessionId}?viewer=same%40example.test`);
    assert.equal(stolen.status, 404);
    await stop();
    await start();
    for (let index = 0; index < tenants.length; index++) {
      const response = await call(
        tenants[index]!,
        "GET",
        `/v1/sessions/${responses[index]!.sessionId}?viewer=same%40example.test`,
      );
      assert.equal(response.status, 200, await response.text());
    }
  },
);
