import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAwsDeployProvider, type StoredDeployBody } from "../src/deploy/aws-deploy-provider.ts";
import {
  AwsApiError,
  type AwsMicrovmApi,
  type MicrovmDescription,
  type MicrovmLifecycleState,
} from "../src/sandbox/aws-microvm-api.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";

const REGION = "us-west-2";

interface Vm {
  state: MicrovmLifecycleState;
  endpoint: string;
}

function fakeApi() {
  const vms = new Map<string, Vm>();
  const counts = { run: 0, resume: 0, terminate: 0, token: 0, describe: 0 };
  let n = 0;
  const api: AwsMicrovmApi = {
    async listImages() {
      return [{ name: "qm-microvm-sandbox", imageArn: "arn:img", state: "ACTIVE", latestActiveImageVersion: "1" }];
    },
    async findImage(name) {
      return { name, imageArn: "arn:img", state: "ACTIVE", latestActiveImageVersion: "1" };
    },
    async createImage() {
      throw new Error("createImage unused in deploy provider");
    },
    async updateImage() {
      throw new Error("updateImage unused in deploy provider");
    },
    async runMicrovm() {
      counts.run++;
      const id = `mvm-${++n}`;
      const endpoint = `${id}.lambda-microvm.${REGION}.on.aws`;
      vms.set(id, { state: "RUNNING", endpoint });
      return { microvmId: id, endpoint, state: "RUNNING" };
    },
    async getMicrovm(id) {
      counts.describe++;
      const v = vms.get(id);
      if (!v) throw new AwsApiError("not found", 404);
      return { microvmId: id, ...v };
    },
    async tryGetMicrovm(id) {
      counts.describe++;
      const v = vms.get(id);
      return v ? { microvmId: id, ...v } : null;
    },
    async createAuthToken(id) {
      counts.token++;
      return `tok-${id}-${counts.token}`;
    },
    async suspend(id) {
      const v = vms.get(id);
      if (v) v.state = "SUSPENDED";
    },
    async resume(id) {
      counts.resume++;
      const v = vms.get(id);
      if (v) v.state = "RUNNING";
    },
    async terminate(id) {
      counts.terminate++;
      const v = vms.get(id);
      if (v) v.state = "TERMINATED";
    },
    async waitForState(id, target): Promise<MicrovmDescription> {
      const v = vms.get(id);
      return { microvmId: id, state: v?.state ?? target, ...(v?.endpoint ? { endpoint: v.endpoint } : {}) };
    },
  };
  return { api, vms, counts };
}

function fakeDaemon(
  opts: {
    execCode?: (cmd: string, url: string) => number;
    execStdout?: (cmd: string) => string;
    readB64?: (path: string) => string;
  } = {},
) {
  const execs: string[] = [];
  const writes: Array<{ path: string; b64: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, string>) : {};
    const ok = (data: unknown) => ({
      status: 200,
      text: async () => JSON.stringify(data),
      headers: { get: () => null },
    });
    if (u.endsWith("/health")) return ok({ ok: true });
    if (u.endsWith("/exec")) {
      execs.push(body.cmd ?? "");
      return ok({
        stdout: opts.execStdout?.(body.cmd ?? "") ?? "",
        stderr: "",
        code: opts.execCode?.(body.cmd ?? "", u) ?? 0,
        timedOut: false,
      });
    }
    if (u.endsWith("/write")) {
      writes.push({ path: body.path!, b64: body.b64! });
      return ok({ ok: true });
    }
    if (u.endsWith("/read")) return ok({ b64: opts.readB64?.(body.path ?? "") ?? "" });
    return ok({});
  }) as unknown as typeof fetch;
  return { fetchImpl, execs, writes };
}

