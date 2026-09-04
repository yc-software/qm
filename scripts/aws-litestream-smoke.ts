#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createAwsDeployProvider, type StoredDeployBody } from "../src/deploy/aws-deploy-provider.ts";
import { createMicrovmApi, createMicrovmClient } from "../src/sandbox/aws-microvm-api.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import { loadConfig } from "../src/config.ts";
import { sleep } from "../src/util/async.ts";
import { scopeId } from "../src/types.ts";

const { awsDeploy } = loadConfig();
if (!awsDeploy.dataBucket || !awsDeploy.dataRoleArn)
  throw new Error("set AWS_DEPLOY_DATA_BUCKET + AWS_DEPLOY_DATA_ROLE_ARN");
const log = (...a: unknown[]) => console.log("[ls-smoke]", ...a);

const api = createMicrovmApi({
  region: awsDeploy.region,
  ...(awsDeploy.profile ? { profile: awsDeploy.profile } : {}),
});
const client = createMicrovmClient(api, { agentPort: awsDeploy.agentPort ?? 8080, tokenTtlMinutes: 30 });
const store = createMemoryMap<StoredDeployBody>();
const provider = createAwsDeployProvider({ ...awsDeploy, store, api });
const s3 = new S3Client({ region: awsDeploy.region, ...(awsDeploy.profile ? { profile: awsDeploy.profile } : {}) });

const APP = `
const { DatabaseSync } = require('node:sqlite');
const http = require('http');
const db = new DatabaseSync(process.env.DATA_DIR + '/app.db');
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, note TEXT)');
http.createServer((req, res) => {
  if (req.method === 'POST') { db.prepare('INSERT INTO rows (note) VALUES (?)').run(String(Date.now())); return res.end('added'); }
  res.end('count=' + db.prepare('SELECT COUNT(*) AS n FROM rows').get().n);
}).listen(process.env.PORT || 8081);
`;

function makeVersion(): DeploymentVersion {
  const snapshotDir = mkdtempSync(join(tmpdir(), "ls-smoke-app-"));
  writeFileSync(join(snapshotDir, "server.js"), APP);
  return { version: 1, createdAt: 0, entrypoint: "node server.js", snapshotDir };
}

const d: Deployment = {
  id: randomUUID(),
  ownerScopeId: scopeId("personal", "ls-smoke"),
  createdBy: "ls-smoke",
  name: `ls-smoke-${randomUUID().slice(0, 8)}`,
  currentVersion: 1,
  status: "stopped",
  endpoint: null,
  versions: [],
};

async function appCurl(args: string): Promise<string> {
  const stored = (await store.get(d.id))!;
  const r = await client.execRaw(stored.microvmId, stored.endpoint, `curl -s ${args} http://127.0.0.1:8081/`, 30);
  if (r.code !== 0) throw new Error(`in-vm curl failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function main(): Promise<void> {
  log("deployment", d.id, "→ apply v1");
  await provider.apply(d, makeVersion());
  const body1 = (await store.get(d.id))!;
  log("body1 =", body1.microvmId);

  for (let i = 0; i < 5; i++) await appCurl("-X POST");
  assert.equal(await appCurl(""), "count=5", "5 rows written");
  log("5 rows in SQLite; waiting 5s for litestream to sync the WAL...");
  await sleep(5000);
  const ls = await client.execRaw(
    body1.microvmId,
    body1.endpoint,
    "tail -5 /tmp/qm-litestream.log; [ -d /proc/$(cat /tmp/qm-litestream.pid) ] && echo LS-ALIVE",
    30,
  );
  log("litestream:", ls.stdout.trim().split("\n").pop());
  assert.ok(ls.stdout.includes("LS-ALIVE"), "litestream running");

  log("hard-killing the body (no snapshot — simulating the 8h cap)...");
  await api.terminate(body1.microvmId);
  await sleep(3000);

  log("re-apply into a fresh body...");
  assert.equal(await provider.resolveEndpoint!(d, makeVersion()), null, "dead body resolves null");
  await provider.apply(d, makeVersion());
  const body2 = (await store.get(d.id))!;
  assert.notEqual(body2.microvmId, body1.microvmId, "fresh body launched");
  log("body2 =", body2.microvmId);

  const count = await appCurl("");
  log("after restore:", count);
  assert.equal(count, "count=5", "rows survived the crash via litestream restore");

  log("destroy + verify durable data SURVIVES (archive → restore must round-trip)...");
  await provider.destroy(d);
  const left = await s3.send(
    new ListObjectsV2Command({ Bucket: awsDeploy.dataBucket!, Prefix: `deploy-data/${d.id}` }),
  );
  assert.ok((left.KeyCount ?? 0) > 0, "replica survives destroy");
  const keys = (left.Contents ?? []).map((o) => ({ Key: o.Key! }));
  await s3.send(new DeleteObjectsCommand({ Bucket: awsDeploy.dataBucket!, Delete: { Objects: keys } }));
  log("PASS: litestream data survived a hard body kill; destroy preserved the replica (smoke cleaned it up)");
}

main().catch(async (e) => {
  console.error(e);
  const stored = await store.get(d.id);
  if (stored) await api.terminate(stored.microvmId).catch(() => {});
  process.exit(1);
});
