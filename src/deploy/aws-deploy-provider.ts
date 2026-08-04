import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { orgId as configOrgId } from "../config.ts";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider, DeployReconcileInput } from "./deploy-provider.ts";
import { bytes, normalizeRelPath, posixJoin, readTree } from "./deploy-fs.ts";
import { AwsApiError, createMicrovmApi, createMicrovmClient, type AwsMicrovmApi } from "../sandbox/aws-microvm-api.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { swallow } from "../util/errors.ts";

const AGENT_PORT_DEFAULT = 8080;
const APP_PORT_DEFAULT = 8081;
const APP_DIR = "/app";
const HOME_DIR = "/root";
const DATA_DIR = "/data";
const dataTarPath = (): string =>
  `/tmp/qm-data-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tar`;
const DATA_DB = `${DATA_DIR}/app.db`;
const LITESTREAM_CONFIG = "/etc/qm-litestream.yml";
const LITESTREAM_ENV = "/etc/qm-litestream.env";
const LITESTREAM_LOG = "/tmp/qm-litestream.log";
const DATA_CREDS_TTL_SEC = 3600;
const DATA_CREDS_REFRESH_MS = 45 * 60_000;
const DATA_CREDS_RETRY_MS = 60_000;
const failureBackoffStamp = (): number => Date.now() - DATA_CREDS_REFRESH_MS + DATA_CREDS_RETRY_MS;
const MAX_DATA_TAR_BYTES = 180 * 1024 * 1024;
const READY_PATH = `${APP_DIR}/.qm-ready`;
const PID_PATH = "/tmp/qm-app.pid";
const LOG_PATH = "/tmp/qm-app.log";
const APP_READY_WINDOW_SEC = 60;
const APP_READY_EXEC_TIMEOUT_SEC = 90;
const APP_PORT_RELEASE_TICKS = 40;
const APP_START_EXEC_TIMEOUT_SEC = 60;
const EXIT_APP_PORT_HELD = 97;
const EXIT_APP_EXITED = 98;

const LISTENING_ON_APP_PORT = (port: number): string =>
  `listening() { curl -s -o /dev/null --max-time 1 http://127.0.0.1:${port}/; [ "$?" != "7" ]; }`;

const LIVE_REPLICATOR_PIDS = `ls_pids() { for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null); case "\${c%% *}" in litestream|*/litestream) case "$c" in *${LITESTREAM_CONFIG}*) echo "\${p#/proc/}";; esac;; esac; done; }`;
const ENDPOINT_PORT = 443;
const RESOLVE_CACHE_MS = 15_000;

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
  orgId?: string;
}

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
  rotateAfterSeconds?: number;
  maxIdleDurationSeconds?: number;
  suspendedDurationSeconds?: number;
  appsDomain?: string;
  tokenTtlMinutes?: number;
  dataBucket?: string;
  dataPrefix?: string;
  snapshotIntervalMs?: number;
  dataRoleArn?: string;
  store?: DurableMap<StoredDeployBody>;
  advisoryLock?: AdvisoryLock;
  api?: AwsMicrovmApi;
  fetchImpl?: typeof fetch;
  s3?: Pick<S3Client, "send">;
  sts?: Pick<STSClient, "send">;
}

