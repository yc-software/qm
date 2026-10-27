import { S3Client } from "@aws-sdk/client-s3";
import { cols } from "../persistence/typed-table.ts";
import { STSClient } from "@aws-sdk/client-sts";
import { LRUCache } from "lru-cache";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { bytes, normalizeRelPath, posixJoin, readTree } from "./deploy-fs.ts";
import { AwsApiError, createMicrovmApi, createMicrovmClient, type AwsMicrovmApi } from "../sandbox/aws-microvm-api.ts";
import { deploymentKeyedTable, type DeployBodyStore } from "./deploy-body-store.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { execFailure, swallow, swallowAs } from "../util/errors.ts";
import {
  appEnv,
  appGone,
  appLaunch,
  appLogs,
  appReporter,
  exportEnv,
  listeningOn,
  STOP_APP,
  waitAppReady,
  type AppErrorSink,
} from "./shared-deploy-provider.ts";
import { tenant } from "../tenant.ts";
import {
  awsDataSnapshots,
  awsLitestreamOps,
  DATA_DIR,
  type AwsDataSnapshots,
  type AwsLitestreamOps,
} from "./aws-deploy-data.ts";

const AGENT_PORT_DEFAULT = 8080;
const APP_PORT_DEFAULT = 8081;
const APP_DIR = "/app";
const HOME_DIR = "/root";
const DATA_CREDS_REFRESH_MS = 45 * 60_000;
const DATA_CREDS_RETRY_MS = 60_000;
const failureBackoffStamp = (): number => Date.now() - DATA_CREDS_REFRESH_MS + DATA_CREDS_RETRY_MS;
const MAX_APP_BYTES = 100 * 1024 * 1024;
const READY_PATH = `${APP_DIR}/.qm-ready`;
const APP_READY_WINDOW_SEC = 60;
const APP_PORT_RELEASE_TICKS = 40;
const APP_START_EXEC_TIMEOUT_SEC = 60;
const EXIT_APP_PORT_HELD = 97;

const ENDPOINT_PORT = 443;
const RESOLVE_CACHE_MS = 15_000;
const RENEW_AHEAD_MS = 60 * 60_000;

const DEFAULT_INGRESS = (region: string): string =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
const DEFAULT_EGRESS = (region: string): string =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;

export interface StoredDeployBody {
  deploymentId: string;
  microvmId: string;
  endpoint: string;
  createdAtMs: number;
  lastSnapshotMs?: number;
  dataCredsAtMs?: number;
  rotateNotBeforeMs?: number;
  replacementMicrovmId?: string;
  orgId?: string;
}

export const AWS_DEPLOY_BODIES_MIGRATION = deploymentKeyedTable(
  "aws_deploy_bodies",
  cols(`microvmId text!, endpoint text!, createdAtMs bigint!, lastSnapshotMs bigint,
    dataCredsAtMs bigint, rotateNotBeforeMs bigint, replacementMicrovmId text, orgId text`),
);

export interface AwsDeployProviderOptions {
  region: string;
  profile?: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  agentPort?: number;
  appPort?: number;
  maximumDurationInSeconds?: number;
  maxIdleDurationSeconds?: number;
  suspendedDurationSeconds?: number;
  appsDomain?: string;
  tokenTtlMinutes?: number;
  dataBucket?: string;
  dataPrefix?: string;
  snapshotIntervalMs?: number;
  dataRoleArn?: string;
  store: DeployBodyStore<StoredDeployBody>;
  advisoryLock: AdvisoryLock;
  api?: AwsMicrovmApi;
  fetchImpl?: typeof fetch;
  s3?: Pick<S3Client, "send">;
  sts?: Pick<STSClient, "send">;
  onError?: AppErrorSink;
}