function fakeS3(objects: Map<string, Uint8Array> = new Map()) {
  const calls: string[] = [];
  const s3 = {
    async send(cmd: { constructor: { name: string }; input: { Key?: string; Body?: Uint8Array } }) {
      const kind = cmd.constructor.name;
      const key = cmd.input.Key!;
      calls.push(`${kind}:${key}`);
      if (kind === "PutObjectCommand") objects.set(key, cmd.input.Body!);
      if (kind === "DeleteObjectCommand") objects.delete(key);
      if (kind === "GetObjectCommand") {
        const bytes = objects.get(key);
        if (!bytes) {
          const e = new Error("no such key") as Error & { name: string };
          e.name = "NoSuchKey";
          throw e;
        }
        return { Body: { transformToByteArray: async () => bytes } };
      }
      if (kind === "ListObjectsV2Command") {
        const prefix = (cmd.input as { Prefix?: string }).Prefix ?? "";
        return {
          Contents: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ Key: k })),
          IsTruncated: false,
        };
      }
      if (kind === "DeleteObjectsCommand") {
        for (const o of (cmd.input as unknown as { Delete: { Objects: Array<{ Key: string }> } }).Delete.Objects)
          objects.delete(o.Key);
      }
      return {};
    },
  };
  return { s3: s3 as unknown as Pick<import("@aws-sdk/client-s3").S3Client, "send">, objects, calls };
}

function fakeSts() {
  const assumes: Array<{ policy: string; role: string }> = [];
  const sts = {
    async send(cmd: { input: { RoleArn?: string; Policy?: string } }) {
      assumes.push({ policy: cmd.input.Policy ?? "", role: cmd.input.RoleArn ?? "" });
      return {
        Credentials: {
          AccessKeyId: `AKIA${assumes.length}`,
          SecretAccessKey: "sk",
          SessionToken: "tok",
          Expiration: new Date(),
        },
      };
    },
  };
  return { sts: sts as unknown as Pick<import("@aws-sdk/client-sts").STSClient, "send">, assumes };
}

function provider(
  api: AwsMicrovmApi,
  fetchImpl: typeof fetch,
  store = createMemoryMap<StoredDeployBody>(),
  extra: Record<string, unknown> = {},
) {
  return createAwsDeployProvider({
    region: REGION,
    imageIdentifier: "qm-microvm-sandbox",
    appPort: 8081,
    appsDomain: "apps.example.com",
    api,
    fetchImpl,
    store,
    ...extra,
  });
}

function deployment(id: string, name?: string): Deployment {
  return {
    id,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    currentVersion: 1,
    status: "stopped",
    endpoint: null,
    versions: [],
    ...(name ? { name } : {}),
  };
}

