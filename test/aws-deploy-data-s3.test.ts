import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Sha256 } from "@aws-crypto/sha256-js";
import { after, before, test } from "node:test";
import { SignatureV4 } from "@smithy/signature-v4";
import type { StoredDeployBody } from "../src/deploy/aws-deploy-provider.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { withTenant } from "../src/tenants/context.ts";
import {
  ID,
  deployment,
  fakeApi,
  fakeDaemon,
  fakeS3,
  localSnapshot,
  provider,
  version,
  vmBucket,
} from "./support/aws-deploy-fakes.ts";
import { tenantMap } from "./support/tenant-map.ts";

const A = randomUUID();
const B = randomUUID();
const GIB = 1024 * 1024 * 1024;
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret-example" };
const OLD_HOST = "mvm-old.lambda-microvm.us-west-2.on.aws";

const savedEnv = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };

before(() => {
  bindBootTenant(async () => undefined);
  process.env.AWS_ACCESS_KEY_ID = CREDS.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = CREDS.secretAccessKey;
});

after(() => {
  for (const [name, value] of [
    ["AWS_ACCESS_KEY_ID", savedEnv.id],
    ["AWS_SECRET_ACCESS_KEY", savedEnv.secret],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function signatureFor(url: URL, path: string): Promise<string> {
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!k.startsWith("X-Amz-")) query[k] = v;
  const amzDate = url.searchParams.get("X-Amz-Date") ?? "";
  const signingDate = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13)}`,
  );
  const signer = new SignatureV4({
    credentials: CREDS,
    region: "us-west-2",
    service: "s3",
    sha256: Sha256,
    uriEscapePath: false,
    applyChecksum: false,
  });
  const signed = await signer.presign(
    {
      method: "PUT",
      protocol: "https:",
      hostname: url.hostname,
      path,
      query,
      headers: { host: url.hostname, "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" },
    },
    { signingDate, expiresIn: Number(url.searchParams.get("X-Amz-Expires")) },
  );
  return String(signed.query?.["X-Amz-Signature"]);
}

function staleBodyProvider(fetchImpl: typeof fetch, extra: Record<string, unknown>) {
  const { api, vms, counts } = fakeApi();
  const store = tenantMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", ...extra });
  vms.set("mvm-old", { state: "RUNNING", endpoint: OLD_HOST });
  const apply = (tenant: string) =>
    withTenant(tenant, async () => {
      await store.put(ID, { deploymentId: ID, microvmId: "mvm-old", endpoint: OLD_HOST, createdAtMs: 0 });
      return p.apply(deployment(ID), version(localSnapshot("a", "1")));
    });
  return { apply, vms, counts };
}

test("app data: a multi-GB /data moves VM to S3 and back without core ever holding the tar", async () => {
  const { s3, objects, calls } = fakeS3();
  const vm = vmBucket(objects, () => new Uint8Array(1));
  const { fetchImpl, reads, writes, execs } = fakeDaemon({ curl: vm.curl });
  const { apply, counts } = staleBodyProvider(fetchImpl, { s3 });
  const heapBefore = process.memoryUsage().heapUsed;
  await apply(A);

  assert.equal(counts.terminate, 1, "the old body recycled");
  assert.deepEqual(
    vm.transfers,
    [
      { method: "PUT", key: `deploy-data/${A}/${ID}.tar` },
      { method: "GET", key: `deploy-data/${A}/${ID}.tar` },
    ],
    "the old body uploads and the new body downloads, both straight to S3",
  );
  assert.deepEqual(reads, [], "core never reads a file back out of the VM");
  assert.ok(!writes.some((w) => w.path.startsWith("/tmp/qm-data-")), "core never pushes a tar into the VM");
  assert.deepEqual(
    calls.filter((c) => !c.startsWith("HeadObjectCommand")),
    [],
    "core only checks the snapshot exists; it never puts or gets the object",
  );
  const snap = execs.find((c) => c.includes("tar -cf"));
  assert.ok(snap?.includes(`-le ${2 * GIB} ]`), "the snapshot cap is 2 GiB");
  assert.ok(snap?.includes("X-Amz-Expires=3600"), "the upload URL lives an hour");
  assert.ok(process.memoryUsage().heapUsed - heapBefore < 64 * 1024 * 1024, "core memory stays flat");
});

test("app data: a failed upload keeps the previous snapshot and defers the recycle", async () => {
  const key = `deploy-data/${A}/${ID}.tar`;
  const { s3, objects } = fakeS3(new Map([[key, Buffer.from("PRECIOUS")]]));
  const { fetchImpl } = fakeDaemon({ curl: (_url, method) => (method === "PUT" ? 22 : 0) });
  const { apply, vms } = staleBodyProvider(fetchImpl, { s3 });
  const served = await apply(A);
  assert.equal(served.host, OLD_HOST, "the old body keeps serving");
  assert.equal(vms.get("mvm-old")?.state, "RUNNING", "and keeps its /data");
  assert.equal(Buffer.from(objects.get(key) ?? []).toString(), "PRECIOUS", "the previous snapshot is intact");
});

test("app data: a failed download aborts the fresh body before the app starts", async () => {
  const { s3 } = fakeS3(new Map([[`deploy-data/${A}/${ID}.tar`, Buffer.from("TAR")]]));
  const { fetchImpl, execs } = fakeDaemon({ curl: () => 22 });
  const { api, counts } = fakeApi();
  const p = provider(api, fetchImpl, tenantMap<StoredDeployBody>(), { dataBucket: "bkt", s3 });
  await assert.rejects(
    withTenant(A, () => p.apply(deployment(ID), version(localSnapshot("a", "1")))),
    /hydrate download failed/,
  );
  assert.equal(counts.terminate, 1, "the fresh body is terminated");
  assert.ok(!execs.some((c) => c.includes("setsid")), "the app never started on missing data");
});

test("app data: a signed snapshot URL for one tenant cannot address another tenant's key", async () => {
  const urls: string[] = [];
  const { fetchImpl } = fakeDaemon({
    curl: (url) => {
      urls.push(url);
      return 0;
    },
  });
  const { s3 } = fakeS3();
  await staleBodyProvider(fetchImpl, { s3, presign: undefined }).apply(A);
  const put = new URL(urls[0] ?? "");
  const ownPath = `/deploy-data/${A}/${ID}.tar`;
  const signature = put.searchParams.get("X-Amz-Signature");
  assert.equal(put.hostname, "bkt.s3.us-west-2.amazonaws.com");
  assert.equal(put.pathname, ownPath, "the URL names tenant A's own key");
  assert.equal(put.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.equal(put.searchParams.get("X-Amz-Expires"), "3600");
  assert.deepEqual(
    [...put.searchParams.keys()].filter((k) => /checksum/i.test(k)),
    [],
    "no empty-body checksum is baked into the upload URL",
  );
  assert.equal(await signatureFor(put, ownPath), signature, "the reference signer reproduces the signature");
  for (const other of [`/deploy-data/${B}/${ID}.tar`, `/deploy-data/${ID}.tar`, `/deploy-data/${B}/`]) {
    assert.notEqual(await signatureFor(put, other), signature, `the signature does not cover ${other}`);
  }
});