function awsDeployContext(opts: AwsDeployProviderOptions) {
  const region = opts.region;
  const api =
    opts.api ??
    createMicrovmApi({
      region,
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  const store = opts.store;
  const launchQueue = createKeyedQueue<string>();
  const advisoryLock = opts.advisoryLock;
  const ingress = opts.ingressConnectorArns?.length ? opts.ingressConnectorArns : [DEFAULT_INGRESS(region)];
  const egress = opts.egressConnectorArns?.length ? opts.egressConnectorArns : [DEFAULT_EGRESS(region)];
  const agentPort = opts.agentPort ?? AGENT_PORT_DEFAULT;
  const appPort = opts.appPort ?? APP_PORT_DEFAULT;
  const maximumDurationInSeconds = opts.maximumDurationInSeconds ?? 28_800;
  const lifetimeMs = maximumDurationInSeconds * 1000;
  const renewAtOf = (stored: StoredDeployBody): number =>
    Math.max(stored.createdAtMs + Math.max(lifetimeMs / 2, lifetimeMs - RENEW_AHEAD_MS), stored.rotateNotBeforeMs ?? 0);
  const maxIdleDurationSeconds = opts.maxIdleDurationSeconds ?? 900;
  const awakeForMs = Math.max(0, maxIdleDurationSeconds * 1000 - 60_000);
  const resolveCache = new LRUCache<string, { endpoint: DeployEndpoint; checkedMs: number }>({
    max: 500,
    ttl: Math.max(1, awakeForMs),
    updateAgeOnGet: true,
    perf: Date,
  });
  const suspendedDurationSeconds = opts.suspendedDurationSeconds ?? maximumDurationInSeconds;
  const tokenTtlMinutes = opts.tokenTtlMinutes ?? 30;
  const dataBucket = opts.dataBucket;
  const dataPrefix = (opts.dataPrefix ?? "deploy-data").replace(/\/+$/, "");
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? 5 * 60_000;
  const s3: Pick<S3Client, "send"> | undefined = dataBucket
    ? (opts.s3 ?? new S3Client({ region, ...(opts.profile ? { profile: opts.profile } : {}) }))
    : undefined;
  const dataRoleArn = opts.dataRoleArn;
  const litestream = !!(dataBucket && dataRoleArn);
  const sts: Pick<STSClient, "send"> | undefined = litestream
    ? (opts.sts ?? new STSClient({ region, ...(opts.profile ? { profile: opts.profile } : {}) }))
    : undefined;
  const dataKeyFor = (deploymentId: string): string => `${dataPrefix}/${deploymentId}.tar`;
  const litestreamKeyPrefix = (deploymentId: string): string => `${dataPrefix}/${deploymentId}/litestream`;

  const { tokenFor, daemon, execRaw, writeAbs, waitDaemon, ensureRunning, evict } = createMicrovmClient(api, {
    agentPort,
    tokenTtlMinutes,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const health = { binariesMissingUntilMs: 0 };
  return {
    opts,
    region,
    api,
    store,
    launchQueue,
    advisoryLock,
    ingress,
    egress,
    appPort,
    maximumDurationInSeconds,
    renewAtOf,
    maxIdleDurationSeconds,
    resolveCache,
    suspendedDurationSeconds,
    dataBucket,
    snapshotIntervalMs,
    s3,
    dataRoleArn,
    litestream,
    sts,
    dataKeyFor,
    litestreamKeyPrefix,
    tokenFor,
    daemon,
    execRaw,
    writeAbs,
    waitDaemon,
    ensureRunning,
    evict,
    health,
  };
}

export type AwsDeployContext = ReturnType<typeof awsDeployContext>;

function awsBodies(ctx: AwsDeployContext, data: AwsDataSnapshots) {
  const {
    opts,
    api,
    store,
    launchQueue,
    ingress,
    egress,
    maximumDurationInSeconds,
    renewAtOf,
    maxIdleDurationSeconds,
    suspendedDurationSeconds,
    s3,
    litestream,
    waitDaemon,
    ensureRunning,
  } = ctx;
  const { snapshotData, hydrateData } = data;
  let resolvedImageArn: string | undefined;
  async function imageArn(): Promise<string> {
    if (resolvedImageArn) return resolvedImageArn;
    if (opts.imageIdentifier.startsWith("arn:")) return (resolvedImageArn = opts.imageIdentifier);
    const img = await api.findImage(opts.imageIdentifier);
    if (!img) throw new Error(`AWS deploy image not found: ${opts.imageIdentifier}`);
    return (resolvedImageArn = img.imageArn);
  }

  async function launchBody(deploymentId: string, alwaysOn?: boolean): Promise<{ id: string; endpoint: string }> {
    const image = await imageArn();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const run = await api.runMicrovm({
          imageIdentifier: image,
          ...(opts.imageVersion ? { imageVersion: opts.imageVersion } : {}),
          ingressNetworkConnectors: ingress,
          egressNetworkConnectors: egress,
          ...(opts.executionRoleArn ? { executionRoleArn: opts.executionRoleArn } : {}),
          idlePolicy: {
            autoResumeEnabled: true,
            maxIdleDurationSeconds: alwaysOn ? maximumDurationInSeconds : maxIdleDurationSeconds,
            suspendedDurationSeconds,
          },
          maximumDurationInSeconds,
          clientToken: `deploy-${deploymentId}-${Date.now()}-${attempt}`,
        });
        const ready = await api.waitForState(run.microvmId, "RUNNING");
        const endpoint = run.endpoint ?? ready.endpoint;
        if (!endpoint) throw new Error(`microVM ${run.microvmId} has no endpoint`);
        await waitDaemon(run.microvmId, endpoint);
        return { id: run.microvmId, endpoint };
      } catch (e) {
        if (e instanceof AwsApiError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
        lastErr = e;
        if (attempt < 2) await sleep(2000);
      }
    }
    throw lastErr;
  }

  async function ensureBody(d: Deployment): Promise<{ id: string; endpoint: string; fresh: boolean }> {
    return launchQueue(d.id, async () => {
      let stored = await store.get(d.id);
      if (stored?.replacementMicrovmId) {
        await api
          .terminate(stored.replacementMicrovmId)
          .catch((e) => swallow("aws-deploy: terminate orphaned replacement", e));
        const { replacementMicrovmId: _, ...rest } = stored;
        stored = rest;
        await store.put(d.id, stored);
      }
      let next: { id: string; endpoint: string } | undefined;
      if (stored) {
        const desc = await api.tryGetMicrovm(stored.microvmId);
        const alive = desc && desc.state !== "TERMINATED" && desc.state !== "TERMINATING";
        if (alive && Date.now() < renewAtOf(stored)) {
          await ensureRunning(stored.microvmId, stored.endpoint, desc);
          return { id: stored.microvmId, endpoint: stored.endpoint, fresh: false };
        }
        if (alive) {
          next = await launchBody(d.id, d.alwaysOn);
          const replacement = next;
          await store.put(d.id, { ...stored, replacementMicrovmId: replacement.id });
          await ensureRunning(stored.microvmId, stored.endpoint, desc).catch(
            swallowAs("aws-deploy: keep old body running during replacement", undefined),
          );
          const defer = async (
            label: string,
            e: unknown,
            extra: Partial<StoredDeployBody> = {},
          ): Promise<{ id: string; endpoint: string; fresh: boolean }> => {
            swallow(label, e);
            await api.terminate(replacement.id).catch((e2) => swallow("aws-deploy: abandon replacement", e2));
            await store.put(d.id, { ...stored, rotateNotBeforeMs: Date.now() + 5 * 60_000, ...extra });
            return { id: stored.microvmId, endpoint: stored.endpoint, fresh: false };
          };
          try {
            await snapshotData(d.id, stored.microvmId, stored.endpoint);
          } catch (e) {
            if (s3) return defer("aws-deploy: rotate data snapshot failed, deferring rotation", e);
          }
          try {
            await api.terminate(stored.microvmId);
            if (litestream) await api.waitForState(stored.microvmId, "TERMINATED");
          } catch (e) {
            swallow("aws-deploy: rotate terminate", e);
            if (litestream)
              return defer("aws-deploy: rotate terminate failed, deferring rotation", e, {
                lastSnapshotMs: Date.now(),
              });
          }
        }
      }
      const body = next ?? (await launchBody(d.id, d.alwaysOn));
      try {
        await hydrateData(d.id, body.id, body.endpoint);
      } catch (e) {
        await api.terminate(body.id).catch((e2) => swallow("aws-deploy: hydrate-fail terminate", e2));
        throw e;
      }
      await store.put(d.id, {
        deploymentId: d.id,
        microvmId: body.id,
        endpoint: body.endpoint,
        createdAtMs: Date.now(),
        lastSnapshotMs: Date.now(),
        orgId: tenant().orgId,
      });
      return { id: body.id, endpoint: body.endpoint, fresh: true };
    });
  }
  return { ensureBody };
}

function awsMaterializer(ctx: AwsDeployContext, litestreamOps: AwsLitestreamOps) {
  const { opts, api, store, launchQueue, appPort, s3, litestream, execRaw, writeAbs, health } = ctx;
  const { stageLitestream, litestreamStartScript } = litestreamOps;
  async function checkoutBundle(id: string, endpoint: string, bundle: Uint8Array, commit: string): Promise<void> {
    const bundlePath = `/tmp/qm-deploy-${commit.slice(0, 12)}.bundle`;
    const ref = `refs/deploy-commits/${commit}`;
    await writeAbs(id, endpoint, bundlePath, bundle);
    const script = [
      `trap ${shq(`rm -f ${bundlePath}`)} EXIT`,
      `mkdir -p ${shq(APP_DIR)}`,
      `cd ${shq(APP_DIR)}`,
      "git init --quiet",
      `git fetch --force ${shq(bundlePath)} ${shq(ref)}`,
      "git clean -ffd -e .qm-ready",
      "git checkout --quiet --force FETCH_HEAD",
      "git clean -ffd -e .qm-ready",
    ].join(" && ");
    const r = await execRaw(id, endpoint, script, 180);
    if (r.code !== 0) throw execFailure("aws deploy git checkout", r);
  }

  async function writeFiles(
    id: string,
    endpoint: string,
    root: string,
    files: Array<{ path: string; data: string | Uint8Array }>,
  ): Promise<void> {
    for (const f of files) await writeAbs(id, endpoint, posixJoin(root, normalizeRelPath(f.path)), bytes(f.data));
  }

  async function startApp(d: Deployment, id: string, endpoint: string, version: DeploymentVersion): Promise<void> {
    const envExports = exportEnv(appEnv(version.env));
    const inner = `cd ${shq(APP_DIR)}; ${version.entrypoint}`;
    const script = [
      listeningOn(appPort),
      STOP_APP,
      `for i in $(seq 1 ${APP_PORT_RELEASE_TICKS}); do listening || break; sleep 0.25; done`,
      `listening && exit ${EXIT_APP_PORT_HELD}`,
      ...(s3 ? [`mkdir -p ${shq(DATA_DIR)}`] : []),
      `export HOME=${shq(HOME_DIR)}`,
      `export PORT=${appPort}`,
      ...(s3 ? [`export DATA_DIR=${shq(DATA_DIR)}`] : []),
      ...(envExports ? [envExports] : []),
      appLaunch(inner, appPort),
    ].join("; ");
    const r = await execRaw(id, endpoint, script, APP_START_EXEC_TIMEOUT_SEC);
    if (r.code === EXIT_APP_PORT_HELD) {
      throw new Error(
        `port ${appPort} is still held by a process this body cannot account for, so the new version was not started`,
      );
    }
    if (r.code !== 0) throw execFailure("aws deploy app start", r);
    await waitAppReady((script, timeoutSec) => execRaw(id, endpoint, script, timeoutSec), {
      appPort,
      windowSec: APP_READY_WINDOW_SEC,
      report: appReporter(opts.onError, d, version.env),
    });
  }

  async function materialize(
    d: Deployment,
    id: string,
    endpoint: string,
    fresh: boolean,
    version: DeploymentVersion,
    gitBundle?: Uint8Array,
  ): Promise<void> {
    if (gitBundle && version.commit) {
      await checkoutBundle(id, endpoint, gitBundle, version.commit);
    } else {
      await writeFiles(id, endpoint, APP_DIR, await readTree(version.snapshotDir));
    }
    if (version.homeDir)
      await writeFiles(id, endpoint, HOME_DIR, await readTree(version.homeDir, { tolerateMissing: true }));
    await writeAbs(id, endpoint, READY_PATH, Buffer.from(`${version.commit ?? version.version}\n`));
    if (litestream) {
      await launchQueue(d.id, async () => {
        await stageLitestream(d.id, id, endpoint);
        const r = await execRaw(id, endpoint, `mkdir -p ${shq(DATA_DIR)}; ${litestreamStartScript(d.id)}`, 180);
        if (r.code !== 0) {
          let msg = `litestream start failed (code ${r.code}): ${r.stderr.slice(0, 400)}`;
          if (r.code === 24) {
            if (fresh) health.binariesMissingUntilMs = Date.now() + 10 * 60_000;
            msg =
              "litestream/aws binaries missing from the MicroVM image — roll AWS_DEPLOY_IMAGE (cli/templates/aws/microvm-agent) before setting AWS_DEPLOY_DATA_ROLE_ARN";
          }
          if (fresh) {
            await store.delete(d.id).catch((e) => swallow("aws-deploy: litestream-fail clear pointer", e));
            await api.terminate(id).catch((e) => swallow("aws-deploy: litestream-fail terminate", e));
          } else {
            const cur = await store.get(d.id);
            if (cur && cur.microvmId === id) {
              if (r.code === 24) {
                await store.put(d.id, { ...cur, createdAtMs: 0 });
              } else {
                await store.put(d.id, {
                  ...cur,
                  rotateNotBeforeMs: Date.now() + 5 * 60_000,
                  dataCredsAtMs: failureBackoffStamp(),
                });
              }
            }
          }
          throw new Error(msg);
        }
        const cur = await store.get(d.id);
        if (cur) await store.put(d.id, { ...cur, dataCredsAtMs: Date.now() });
      });
    }
    await startApp(d, id, endpoint, version);
  }
  return { materialize };
}

function awsResolver(ctx: AwsDeployContext, data: AwsDataSnapshots, litestreamOps: AwsLitestreamOps) {
  const {
    opts,
    api,
    store,
    launchQueue,
    advisoryLock,
    appPort,
    renewAtOf,
    resolveCache,
    snapshotIntervalMs,
    s3,
    litestream,
    tokenFor,
    execRaw,
    ensureRunning,
  } = ctx;
  const { snapshotData } = data;
  const { refreshLitestream } = litestreamOps;
  const detached = async (d: Deployment, fn: () => Promise<void>): Promise<void> => {
    const run = (): Promise<void> => launchQueue(d.id, fn);
    if (advisoryLock.tryWithLock) {
      await advisoryLock.tryWithLock(`deploy:${d.id}`, run);
      return;
    }
    await advisoryLock.withLock(`deploy:${d.id}`, run);
  };

  async function endpointFor(d: Deployment, stored: StoredDeployBody): Promise<DeployEndpoint> {
    const token = await tokenFor(stored.microvmId);
    const result: DeployEndpoint = {
      host: stored.endpoint,
      port: ENDPOINT_PORT,
      tls: true,
      httpVersion: "2",
      proxyHeaders: { "X-aws-proxy-auth": token, "X-aws-proxy-port": String(appPort) },
      renewAt: renewAtOf(stored),
    };
    if (opts.appsDomain) {
      result.publicUrl = `https://${d.name ?? d.id}.${opts.appsDomain}/`;
    }
    return result;
  }

  const resolveLive = async (
    d: Deployment,
    version: DeploymentVersion,
    genCurrent: () => boolean,
  ): Promise<DeployEndpoint | null> => {
    const stored = await store.get(d.id);
    if (!stored) return null;
    try {
      const desc = await api.tryGetMicrovm(stored.microvmId);
      if (!desc || desc.state === "TERMINATED" || desc.state === "TERMINATING") {
        if (genCurrent()) {
          resolveCache.delete(d.id);
          await store.delete(d.id).catch((e) => swallow("aws-deploy: drop dead body pointer", e));
        }
        return null;
      }
      await ensureRunning(stored.microvmId, stored.endpoint, desc);
      const exec = (script: string, timeoutSec: number) =>
        execRaw(stored.microvmId, stored.endpoint, script, timeoutSec);
      const report = appReporter(opts.onError, d, version.env);
      if (await appGone(exec, { appPort, report })) return null;
    } catch (e) {
      if (!(e instanceof AwsApiError && (e.status >= 500 || e.status === 429))) throw e;
    }
    if (s3 && Date.now() - (stored.lastSnapshotMs ?? 0) > snapshotIntervalMs) {
      void (async () => {
        const claim = (): Promise<StoredDeployBody | null> =>
          launchQueue(d.id, async () => {
            const cur = await store.get(d.id);
            if (
              !cur ||
              cur.microvmId !== stored.microvmId ||
              Date.now() - (cur.lastSnapshotMs ?? 0) <= snapshotIntervalMs
            )
              return null;
            await store.put(d.id, { ...cur, lastSnapshotMs: Date.now() });
            return cur;
          });
        const cur = advisoryLock.tryWithLock
          ? await advisoryLock.tryWithLock(`deploy:${d.id}`, claim)
          : await advisoryLock.withLock(`deploy:${d.id}`, claim);
        if (cur) await snapshotData(d.id, cur.microvmId, cur.endpoint);
      })().catch((e) => swallow("aws-deploy: periodic data snapshot", e));
    }
    if (litestream && Date.now() - (stored.dataCredsAtMs ?? 0) > DATA_CREDS_REFRESH_MS) {
      void detached(d, async () => {
        const cur = await store.get(d.id);
        if (
          !cur ||
          cur.microvmId !== stored.microvmId ||
          Date.now() - (cur.dataCredsAtMs ?? 0) <= DATA_CREDS_REFRESH_MS
        )
          return;
        try {
          await refreshLitestream(d.id, cur.microvmId, cur.endpoint);
          await store.put(d.id, { ...cur, dataCredsAtMs: Date.now() });
        } catch (e) {
          await store
            .put(d.id, { ...cur, dataCredsAtMs: failureBackoffStamp() })
            .catch(swallowAs("aws-deploy: stamp litestream creds backoff", undefined));
          throw e;
        }
      }).catch((e) => swallow("aws-deploy: litestream creds refresh", e));
    }
    return endpointFor(d, stored);
  };
  return { endpointFor, resolveLive };
}

export function createAwsDeployProvider(opts: AwsDeployProviderOptions): DeployProvider {
  const ctx = awsDeployContext(opts);
  const {
    region,
    api,
    store,
    resolveCache,
    dataBucket,
    s3,
    dataRoleArn,
    litestream,
    execRaw,
    ensureRunning,
    evict,
    health,
  } = ctx;
  const inflightResolves = new Map<string, Promise<DeployEndpoint | null>>();
  const resolveGens = new Map<string, number>();
  const bumpResolveGen = (id: string): void => {
    resolveGens.set(id, (resolveGens.get(id) ?? 0) + 1);
    resolveCache.delete(id);
    inflightResolves.delete(id);
  };

  function ensureConfigured(): void {
    if (!region) throw new Error("AWS_DEPLOY_REGION/AWS_REGION not set (DEPLOY_PROVIDER=aws)");
    if (!opts.imageIdentifier) throw new Error("AWS_DEPLOY_IMAGE not set (DEPLOY_PROVIDER=aws)");
    if (dataRoleArn && !dataBucket) {
      throw new Error(
        "AWS_DEPLOY_DATA_ROLE_ARN is set but no data bucket resolved (AWS_DEPLOY_DATA_BUCKET or the sandbox S3 bucket) — litestream would be silently off",
      );
    }
  }

  const litestreamOps = awsLitestreamOps(ctx);
  const data = awsDataSnapshots(ctx);
  const { ensureBody } = awsBodies(ctx, data);
  const { materialize } = awsMaterializer(ctx, litestreamOps);
  const { endpointFor, resolveLive } = awsResolver(ctx, data, litestreamOps);

  const place = async (d: Deployment, version: DeploymentVersion, gitBundle?: Uint8Array): Promise<DeployEndpoint> => {
    ensureConfigured();
    if (litestream && Date.now() < health.binariesMissingUntilMs)
      throw new Error(
        "litestream/aws binaries missing from the MicroVM image (rechecking every 10 min) — roll AWS_DEPLOY_IMAGE",
      );
    const body = await ensureBody(d);
    await materialize(d, body.id, body.endpoint, body.fresh, version, gitBundle);
    bumpResolveGen(d.id);
    const stored = await store.get(d.id);
    if (stored?.microvmId !== body.id) throw new Error(`aws deploy: microVM ${body.id} lost its placement record`);
    return endpointFor(d, stored);
  };

  return {
    profile: {
      managedScaleToZero: true,
      appliesGitBundle: true,
      maxAppBytes: MAX_APP_BYTES,
      ...(s3 ? { dataDir: DATA_DIR } : {}),
    },

    apply: (d, version, gitBundle) => place(d, version, gitBundle),

    async resolveEndpoint(d, version): Promise<DeployEndpoint | null> {
      const gen = resolveGens.get(d.id) ?? 0;
      const genCurrent = (): boolean => (resolveGens.get(d.id) ?? 0) === gen;
      const revalidate = (): Promise<DeployEndpoint | null> => {
        const inflight = inflightResolves.get(d.id);
        if (inflight) return inflight;
        const resolve = resolveLive(d, version, genCurrent)
          .then((endpoint) => {
            if (!genCurrent()) return endpoint;
            if (!endpoint) {
              resolveCache.delete(d.id);
              return endpoint;
            }
            resolveCache.set(d.id, { endpoint, checkedMs: Date.now() });
            return endpoint;
          })
          .finally(() => {
            if (inflightResolves.get(d.id) === resolve) inflightResolves.delete(d.id);
          });
        inflightResolves.set(d.id, resolve);
        return resolve;
      };
      const cached = resolveCache.get(d.id);
      const samePlacement = !d.endpoint || d.endpoint.host === cached?.endpoint.host;
      if (cached && samePlacement) {
        if (Date.now() - cached.checkedMs >= RESOLVE_CACHE_MS)
          void revalidate().catch((e) => swallow("aws-deploy: background revalidate", e));
        return cached.endpoint;
      }
      return revalidate();
    },

    async logs(d, opts): Promise<string | null> {
      ensureConfigured();
      const stored = await store.get(d.id);
      if (!stored) return null;
      await ensureRunning(stored.microvmId, stored.endpoint);
      return appLogs(
        (script, timeoutSec) => execRaw(stored.microvmId, stored.endpoint, script, timeoutSec),
        opts.tailLines,
      );
    },

    async destroy(d): Promise<void> {
      bumpResolveGen(d.id);
      const stored = await store.get(d.id);
      if (stored) {
        await api.terminate(stored.microvmId).catch((e: unknown) => {
          if (!(e instanceof AwsApiError && e.status === 404)) throw e;
        });
        evict(stored.microvmId);
      }
      await store.delete(d.id).catch((e) => swallow("aws-deploy: destroy clear pointer", e));
    },
  };
}