function localSnapshot(file: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-deploy-"));
  const target = join(dir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return dir;
}

function version(snapshotDir: string, over: Partial<DeploymentVersion> = {}): DeploymentVersion {
  return { version: 1, createdAt: 0, entrypoint: "node server.js", snapshotDir, env: { API_KEY: "secret" }, ...over };
}

const ID = "550e8400-e29b-41d4-a716-446655440000";
const written = (writes: Array<{ path: string }>, p: string): boolean => writes.some((w) => w.path === p);

function rig(
  opts: {
    daemon?: Parameters<typeof fakeDaemon>[0];
    data?: "tar" | "litestream";
    objects?: Map<string, Uint8Array>;
    extra?: Record<string, unknown>;
    name?: string;
  } = {},
) {
  const { api, vms, counts } = fakeApi();
  const { fetchImpl, execs, writes } = fakeDaemon(opts.daemon);
  const { s3, objects, calls } = fakeS3(opts.objects);
  const { sts, assumes } = fakeSts();
  const store = createMemoryMap<StoredDeployBody>();
  const data =
    opts.data === undefined
      ? {}
      : {
          dataBucket: "bkt",
          s3,
          ...(opts.data === "litestream" ? { sts, dataRoleArn: "arn:aws:iam::1:role/data" } : {}),
        };
  const p = provider(api, fetchImpl, store, { ...data, ...opts.extra });
  const d = deployment(ID, opts.name);
  return {
    api,
    vms,
    counts,
    execs,
    writes,
    store,
    objects,
    calls,
    assumes,
    p,
    d,
    apply: (v: DeploymentVersion = version(localSnapshot("a", "1"))) => p.apply(d, v),
    resolve: () => p.resolveEndpoint!(d, version("/unused")),
    async seedBody(id = "mvm-old", over: Partial<StoredDeployBody> = {}) {
      const endpoint = `${id}.lambda-microvm.${REGION}.on.aws`;
      vms.set(id, { state: "RUNNING", endpoint });
      await store.put(ID, { deploymentId: ID, microvmId: id, endpoint, createdAtMs: 0, ...over });
    },
  };
}

const bundle = {
  gitBundle: Buffer.from("bundle"),
  allPaths: ["server.js"],
  changedPaths: ["server.js"],
  deletedPaths: [],
};
const tarRead = (bytes: string) => (p: string) =>
  p.startsWith("/tmp/qm-data-") ? Buffer.from(bytes).toString("base64") : "";

test("apply: launches a MicroVM, writes the snapshot into /app, starts the app, returns a TLS endpoint", async () => {
  const { counts, execs, writes, apply } = rig({ name: "mysite" });
  const endpoint = await apply(version(localSnapshot("index.html", "<h1>hi</h1>")));

  assert.equal(counts.run, 1, "one MicroVM launched");
  assert.match(endpoint.host, /^mvm-1\.lambda-microvm\.us-west-2\.on\.aws$/);
  assert.equal(endpoint.port, 443);
  assert.equal(endpoint.tls, true, "the MicroVM endpoint is dialed over TLS");
  assert.equal(endpoint.httpVersion, "2", "MicroVM ingress requests share a multiplexed HTTP/2 session");
  assert.equal(
    endpoint.proxyHeaders?.["X-aws-proxy-port"],
    "8081",
    "ingress forwards to the app port, not the daemon port",
  );
  assert.match(endpoint.proxyHeaders?.["X-aws-proxy-auth"] ?? "", /^tok-mvm-1-/);
  assert.equal(endpoint.publicUrl, "https://mysite.apps.example.com/", "the public URL is bare, never a token");
  assert.ok(written(writes, "/app/index.html"), "snapshot file written into /app");
  assert.ok(written(writes, "/app/.qm-ready"), "ready marker written");
  assert.ok(
    execs.some((c) => c.includes("setsid") && c.includes("PORT=8081") && c.includes("node server.js")),
    "app started on its own port, detached",
  );
});

test("apply: env framework keys are authoritative — PORT/HOME are set by the runtime, published env still applies", async () => {
  const { execs, apply } = rig();
  await apply(
    version(localSnapshot("server.js", "x"), { env: { HOME: "/tmp/evil", PORT: "3000", API_KEY: "secret" } }),
  );
  const start = execs.find((c) => c.includes("setsid"))!;
  assert.ok(start.includes("export HOME='/root'"), "HOME points at the resident-auth root");
  assert.ok(start.includes("export PORT=8081"), "PORT is the framework app port");
  assert.ok(start.includes("export API_KEY='secret'"), "published env still applies");
});

test("reconcile (git bundle): checks the commit out via git, writes home, no file-by-file app writes", async () => {
  const { execs, writes, p, d } = rig({ name: "mysite" });
  const endpoint = await p.reconcile!(
    d,
    version(localSnapshot(".aws/credentials", "[default]"), {
      commit: "a".repeat(40),
      homeDir: localSnapshot(".ssh/id", "KEY"),
    }),
    bundle,
  );
  assert.ok(
    execs.some((c) => c.includes("git fetch --force") && c.includes("refs/deploy-commits/")),
    "app tree pulled from the git bundle",
  );
  assert.ok(!written(writes, "/app/server.js"), "app files are not written one-by-one when a bundle is present");
  assert.ok(written(writes, "/root/.ssh/id"), "resident-auth home written into /root");
  assert.equal(endpoint.publicUrl, "https://mysite.apps.example.com/", "the URL carries no capability token");
});

test("reconcile (relaunch): a missing ephemeral snapshot/home dir is tolerated — app restored from the git bundle, no ENOENT", async () => {
  const { execs, p, d } = rig();
  const ver = version("/data/deployments/does-not-exist", {
    commit: "a".repeat(40),
    homeDir: "/data/deployments/also-gone",
  });
  const endpoint = await p.reconcile!(d, ver, bundle);
  assert.equal(endpoint.tls, true, "endpoint returned despite the missing local dirs");
  assert.ok(
    execs.some((c) => c.includes("git fetch --force")),
    "app tree restored from the git bundle",
  );
});

test("resolveEndpoint (warm): a running, fresh body is reused with no relaunch, and reaches within the cache window skip the control plane", async () => {
  const { counts, apply, resolve } = rig();
  const first = await apply();
  const runsAfterApply = counts.run;

  const resolved = await resolve();
  assert.ok(resolved, "warm body resolves");
  assert.equal(counts.run, runsAfterApply, "no new MicroVM launched on a warm reach");
  assert.equal(resolved!.host, first.host, "same body endpoint");
  assert.equal(resolved!.tls, true);

  const describesAfterFirst = counts.describe;
  const again = await resolve();
  assert.ok(again, "cached resolve still serves the endpoint");
  assert.equal(again!.host, resolved!.host);
  assert.equal(counts.describe, describesAfterFirst, "a fresh verdict is reused without re-asking the control plane");
});

test("resolveEndpoint (suspended): resumes the body and serves it warm", async () => {
  const { counts, vms, store, apply, resolve } = rig();
  await apply();
  vms.get((await store.get(ID))!.microvmId)!.state = "SUSPENDED";

  const resolved = await resolve();
  assert.ok(resolved, "suspended body resolves after resume");
  assert.equal(counts.resume, 1, "the suspended body was resumed");
  assert.equal(counts.run, 1, "no relaunch — same body");
});

test("resolveEndpoint: concurrent misses coalesce into one control-plane pass", async () => {
  const { counts, apply, resolve } = rig();
  await apply();
  const describesAfterApply = counts.describe;

  const [a, b, c] = await Promise.all([resolve(), resolve(), resolve()]);
  assert.ok(a && b && c);
  assert.equal(
    counts.describe,
    describesAfterApply + 2,
    "three simultaneous misses share one tryGet + one ensureRunning describe",
  );
});

for (const { status, message, getToo } of [
  { status: 502, message: "bad gateway", getToo: true },
  { status: 429, message: "throttled", getToo: false },
]) {
  test(`resolveEndpoint: a control-plane ${status} serves the stored endpoint rather than failing the reach`, async () => {
    const { api, store, apply, resolve } = rig();
    await apply();
    const stored = (await store.get(ID))!;
    api.tryGetMicrovm = async () => {
      throw new AwsApiError(message, status);
    };
    if (getToo)
      api.getMicrovm = async () => {
        throw new AwsApiError(message, status);
      };

    const resolved = await resolve();
    assert.ok(resolved, "a control-plane flap must not kill the reach");
    assert.equal(resolved!.host, stored.endpoint, "the stored body endpoint is served optimistically");
  });
}

test("resolveEndpoint: a resolve racing a body swap neither caches the old endpoint nor drops the new pointer", async () => {
  const { api, vms, store, apply, resolve } = rig();
  await apply();
  const first = (await store.get(ID))!;

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const realTryGet = api.tryGetMicrovm.bind(api);
  let stalls = 1;
  api.tryGetMicrovm = async (id) => {
    if (stalls-- > 0) await gate;
    return realTryGet(id);
  };

  const racing = resolve();
  vms.get(first.microvmId)!.state = "TERMINATED";
  await apply(version(localSnapshot("a", "2")));
  const fresh = (await store.get(ID))!;
  assert.notEqual(fresh.microvmId, first.microvmId, "the swap launched a replacement body");
  release();
  await racing;

  assert.ok(await store.get(ID), "the stale resolve must not drop the replacement body's pointer");
  const resolved = await resolve();
  assert.equal(resolved!.host, fresh.endpoint, "reaches after the swap serve the replacement body");
});

test("resolveEndpoint: destroy invalidates a hot resolve cache", async () => {
  const { p, d, apply, resolve } = rig();
  await apply();
  assert.ok(await resolve(), "resolve populates the cache");

  await p.destroy(d);
  assert.equal(await resolve(), null, "a destroyed deployment must not serve a cached endpoint");
});

test("resolveEndpoint (gone): a terminated body returns null (signal to re-apply) and clears the pointer", async () => {
  const { vms, store, apply, resolve } = rig();
  await apply();
  vms.get((await store.get(ID))!.microvmId)!.state = "TERMINATED";

  assert.equal(await resolve(), null, "a dead body resolves to null so the caller re-applies from git");
  assert.equal(await store.get(ID), null, "the dead body pointer is cleared");
});

test("resolveEndpoint (near the 8h cap): a stale-but-alive body returns null so the caller rotates to a fresh one", async () => {
  const { seedBody, resolve } = rig();
  await seedBody();
  assert.equal(await resolve(), null, "a body past the rotate window resolves to null");
});

const readinessProbe = (cmd: string): boolean => cmd.includes("127.0.0.1:8081") && cmd.includes("exit 1");

test("apply: an app that never binds its port fails the deploy instead of publishing a dead endpoint", async () => {
  const { apply } = rig({ daemon: { execCode: (cmd) => (readinessProbe(cmd) ? 1 : 0) } });
  await assert.rejects(
    () => apply(),
    /never listened on port 8081/,
    "a silent bind failure surfaces as a failed apply, not a running deployment",
  );
});

test("apply: a failed readiness probe reports the entrypoint's own output as the reason", async () => {
  const crash = "Error: ENOENT: no such file or directory, open '/app/dist/index.html'";
  const { apply } = rig({
    daemon: {
      execCode: (cmd) => (readinessProbe(cmd) ? 1 : 0),
      execStdout: (cmd) => (cmd.includes("/tmp/qm-app.log") ? crash : ""),
    },
  });
  await assert.rejects(
    () => apply(),
    (e: Error) => e.message.includes(crash),
    "the app log is the only record of why it died, so the failure carries it",
  );
});

const appStartScript = (cmd: string): boolean => cmd.includes("setsid sh -c") && cmd.includes("/tmp/qm-app.pid");

test("apply: a port still held by a process the PID file lost fails the deploy — it never publishes on top of it", async () => {
  const { execs, apply } = rig({ daemon: { execCode: (cmd) => (appStartScript(cmd) ? 97 : 0) } });
  await assert.rejects(
    () => apply(),
    /still held by a process this body cannot account for/,
    "a restart that could not happen must fail, never report success on the old process's reply",
  );
  const start = execs.find(appStartScript)!;
  assert.match(start, /exit 97/, "the start script refuses to launch while the port is still answering");
  assert.ok(
    start.indexOf("exit 97") < start.indexOf("setsid sh -c"),
    "the port-free gate runs before the new process is launched",
  );
});

test("reconcile: a reused body whose port stays held fails the deploy — it never lands on stale code", async () => {
  let wedged = false;
  const { p, d, apply } = rig({
    daemon: { execCode: (cmd, url) => (wedged && appStartScript(cmd) && url.includes("mvm-1") ? 97 : 0) },
  });
  await apply(version(localSnapshot("a", "v1")));

  wedged = true;
  await assert.rejects(
    () =>
      p.reconcile!(d, version(localSnapshot("a", "v2"), { version: 2 }), {
        changedPaths: ["a"],
        deletedPaths: [],
        allPaths: ["a"],
      }),
    /still held by a process this body cannot account for/,
    "a body already running the old code must not be reported as carrying the new version",
  );
});

test("apply: the readiness gate fails when the launched process dies instead of accepting whatever holds the port", async () => {
  const { execs, apply } = rig({ daemon: { execCode: (cmd) => (readinessProbe(cmd) ? 98 : 0) } });
  await assert.rejects(() => apply(), /entrypoint exited without binding port 8081/);
  assert.match(
    execs.find(readinessProbe)!,
    /kill -0 -"\$pid"/,
    "readiness tracks the process this deploy launched, not just the port",
  );
});

test("profile: scale-to-zero is platform-managed, reconcile is in place, and dataDir is advertised only when persistence is wired", () => {
  const plain = rig().p.profile;
  assert.equal(plain.managedScaleToZero, true);
  assert.equal(plain.inPlaceReconcile, true);
  assert.equal(plain.dataDir, undefined, "no bucket → no durable-data contract");
  assert.equal(rig({ data: "tar" }).p.profile.dataDir, "/data");
});

test("app data: a fresh body hydrates /data from the S3 snapshot before the app starts", async () => {
  const { execs, writes, objects, apply } = rig({
    data: "tar",
    objects: new Map([[`deploy-data/${ID}.tar`, Buffer.from("TARBYTES")]]),
  });
  await apply();

  assert.ok(
    writes.some((w) => w.path.startsWith("/tmp/qm-data-")),
    "snapshot tar shipped into the body",
  );
  const extractAt = execs.findIndex((c) => c.includes("tar -xf") && c.includes("/data"));
  const startAt = execs.findIndex((c) => c.includes("setsid"));
  assert.ok(extractAt >= 0, "snapshot extracted into /data");
  assert.ok(extractAt < startAt, "hydrate happens before the app starts");
  assert.ok(
    execs.some((c) => c.includes("export DATA_DIR='/data'")),
    "app is told where durable state lives",
  );
  assert.equal(objects.size, 1, "snapshot untouched by hydrate");
});

test("app data: rotating a body past the 8h window snapshots /data to S3 before terminating it", async () => {
  const { counts, objects, seedBody, apply } = rig({ data: "tar", daemon: { readB64: tarRead("NEWTAR") } });
  await seedBody();

  await apply();
  assert.equal(counts.terminate, 1, "stale body terminated");
  assert.deepEqual(
    Buffer.from(objects.get(`deploy-data/${ID}.tar`)!).toString(),
    "NEWTAR",
    "its /data landed in S3 first",
  );
});

for (const { label, code, exit } of [
  { label: "an empty /data is never uploaded — a fresh body can't clobber a good snapshot", code: "exit 3", exit: 3 },
  { label: "an over-cap /data is skipped loudly, never uploaded or thrown", code: "wc -c", exit: 4 },
]) {
  test(`app data: ${label}`, async () => {
    const { calls, seedBody, apply } = rig({
      data: "tar",
      daemon: { execCode: (cmd) => (cmd.includes(code) ? exit : 0) },
      objects: new Map([[`deploy-data/${ID}.tar`, Buffer.from("PRECIOUS")]]),
    });
    await seedBody();
    await apply();
    assert.ok(!calls.some((c) => c.startsWith("PutObjectCommand")), "no upload for an empty or oversized /data");
  });
}

test("app data: a warm reach past the snapshot interval snapshots /data and stamps the pointer", async () => {
  const { store, objects, apply, resolve } = rig({
    data: "tar",
    daemon: { readB64: tarRead("LIVE") },
    extra: { snapshotIntervalMs: 0 },
  });
  await apply();
  const before = (await store.get(ID))!.lastSnapshotMs!;

  await new Promise((r) => setTimeout(r, 5));
  await resolve();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    (await store.get(ID))!.lastSnapshotMs! > before,
    "pointer stamped so concurrent reaches don't stack snapshots",
  );
  assert.ok(objects.has(`deploy-data/${ID}.tar`), "the reach-path snapshot landed in S3");
});

