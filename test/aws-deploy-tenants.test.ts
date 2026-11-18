import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { StoredDeployBody } from "../src/deploy/aws-deploy-provider.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { boundTenant, withTenant, withoutTenant } from "../src/tenants/context.ts";
import {
  ID,
  publishedApp,
  fakeApi,
  fakeDaemon,
  fakeS3,
  localSnapshot,
  provider,
  version,
} from "./support/aws-deploy-fakes.ts";
import { tenantMap } from "./support/tenant-map.ts";

const A = randomUUID();
const B = randomUUID();

before(() => bindBootTenant(async () => undefined));

const hydrated = (writes: Array<{ path: string }>): boolean => writes.some((w) => w.path.startsWith("/tmp/qm-data-"));

test("app data on a shared host: each tenant reads only its own snapshot, never a shared key", async () => {
  const { s3 } = fakeS3(
    new Map([
      [`deploy-data/${A}/${ID}.tar`, Buffer.from("A")],
      [`deploy-data/${ID}.tar`, Buffer.from("SHARED")],
    ]),
  );
  const { api } = fakeApi();
  const a = fakeDaemon();
  const b = fakeDaemon();
  const store = tenantMap<StoredDeployBody>();
  const pa = provider(api, a.fetchImpl, store, { dataBucket: "bkt", s3 });
  const pb = provider(api, b.fetchImpl, store, { dataBucket: "bkt", s3 });
  await withTenant(A, () => pa.apply(publishedApp(ID), version(localSnapshot("a", "1"))));
  await withTenant(B, () => pb.apply(publishedApp(ID), version(localSnapshot("a", "1"))));
  assert.equal(hydrated(a.writes), true, "tenant A restores its own data");
  assert.equal(hydrated(b.writes), false, "tenant B sees neither A's data nor the shared key");
});

test("app data on a shared host: snapshots land under the tenant's own key", async () => {
  const { api, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon({
    readB64: (p) => (p.startsWith("/tmp/qm-data-") ? Buffer.from(`${boundTenant()}`).toString("base64") : ""),
  });
  const { s3, objects } = fakeS3();
  const store = tenantMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3 });
  for (const tenant of [A, B]) {
    vms.set(`mvm-${tenant}`, { state: "RUNNING", endpoint: `mvm-${tenant}.lambda-microvm.us-west-2.on.aws` });
    await withTenant(tenant, async () => {
      await store.put(ID, {
        deploymentId: ID,
        microvmId: `mvm-${tenant}`,
        endpoint: `mvm-${tenant}.lambda-microvm.us-west-2.on.aws`,
        createdAtMs: 0,
      });
      await p.apply(publishedApp(ID), version(localSnapshot("a", "1")));
    });
  }
  assert.deepEqual([...objects.keys()].sort(), [`deploy-data/${A}/${ID}.tar`, `deploy-data/${B}/${ID}.tar`].sort());
  assert.equal(Buffer.from(objects.get(`deploy-data/${A}/${ID}.tar`)!).toString(), A);
  assert.equal(Buffer.from(objects.get(`deploy-data/${B}/${ID}.tar`)!).toString(), B);
});

test("app data on a shared host: no bound tenant means no data access", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const { s3, calls } = fakeS3();
  const p = provider(api, fetchImpl, undefined, { dataBucket: "bkt", s3 });
  await withoutTenant(() => assert.rejects(p.apply(publishedApp(ID), version(localSnapshot("a", "1")))));
  assert.deepEqual(calls, []);
});

test("endpoints on a shared host: one tenant's cached app endpoint never answers for another's", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const store = tenantMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store);
  const d = publishedApp(ID);
  const first = await withTenant(A, () => p.apply(d, version(localSnapshot("a", "1"))));
  await withTenant(A, () => p.resolveEndpoint!(d, version("/unused")));
  const second = await withTenant(B, () => p.apply(d, version(localSnapshot("a", "1"))));
  assert.notEqual(first.host, second.host);
  const resolvedA = await withTenant(A, () => p.resolveEndpoint!(d, version("/unused")));
  const resolvedB = await withTenant(B, () => p.resolveEndpoint!(d, version("/unused")));
  assert.equal(resolvedA!.host, first.host);
  assert.equal(resolvedB!.host, second.host);
});
