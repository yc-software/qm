import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAwsDeployProvider, type StoredDeployBody } from "../src/deploy/aws-deploy-provider.ts";
import { createMicrovmApi, vmFetch } from "../src/sandbox/aws-microvm-api.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import { swallow } from "../src/util/errors.ts";
import { scopeId } from "../src/types.ts";
import { loadConfig } from "../src/config.ts";

const { awsDeploy } = loadConfig();
const region = awsDeploy.region;
const agentPort = awsDeploy.agentPort ?? 8080;
const appPort = awsDeploy.appPort ?? 8081;

const api = createMicrovmApi({ region, ...(awsDeploy.profile ? { profile: awsDeploy.profile } : {}) });
const store = createMemoryMap<StoredDeployBody>();
const provider = createAwsDeployProvider({ ...awsDeploy, store });

function makeVersion(v: number): DeploymentVersion {
  const snapshotDir = mkdtempSync(join(tmpdir(), `aws-deploy-app-v${v}-`));
  writeFileSync(
    join(snapshotDir, "server.js"),
    `const http=require('http');http.createServer((_q,r)=>r.end('SERVE-OK v${v}')).listen(process.env.PORT||8081);`,
  );
  const homeDir = mkdtempSync(join(tmpdir(), `aws-deploy-home-v${v}-`));
  mkdirSync(join(homeDir, ".aws"), { recursive: true });
  writeFileSync(
    join(homeDir, ".aws", "credentials"),
    "[default]\naws_access_key_id=AKIA-SMOKE\naws_secret_access_key=smoke-secret\n",
  );
  return { version: v, createdAt: 0, entrypoint: "node server.js", snapshotDir, homeDir, env: { SMOKE: "1" } };
}

const d: Deployment = {
  id: randomUUID(),
  ownerScopeId: scopeId("personal", `smoke-${randomUUID().slice(0, 8)}`),
  createdBy: "smoke",
  name: `smoke-${randomUUID().slice(0, 8)}`,
  currentVersion: 1,
  status: "stopped",
  endpoint: null,
  versions: [],
};

async function bodyId(): Promise<string> {
  const stored = await store.get(d.id);
  if (!stored) throw new Error("no body pointer for the deployment");
  return stored.microvmId;
}

async function serveBody(host: string, token: string): Promise<string> {
  const r = await vmFetch(host, token, "/", { method: "GET", port: appPort });
  return r.text;
}

async function execOnBody(host: string, cmd: string): Promise<string> {
  const token = await api.createAuthToken(await bodyId(), 10);
  const r = await vmFetch(host, token, "/exec", { method: "POST", body: { cmd, timeoutSec: 20 }, port: agentPort });
  return (JSON.parse(r.text) as { stdout: string }).stdout;
}

async function main(): Promise<void> {
  console.log("apply v1 (launch MicroVM + git-less file write + start app) …");
  const e1 = await provider.apply(d, makeVersion(1));
  console.log("  endpoint:", e1);
  if (!e1.tls || e1.proxyHeaders?.["X-aws-proxy-port"] !== String(appPort))
    throw new Error("endpoint is not a TLS app-port endpoint");

  console.log("probing serve via ingress + injected ~/.aws …");
  const served1 = await serveBody(e1.host, e1.proxyHeaders!["X-aws-proxy-auth"]!);
  const creds = await execOnBody(e1.host, "test -s /root/.aws/credentials && echo AWS-CREDS-PRESENT");
  console.log("  serve:", JSON.stringify(served1.trim()), "creds:", JSON.stringify(creds.trim()));
  if (!served1.includes("SERVE-OK v1")) throw new Error(`v1 did not serve: ${served1}`);
  if (!creds.includes("AWS-CREDS-PRESENT")) throw new Error("resident ~/.aws not injected");

  console.log("suspending the body, then resolveEndpoint (must resume it warm) …");
  await api.suspend(await bodyId());
  const warm = await provider.resolveEndpoint!(d, makeVersion(1));
  if (!warm) throw new Error("resolveEndpoint returned null for a suspended body (expected a warm resume)");
  if (warm.host !== e1.host) throw new Error(`endpoint changed on warm resume: ${e1.host} → ${warm.host}`);
  const served1b = await serveBody(warm.host, warm.proxyHeaders!["X-aws-proxy-auth"]!);
  if (!served1b.includes("SERVE-OK v1")) throw new Error(`resumed body did not serve: ${served1b}`);

  console.log("redeploy v2 (reuse the body, re-materialize, restart) …");
  const e2 = await provider.apply(d, makeVersion(2));
  if (e2.host !== e1.host) throw new Error(`endpoint changed across redeploy: ${e1.host} → ${e2.host}`);
  const served2 = await serveBody(e2.host, e2.proxyHeaders!["X-aws-proxy-auth"]!);
  console.log("  serve:", JSON.stringify(served2.trim()));
  if (!served2.includes("SERVE-OK v2")) throw new Error(`v2 did not serve: ${served2}`);

  console.log("destroying deployment …");
  const finalId = await bodyId();
  await provider.destroy(d);
  let terminal = false;
  for (let i = 0; i < 15 && !terminal; i++) {
    const g = await api.tryGetMicrovm(finalId);
    terminal = !g || g.state === "TERMINATED" || g.state === "TERMINATING";
    if (!terminal) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!terminal) throw new Error("body did not begin terminating after destroy");

  console.log("\naws-deploy-smoke PASSED ✓");
}

main().catch(async (e) => {
  console.error("\naws-deploy-smoke FAILED:", e);
  try {
    await provider.destroy(d);
  } catch (err) {
    swallow("aws-deploy-smoke: cleanup destroy", err);
  }
  process.exit(1);
});