test("app data: a failed rotate snapshot defers the rotation — the stale body keeps serving instead of losing its /data", async () => {
  const { counts, seedBody, apply } = rig({ data: "tar" });
  await seedBody();

  const e = await apply();
  assert.equal(counts.terminate, 0, "the stale body is not terminated when its data can't be saved");
  assert.equal(counts.run, 0, "no replacement launched");
  assert.equal(e.host, "mvm-old.lambda-microvm.us-west-2.on.aws", "the stale body keeps serving");
});

test("app data: a failed hydrate terminates the fresh body instead of leaking it", async () => {
  const { counts, apply } = rig({
    data: "tar",
    daemon: { execCode: (cmd) => (cmd.includes("tar -xf") ? 1 : 0) },
    objects: new Map([[`deploy-data/${ID}.tar`, Buffer.from("TAR")]]),
  });
  await assert.rejects(apply(), /hydrate extract failed/);
  assert.equal(counts.terminate, 1, "the un-pointered body is terminated, not leaked to the 8h cap");
});

test("app data: a deferred rotation serves the stale body from resolveEndpoint instead of forcing re-apply per reach", async () => {
  const { counts, store, seedBody, apply, resolve } = rig({ data: "tar" });
  await seedBody("mvm-old", { lastSnapshotMs: Date.now() });

  await apply();
  assert.ok((await store.get(ID))!.rotateNotBeforeMs! > Date.now(), "deferral stamped");
  assert.ok(await resolve(), "stale-but-deferred body keeps serving");
  assert.equal(counts.run, 0, "no replacement launched during the deferral");
});