export function createAwsDeployProvider(opts: AwsDeployProviderOptions): DeployProvider {
  const region = opts.region;
  const api =
    opts.api ??
    createMicrovmApi({
      region,
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  const store = opts.store ?? createMemoryMap<StoredDeployBody>();
  const launchQueue = createKeyedQueue<string>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const resolveCache = new Map<string, { endpoint: DeployEndpoint; untilMs: number }>();
  const inflightResolves = new Map<string, Promise<DeployEndpoint | null>>();
  const resolveGens = new Map<string, number>();
  const bumpResolveGen = (id: string): void => {
    resolveGens.set(id, (resolveGens.get(id) ?? 0) + 1);
    resolveCache.delete(id);
    inflightResolves.delete(id);
  };
  const detached = async (d: Deployment, fn: () => Promise<void>): Promise<void> => {
    const run = (): Promise<void> => launchQueue(d.id, fn);
    if (advisoryLock.tryWithLock) {
      await advisoryLock.tryWithLock(`deploy:${d.id}`, run);
      return;
    }
    await advisoryLock.withLock(`deploy:${d.id}`, run);
  };

  const ingress = opts.ingressConnectorArns?.length ? opts.ingressConnectorArns : [DEFAULT_INGRESS(region)];
  const egress = opts.egressConnectorArns?.length ? opts.egressConnectorArns : [DEFAULT_EGRESS(region)];
  const agentPort = opts.agentPort ?? AGENT_PORT_DEFAULT;
  const appPort = opts.appPort ?? APP_PORT_DEFAULT;
  const maximumDurationInSeconds = opts.maximumDurationInSeconds ?? 28_800;
  const rotateAfterMs = (opts.rotateAfterSeconds ?? 27_000) * 1000;
  const maxIdleDurationSeconds = opts.maxIdleDurationSeconds ?? 900;
  const suspendedDurationSeconds = opts.suspendedDurationSeconds ?? 3600;
  const appsDomain = opts.appsDomain;
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

  function ensureConfigured(): void {
    if (!region) throw new Error("AWS_DEPLOY_REGION/AWS_REGION not set (DEPLOY_PROVIDER=aws)");
    if (!opts.imageIdentifier) throw new Error("AWS_DEPLOY_IMAGE not set (DEPLOY_PROVIDER=aws)");
    if (dataRoleArn && !dataBucket) {
      throw new Error(
        "AWS_DEPLOY_DATA_ROLE_ARN is set but no data bucket resolved (AWS_DEPLOY_DATA_BUCKET or the sandbox S3 bucket) — litestream would be silently off",
      );
    }
  }

  const { tokenFor, daemon, execRaw, writeAbs, waitDaemon, ensureRunning, evict } = createMicrovmClient(api, {
    agentPort,
    tokenTtlMinutes,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  let binariesMissingUntilMs = 0;

  let resolvedImageArn: string | undefined;
  async function imageArn(): Promise<string> {
    if (resolvedImageArn) return resolvedImageArn;
    if (opts.imageIdentifier.startsWith("arn:")) return (resolvedImageArn = opts.imageIdentifier);
    const img = await api.findImage(opts.imageIdentifier);
    if (!img) throw new Error(`AWS deploy image not found: ${opts.imageIdentifier}`);
    return (resolvedImageArn = img.imageArn);
  }

  async function readAbsBytes(id: string, endpoint: string, absPath: string): Promise<Uint8Array | null> {
    const res = await daemon(id, endpoint, "/read", { path: absPath });
    if (res.status === 404) return null;
    if (res.status !== 200)
      throw new Error(`microVM read ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
    return Buffer.from((JSON.parse(res.text) as { b64: string }).b64, "base64");
  }

  async function mintDataCreds(
    deploymentId: string,
  ): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
          Resource: `arn:aws:s3:::${dataBucket}/${litestreamKeyPrefix(deploymentId)}/*`,
        },
        {
          Effect: "Allow",
          Action: "s3:ListBucket",
          Resource: `arn:aws:s3:::${dataBucket}`,
          Condition: { StringLike: { "s3:prefix": `${litestreamKeyPrefix(deploymentId)}/*` } },
        },
      ],
    });
    const r = await sts!.send(
      new AssumeRoleCommand({
        RoleArn: dataRoleArn!,
        RoleSessionName: `deploy-${deploymentId.slice(0, 8)}`,
        Policy: policy,
        DurationSeconds: DATA_CREDS_TTL_SEC,
      }),
    );
    const c = r.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken)
      throw new Error("assume-role returned no credentials");
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  }

  async function stageLitestream(deploymentId: string, id: string, endpoint: string): Promise<void> {
    const creds = await mintDataCreds(deploymentId);
    const env = `AWS_ACCESS_KEY_ID=${creds.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${creds.secretAccessKey}\nAWS_SESSION_TOKEN=${creds.sessionToken}\nAWS_REGION=${region}\n`;
    const config = [
      "dbs:",
      `  - path: ${DATA_DB}`,
      "    replicas:",
      "      - type: s3",
      `        bucket: ${dataBucket}`,
      `        path: ${litestreamKeyPrefix(deploymentId)}`,
      `        region: ${region}`,
      "",
    ].join("\n");
    await writeAbs(id, endpoint, LITESTREAM_ENV, Buffer.from(env));
    await writeAbs(id, endpoint, LITESTREAM_CONFIG, Buffer.from(config));
  }

  const litestreamStartScript = (deploymentId: string): string => {
    const fail = (code: number): string => `{ tail -c 400 ${shq(LITESTREAM_LOG)} >&2 2>/dev/null; exit ${code}; }`;
    return [
      `command -v litestream >/dev/null 2>&1 && command -v aws >/dev/null 2>&1 || exit 24`,
      `chmod 600 ${shq(LITESTREAM_ENV)} 2>/dev/null || true`,
      `( set -a; . ${shq(LITESTREAM_ENV)}; set +a; litestream snapshots -config ${shq(LITESTREAM_CONFIG)} ${shq(DATA_DB)} && printf ok | aws s3 cp - s3://${dataBucket}/${litestreamKeyPrefix(deploymentId)}/.write-probe && aws s3 rm s3://${dataBucket}/${litestreamKeyPrefix(deploymentId)}/.write-probe ) >> ${shq(LITESTREAM_LOG)} 2>&1 || ${fail(23)}`,
      LIVE_REPLICATOR_PIDS,
      `for q in $(ls_pids); do kill -TERM "$q" 2>/dev/null || true; done`,
      `for i in $(seq 1 40); do [ -z "$(ls_pids)" ] && break; sleep 0.25; done`,
      `for q in $(ls_pids); do kill -KILL "$q" 2>/dev/null || true; done`,
      `for i in $(seq 1 40); do [ -z "$(ls_pids)" ] && break; sleep 0.25; done`,
      `[ -z "$(ls_pids)" ] || ${fail(25)}`,
      `( set -a; . ${shq(LITESTREAM_ENV)}; set +a; litestream restore -config ${shq(LITESTREAM_CONFIG)} -if-replica-exists -if-db-not-exists ${shq(DATA_DB)} ) >> ${shq(LITESTREAM_LOG)} 2>&1 || ${fail(21)}`,
      `if [ ! -f ${shq(DATA_DB)} ] && [ -f ${shq(`${DATA_DB}.tar-fallback`)} ]; then for s in -wal -shm -journal; do [ -f ${shq(`${DATA_DB}.tar-fallback`)}$s ] && mv ${shq(`${DATA_DB}.tar-fallback`)}$s ${shq(DATA_DB)}$s || true; done; mv ${shq(`${DATA_DB}.tar-fallback`)} ${shq(DATA_DB)}; fi`,
      `rm -f ${shq(`${DATA_DB}.tar-fallback`)} ${shq(`${DATA_DB}.tar-fallback`)}-wal ${shq(`${DATA_DB}.tar-fallback`)}-shm ${shq(`${DATA_DB}.tar-fallback`)}-journal`,
      `setsid sh -c ${shq(`set -a; . ${LITESTREAM_ENV}; set +a; exec litestream replicate -config ${LITESTREAM_CONFIG}`)} >> ${shq(LITESTREAM_LOG)} 2>&1 &`,
      `for i in $(seq 1 40); do [ "$(ls_pids | wc -l | tr -d '[:space:]')" = "1" ] && break; sleep 0.25; done`,
      `[ "$(ls_pids | wc -l | tr -d '[:space:]')" = "1" ] || ${fail(22)}`,
    ].join("\n");
  };

  async function refreshLitestream(deploymentId: string, id: string, endpoint: string): Promise<void> {
    await stageLitestream(deploymentId, id, endpoint);
    const r = await execRaw(id, endpoint, litestreamStartScript(deploymentId), 120);
    if (r.code !== 0) throw new Error(`litestream refresh failed (code ${r.code}): ${r.stderr.slice(0, 400)}`);
  }

  async function snapshotData(deploymentId: string, id: string, endpoint: string): Promise<boolean> {
    if (!s3 || !dataBucket) return false;
    const tarPath = dataTarPath();
    const excl = `--exclude='./app.db' --exclude='./app.db-*' --exclude='./.app.db-litestream'`;
    const ff = `! -name 'app.db' ! -name 'app.db-*' ! -path './.app.db-litestream*'`;
    const tarCmd = litestream
      ? `${LIVE_REPLICATOR_PIDS}; if [ -n "$(ls_pids)" ]; then ` +
        `[ -n "$(find . -mindepth 1 ${ff} -print -quit)" ] || exit 3; tar -cf ${shq(tarPath)} ${excl} . || { rm -f ${shq(tarPath)}; exit 5; }; ` +
        `else [ -n "$(find . -mindepth 1 -print -quit)" ] || exit 3; tar -cf ${shq(tarPath)} . || { rm -f ${shq(tarPath)}; exit 5; }; fi`
      : `[ -n "$(find . -mindepth 1 -print -quit)" ] || exit 3; tar -cf ${shq(tarPath)} . || { rm -f ${shq(tarPath)}; exit 5; }`;
    const script =
      `cd ${shq(DATA_DIR)} 2>/dev/null || exit 3; ${tarCmd}; ` +
      `[ "$(wc -c < ${shq(tarPath)})" -le ${MAX_DATA_TAR_BYTES} ] || { rm -f ${shq(tarPath)}; exit 4; }`;
    const made = await execRaw(id, endpoint, script, 180);
    if (made.code === 3) return false;
    if (made.code === 4) {
      swallow("aws-deploy: data snapshot skipped, /data over size cap", new Error(deploymentId));
      return false;
    }
    if (made.code !== 0) throw new Error(`data snapshot tar failed (code ${made.code}): ${made.stderr.slice(0, 200)}`);
    const tar = await readAbsBytes(id, endpoint, tarPath);
    await execRaw(id, endpoint, `rm -f ${shq(tarPath)}`, 30).catch(() => {});
    if (!tar?.length) throw new Error("data snapshot read-back empty");
    await s3.send(new PutObjectCommand({ Bucket: dataBucket, Key: dataKeyFor(deploymentId), Body: tar }));
    return true;
  }

  async function hydrateData(deploymentId: string, id: string, endpoint: string): Promise<void> {
    if (!s3 || !dataBucket) return;
    let tar: Uint8Array | null;
    try {
      const got = await s3.send(new GetObjectCommand({ Bucket: dataBucket, Key: dataKeyFor(deploymentId) }));
      tar = (await got.Body?.transformToByteArray()) ?? null;
    } catch (e) {
      const code = (e as { name?: string })?.name ?? "";
      const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (/NoSuchKey|NotFound/.test(code) || status === 404) return;
      throw e;
    }
    if (!tar?.length) return;
    const tarPath = dataTarPath();
    await writeAbs(id, endpoint, tarPath, tar);
    const exclude = litestream
      ? ` --exclude='./.app.db-litestream'` +
        ` --transform='s|^\\./app\\.db$|./app.db.tar-fallback|'` +
        ` --transform='s|^\\./app\\.db-wal$|./app.db.tar-fallback-wal|'` +
        ` --transform='s|^\\./app\\.db-shm$|./app.db.tar-fallback-shm|'` +
        ` --transform='s|^\\./app\\.db-journal$|./app.db.tar-fallback-journal|'`
      : "";
    const r = await execRaw(
      id,
      endpoint,
      `mkdir -p ${shq(DATA_DIR)} && cd ${shq(DATA_DIR)} && tar -xf ${shq(tarPath)}${exclude}; rc=$?; rm -f ${shq(tarPath)}; exit $rc`,
      180,
    );
    if (r.code !== 0) throw new Error(`data hydrate extract failed: ${r.stderr.slice(0, 200)}`);
  }

  async function launchBody(deploymentId: string): Promise<{ id: string; endpoint: string }> {
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
          idlePolicy: { autoResumeEnabled: true, maxIdleDurationSeconds, suspendedDurationSeconds },
          maximumDurationInSeconds,
          clientToken: `deploy-${deploymentId}-${Date.now()}-${attempt}`,
        });
        const ready = await api.waitForState(run.microvmId, "RUNNING");
        const endpoint = run.endpoint ?? ready.endpoint;
        if (!endpoint) throw new Error(`microVM ${run.microvmId} has no endpoint`);
        await waitDaemon(run.microvmId, endpoint);
        return { id: run.microvmId, endpoint };
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await sleep(2000);
      }
    }
    throw lastErr;
  }

  async function ensureBody(d: Deployment): Promise<{ id: string; endpoint: string; fresh: boolean }> {
    return launchQueue(d.id, async () => {
      const stored = await store.get(d.id);
      if (stored) {
        const desc = await api.tryGetMicrovm(stored.microvmId);
        const alive = desc && desc.state !== "TERMINATED" && desc.state !== "TERMINATING";
        const stale = Date.now() - stored.createdAtMs > rotateAfterMs;
        if (alive && !stale) {
          await ensureRunning(stored.microvmId, stored.endpoint);
          return { id: stored.microvmId, endpoint: stored.endpoint, fresh: false };
        }
        if (alive && stale) {
          await ensureRunning(stored.microvmId, stored.endpoint).catch(() => {});
          const defer = async (
            label: string,
            e: unknown,
            extra: Partial<StoredDeployBody> = {},
          ): Promise<{ id: string; endpoint: string; fresh: boolean }> => {
            swallow(label, e);
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
      const body = await launchBody(d.id);
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
        orgId: configOrgId(),
      });
      return { id: body.id, endpoint: body.endpoint, fresh: true };
    });
  }

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
    if (r.code !== 0) throw new Error(`aws deploy git checkout failed: ${r.stderr.slice(0, 300)}`);
  }

  async function writeFiles(
    id: string,
    endpoint: string,
    root: string,
    files: Array<{ path: string; data: string | Uint8Array }>,
  ): Promise<void> {
    for (const f of files) await writeAbs(id, endpoint, posixJoin(root, normalizeRelPath(f.path)), bytes(f.data));
  }

  async function startApp(id: string, endpoint: string, version: DeploymentVersion): Promise<void> {
    const envExports = Object.entries(version.env ?? {})
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map(([k, v]) => `export ${k}=${shq(v)}`)
      .join("; ");
    const inner = `cd ${shq(APP_DIR)}; ${version.entrypoint}`;
    const script = [
      LISTENING_ON_APP_PORT(appPort),
      `old=$(cat ${shq(PID_PATH)} 2>/dev/null || true)`,
      `if [ -n "$old" ]; then kill -TERM "-$old" 2>/dev/null || true; sleep 0.5; kill -KILL "-$old" 2>/dev/null || true; fi`,
      `rm -f ${shq(PID_PATH)}`,
      `for i in $(seq 1 ${APP_PORT_RELEASE_TICKS}); do listening || break; sleep 0.25; done`,
      `listening && exit ${EXIT_APP_PORT_HELD}`,
      ...(s3 ? [`mkdir -p ${shq(DATA_DIR)}`] : []),
      `export HOME=${shq(HOME_DIR)}`,
      `export PORT=${appPort}`,
      ...(s3 ? [`export DATA_DIR=${shq(DATA_DIR)}`] : []),
      ...(envExports ? [envExports] : []),
      `setsid sh -c ${shq(inner)} > ${shq(LOG_PATH)} 2>&1 & echo $! > ${shq(PID_PATH)}`,
    ].join("; ");
    const r = await execRaw(id, endpoint, script, APP_START_EXEC_TIMEOUT_SEC);
    if (r.code === EXIT_APP_PORT_HELD) {
      throw new Error(
        `port ${appPort} is still held by a process this body cannot account for, so the new version was not started`,
      );
    }
    if (r.code !== 0) throw new Error(`aws deploy app start failed: ${r.stderr.slice(0, 300)}`);
    await waitAppReady(id, endpoint);
  }

  async function waitAppReady(id: string, endpoint: string): Promise<void> {
    const probe =
      `pid=$(cat ${shq(PID_PATH)} 2>/dev/null || true); died=0; ` +
      `end=$(( $(date +%s) + ${APP_READY_WINDOW_SEC} )); ` +
      `while [ "$(date +%s)" -lt "$end" ]; do ` +
      `curl -s --max-time 2 -o /dev/null http://127.0.0.1:${appPort}/ && exit 0; ` +
      `kill -0 -"$pid" 2>/dev/null || died=1; ` +
      `sleep 0.5; done; [ "$died" = 1 ] && exit ${EXIT_APP_EXITED}; exit 1`;
    const r = await execRaw(id, endpoint, probe, APP_READY_EXEC_TIMEOUT_SEC);
    if (r.code === 0) return;
    const log = await execRaw(id, endpoint, `tail -c 2000 ${shq(LOG_PATH)} 2>/dev/null || true`, 30)
      .then((out) => `${out.stdout}${out.stderr}`.trim())
      .catch(() => "");
    const why =
      r.code === EXIT_APP_EXITED
        ? `the version's entrypoint exited without binding port ${appPort}`
        : `app never listened on port ${appPort} within ${APP_READY_WINDOW_SEC}s`;
    throw new Error(why + (log ? `; last output from the entrypoint:\n${log}` : "; the entrypoint produced no output"));
  }

  async function materialize(
    d: Deployment,
    id: string,
    endpoint: string,
    fresh: boolean,
    version: DeploymentVersion,
    input?: DeployReconcileInput,
  ): Promise<void> {
    if (input?.gitBundle && version.commit) {
      await checkoutBundle(id, endpoint, input.gitBundle, version.commit);
    } else {
      await writeFiles(id, endpoint, APP_DIR, await readTree(version.snapshotDir, { tolerateMissing: true }));
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
            if (fresh) binariesMissingUntilMs = Date.now() + 10 * 60_000;
            msg =
              "litestream/aws binaries missing from the MicroVM image — roll AWS_DEPLOY_IMAGE (aws/microvm-agent) before setting AWS_DEPLOY_DATA_ROLE_ARN";
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
    await startApp(id, endpoint, version);
  }

  async function endpointFor(d: Deployment, microvmId: string, endpoint: string): Promise<DeployEndpoint> {
    const token = await tokenFor(microvmId);
    const result: DeployEndpoint = {
      host: endpoint,
      port: ENDPOINT_PORT,
      tls: true,
      httpVersion: "2",
      proxyHeaders: { "X-aws-proxy-auth": token, "X-aws-proxy-port": String(appPort) },
    };
    if (appsDomain) {
      result.publicUrl = `https://${d.name ?? d.id}.${appsDomain}/`;
    }
    return result;
  }

  const resolveLive = async (d: Deployment, genCurrent: () => boolean): Promise<DeployEndpoint | null> => {
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
      if (
        Date.now() - stored.createdAtMs > rotateAfterMs &&
        !(stored.rotateNotBeforeMs && Date.now() < stored.rotateNotBeforeMs)
      )
        return null;
      await ensureRunning(stored.microvmId, stored.endpoint);
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
          await store.put(d.id, { ...cur, dataCredsAtMs: failureBackoffStamp() }).catch(() => {});
          throw e;
        }
      }).catch((e) => swallow("aws-deploy: litestream creds refresh", e));
    }
    return endpointFor(d, stored.microvmId, stored.endpoint);
  };

  const place = async (
    d: Deployment,
    version: DeploymentVersion,
    input?: DeployReconcileInput,
  ): Promise<DeployEndpoint> => {
    ensureConfigured();
    if (litestream && Date.now() < binariesMissingUntilMs)
      throw new Error(
        "litestream/aws binaries missing from the MicroVM image (rechecking every 10 min) — roll AWS_DEPLOY_IMAGE",
      );
    const body = await ensureBody(d);
    await materialize(d, body.id, body.endpoint, body.fresh, version, input);
    bumpResolveGen(d.id);
    return endpointFor(d, body.id, body.endpoint);
  };

  return {
    profile: { managedScaleToZero: true, inPlaceReconcile: true, ...(s3 ? { dataDir: DATA_DIR } : {}) },

    apply: (d, version) => place(d, version),

    reconcile: (d, version, input) => place(d, version, input),

    async resolveEndpoint(d, _version): Promise<DeployEndpoint | null> {
      const cached = resolveCache.get(d.id);
      if (cached && Date.now() < cached.untilMs) return cached.endpoint;
      const inflight = inflightResolves.get(d.id);
      if (inflight) return inflight;
      const gen = resolveGens.get(d.id) ?? 0;
      const genCurrent = (): boolean => (resolveGens.get(d.id) ?? 0) === gen;
      const resolve = resolveLive(d, genCurrent)
        .then((endpoint) => {
          if (endpoint && genCurrent()) {
            if (resolveCache.size > 500) {
              for (const [k, v] of resolveCache) if (Date.now() >= v.untilMs) resolveCache.delete(k);
            }
            resolveCache.set(d.id, { endpoint, untilMs: Date.now() + RESOLVE_CACHE_MS });
          }
          return endpoint;
        })
        .finally(() => {
          if (inflightResolves.get(d.id) === resolve) inflightResolves.delete(d.id);
        });
      inflightResolves.set(d.id, resolve);
      return resolve;
    },

    async logs(d, opts): Promise<string | null> {
      ensureConfigured();
      const stored = await store.get(d.id);
      if (!stored) return null;
      await ensureRunning(stored.microvmId, stored.endpoint);
      const lines = Math.max(1, Math.min(2000, Math.floor(opts.tailLines)));
      const r = await execRaw(
        stored.microvmId,
        stored.endpoint,
        `tail -n ${lines} ${shq(LOG_PATH)} 2>/dev/null || true`,
        30,
      );
      return r.stdout;
    },

    async destroy(d): Promise<void> {
      bumpResolveGen(d.id);
      const stored = await store.get(d.id);
      if (stored) {
        await api.terminate(stored.microvmId).catch((e) => swallow("aws-deploy: destroy terminate", e));
        evict(stored.microvmId);
      }
      await store.delete(d.id).catch((e) => swallow("aws-deploy: destroy clear pointer", e));
    },
  };
}