test("litestream: rotate snapshot and hydrate exclude the shadow-WAL dir, the tar never owns app.db, and a legacy tar'd app.db is diverted", async () => {
  const { execs, seedBody, apply } = rig({
    data: "litestream",
    daemon: { readB64: tarRead("T") },
    objects: new Map([[`deploy-data/${ID}.tar`, Buffer.from("LEGACY-TAR-WITH-DB")]]),
  });
  await seedBody();
  await apply();
  const snap = execs.find((c) => c.includes("tar -cf") && c.includes("--exclude"));
  const extract = execs.find((c) => c.includes("tar -xf"));
  assert.ok(snap, "rotate snapshot ran with exclusions");
  assert.ok(snap!.includes("--exclude='./.app.db-litestream'"), "snapshot excludes the shadow dir");
  assert.ok(extract!.includes("--exclude='./.app.db-litestream'"), "hydrate excludes the shadow dir");
  assert.ok(
    snap!.includes("--exclude='./app.db'") && snap!.includes("--exclude='./app.db-*'"),
    "app.db and its journals excluded from the tar",
  );
  assert.ok(
    extract!.includes("app.db.tar-fallback"),
    "tar'd app.db diverted to the fallback path, never extracted in place",
  );
  assert.ok(
    extract!.includes("app.db.tar-fallback-wal"),
    "WAL journal diverted alongside the db — committed writes must travel with it",
  );
});

test("litestream: the start script verifies replica auth and daemon liveness, and finds replicators by what they are running", async () => {
  const { execs, apply } = rig({ data: "litestream" });
  await apply();
  const start = execs.find((c) => c.includes("litestream replicate"))!;
  assert.ok(
    start.includes("litestream snapshots") && start.includes("exit 23"),
    "S3 reach/auth verified before the replica is trusted",
  );
  assert.ok(start.includes("/proc/") && start.includes("exit 22"), "daemon liveness verified after start");
  assert.ok(start.includes('"$p/cmdline"'), "survivors are discovered by what they are running, not a pid file");
  assert.match(start, /litestream\|\*\/litestream/, "argv[0] identifies a replicator and never the reaping shell");
  assert.ok(
    start.indexOf("kill -TERM") < start.indexOf("litestream replicate -config"),
    "every running replicator is reaped before a new one starts",
  );
  assert.match(start, /ls_pids \| wc -l/, "exactly one replicator may be running once the script returns");
  assert.ok(
    start.indexOf("exit 25") < start.indexOf("litestream replicate -config"),
    "a survivor that outlived SIGKILL aborts before a second replicator can start on the same replica",
  );
  for (const cmd of execs) {
    assert.ok(!cmd.includes("qm-litestream.pid"), "no path a rename can orphan decides who is replicating");
  }
});

test("every script the provider hands the exec daemon parses under the shell that will run it", async () => {
  const { execs, apply } = rig({ data: "litestream" });
  await apply();
  assert.ok(execs.length > 0, "the apply emitted scripts to check");
  const shell = spawnSync("/bin/bash", ["-c", "true"]).status === 0 ? "/bin/bash" : "/bin/sh";
  for (const cmd of execs) {
    const parsed = spawnSync(shell, ["-n"], { input: cmd, encoding: "utf8" });
    assert.equal(parsed.status, 0, `unparseable script: ${parsed.stderr}\n${cmd}`);
  }
});

test("litestream: a failed start un-pointers and terminates the body so reaches can't hit a dead app", async () => {
  const { counts, store, apply } = rig({
    data: "litestream",
    daemon: { execCode: (cmd) => (cmd.includes("litestream replicate") ? 22 : 0) },
  });
  await assert.rejects(apply(), /litestream start failed/);
  assert.equal(await store.get(ID), null, "pointer cleared");
  assert.equal(counts.terminate, 1, "body terminated");
});

test("litestream: a failed restore aborts materialize instead of starting the app on an empty db", async () => {
  const { apply } = rig({
    data: "litestream",
    daemon: { execCode: (cmd) => (cmd.includes("litestream restore") ? 21 : 0) },
  });
  await assert.rejects(apply(), /litestream start failed \(code 21\)/);
});

test("app data: destroy tears down the runtime but preserves durable data — archive → restore round-trips", async () => {
  const { counts, store, objects, p, d, apply } = rig({
    data: "litestream",
    objects: new Map([
      [`deploy-data/${ID}.tar`, Buffer.from("X")],
      [`deploy-data/${ID}/litestream/generations/x/wal/0.wal.lz4`, Buffer.from("W")],
    ]),
  });
  await apply();
  await p.destroy(d);
  assert.equal(counts.terminate, 1, "runtime torn down");
  assert.equal(await store.get(ID), null, "pointer cleared");
  assert.equal(objects.size, 2, "tar and replica both survive destroy");
});

test("litestream: apply stages prefix-scoped creds + config, restores before the app starts, stamps the pointer", async () => {
  const { execs, writes, assumes, store, apply } = rig({ data: "litestream" });
  await apply();

  assert.equal(assumes.length, 1);
  assert.equal(assumes[0]!.role, "arn:aws:iam::1:role/data");
  assert.ok(
    assumes[0]!.policy.includes(`deploy-data/${ID}/litestream/*`),
    "session policy pinned to this app's replica prefix",
  );
  assert.ok(written(writes, "/etc/qm-litestream.env"), "creds staged");
  const cfg = writes.find((w) => w.path === "/etc/qm-litestream.yml");
  assert.ok(
    Buffer.from(cfg!.b64, "base64").toString().includes(`path: deploy-data/${ID}/litestream`),
    "replica path in config",
  );
  const restoreAt = execs.findIndex((c) => c.includes("litestream restore"));
  const appAt = execs.findIndex((c) => c.includes("node server.js"));
  assert.ok(restoreAt >= 0 && restoreAt < appAt, "restore runs before the app starts");
  assert.ok(execs[restoreAt]!.includes("-if-db-not-exists"), "an existing live db is never clobbered by the replica");
  assert.ok((await store.get(ID))!.dataCredsAtMs! > 0, "cred mint time stamped for the reach-path refresh");
});

test("litestream: a warm reach with stale creds re-mints and bounces litestream", async () => {
  const { execs, assumes, store, apply, resolve } = rig({ data: "litestream" });
  await apply();
  await store.put(ID, { ...(await store.get(ID))!, dataCredsAtMs: 1, lastSnapshotMs: Date.now() });

  const before = execs.length;
  await resolve();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(assumes.length, 2, "fresh creds minted on the reach path");
  assert.ok(
    execs.slice(before).some((c) => c.includes("litestream replicate")),
    "litestream bounced onto the new creds",
  );
});

for (const { label, code, probe } of [
  { label: "a reused body on a binary-less image is marked for rotation", code: 24, probe: "command -v litestream" },
  {
    label: "a reused body's failed refresh (non-24) defers rotation with an STS backoff",
    code: 22,
    probe: "litestream replicate",
  },
]) {
  test(`litestream: ${label}, and the serving body is never terminated`, async () => {
    const { counts, store, seedBody, apply } = rig({
      data: "litestream",
      daemon: {
        execCode: (cmd) => (cmd.includes(probe) ? code : 0),
      },
    });
    await seedBody("mvm-live", { createdAtMs: Date.now() });

    await assert.rejects(apply(), code === 24 ? /binaries missing/ : /litestream start failed/);
    assert.equal(counts.terminate, 0, "the serving body is not terminated");
    const cur = (await store.get(ID))!;
    if (code === 24) {
      assert.equal(cur.microvmId, "mvm-live", "pointer intact");
      assert.equal(cur.createdAtMs, 0, "marked stale so the next touch rotates onto the current image");
      return;
    }
    assert.ok(cur.rotateNotBeforeMs! > Date.now(), "rotation backed off");
    const nextRetryMs = cur.dataCredsAtMs! + 45 * 60_000 - Date.now();
    assert.ok(
      nextRetryMs > 0 && nextRetryMs < 2 * 60_000,
      "replicator re-bounce scheduled soon but NOT per-reach (STS backoff)",
    );
  });
}

test("app data: $DATA_DIR is only advertised to the app when persistence is actually wired", async () => {
  const off = rig();
  await off.apply();
  assert.ok(!off.execs.some((c) => c.includes("export DATA_DIR")), "no bucket → no $DATA_DIR promise");

  const on = rig({ data: "tar" });
  await on.apply();
  assert.ok(
    on.execs.some((c) => c.includes("export DATA_DIR='/data'")),
    "bucket configured → $DATA_DIR exported",
  );
});
