import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { QmConfig } from "../config.ts";
import { CliError, note, ok, step, warn } from "../log.ts";
import { awsObjectStoreBucket } from "../terraform.ts";
import {
  LIVE_KEY,
  RELEASE_ID,
  formatLivePointer,
  releaseMarkerKey,
  WEB_RELEASE_ROOT,
  parseLivePointer,
  readWebBundleLayout,
  releaseKey,
  type LivePointer,
  type WebBundleLayout,
} from "../web-release.ts";

export interface UiPublishOptions {
  dir?: string;
  release?: string;
}

interface ReleaseStore {
  bucket: string;
  prefix: string;
  region?: string;
  endpoint?: string;
}

const s3Uri = (store: ReleaseStore, key = ""): string => `s3://${store.bucket}/${store.prefix}${key}`;

function webReleaseStore(config: QmConfig): ReleaseStore {
  const core = config.env.core ?? {};
  const prefix = core.S3_PREFIX?.trim() ?? "";
  if (config.target === "aws" && config.aws) {
    const bucket = core.S3_BUCKET?.trim() || awsObjectStoreBucket(config);
    return { bucket, prefix: `${prefix}${WEB_RELEASE_ROOT}`, region: config.aws.region };
  }
  if (config.target === "render")
    throw new CliError(
      "Render keeps the credentials for the deployment's MinIO storage only in its Render services, so qm ui publish has none to write the web UI with; ship web UI changes with `qm up`",
    );
  const bucket = core.S3_BUCKET?.trim();
  if (core.SNAPSHOT_STORE !== "s3" || !bucket)
    throw new CliError(
      "qm ui publish writes to the deployment's S3 bucket, but env.core does not set SNAPSHOT_STORE=s3 and S3_BUCKET; core serves the web UI from its data directory, so ship web UI changes with `qm up`",
    );
  const endpoint = core.AWS_ENDPOINT_URL_S3?.trim();
  if (config.target === "fly" && !endpoint && !process.env.AWS_ENDPOINT_URL_S3?.trim())
    throw new CliError(
      `the fly target keeps ${bucket} in Tigris, not AWS S3: export AWS_ENDPOINT_URL_S3=https://fly.storage.tigris.dev and an AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY pair for the bucket (create one with \`fly storage dashboard ${bucket}\`), then rerun qm ui publish`,
    );
  const region = core.S3_REGION?.trim() || core.AWS_REGION?.trim();
  const viaEndpoint = Boolean(endpoint || process.env.AWS_ENDPOINT_URL_S3?.trim());
  return {
    bucket,
    prefix: `${prefix}${WEB_RELEASE_ROOT}`,
    ...(region || viaEndpoint ? { region: region || "auto" } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
}

function aws(
  store: ReleaseStore,
  args: string[],
  input?: string,
): { status: number; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const location = [
    ...(store.region ? ["--region", store.region] : []),
    ...(store.endpoint ? ["--endpoint-url", store.endpoint] : []),
  ];
  const r = spawnSync(process.env.AWS_BIN ?? "aws", [...args, ...location], {
    encoding: "utf8",
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
  });
  if (r.error) throw new CliError(`could not run the AWS CLI: ${r.error.message}`, { cause: r.error });
  return { status: r.status ?? 1, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function awsOk(store: ReleaseStore, what: string, args: string[], input?: string): string {
  const r = aws(store, args, input);
  if (r.status !== 0)
    throw new CliError(
      `${what} failed (aws ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  return r.stdout;
}

function objectExists(store: ReleaseStore, key: string): boolean {
  const full = `${store.prefix}${key}`;
  const count = awsOk(store, `checking ${s3Uri(store, key)}`, [
    "s3api",
    "list-objects-v2",
    "--bucket",
    store.bucket,
    "--prefix",
    full,
    "--query",
    `length(Contents[?Key=='${full}'] || \`[]\`)`,
    "--output",
    "text",
  ]).trim();
  return count !== "0";
}

function readPointer(store: ReleaseStore): LivePointer | null {
  if (!objectExists(store, LIVE_KEY)) return null;
  const text = awsOk(store, `reading ${s3Uri(store, LIVE_KEY)}`, ["s3", "cp", s3Uri(store, LIVE_KEY), "-"]);
  try {
    return parseLivePointer(text, s3Uri(store, LIVE_KEY));
  } catch (error) {
    throw new CliError((error as Error).message, { cause: error });
  }
}

function upload(store: ReleaseStore, dir: string, bundle: WebBundleLayout): void {
  step(`uploading web UI release ${bundle.id} to ${s3Uri(store)}`);
  if (bundle.assets.length)
    awsOk(store, "uploading web UI assets", [
      "s3",
      "sync",
      join(dir, "assets"),
      s3Uri(store, "assets"),
      "--size-only",
      "--only-show-errors",
    ]);
  const entry = bundle.documents.at(-1)!;
  if (bundle.documents.length > 1)
    awsOk(store, "uploading web UI documents", [
      "s3",
      "cp",
      dir,
      s3Uri(store, releaseKey(bundle.id, "")),
      "--recursive",
      "--exclude",
      "assets/*",
      "--exclude",
      entry,
      "--only-show-errors",
    ]);
  awsOk(store, `uploading ${entry}`, [
    "s3",
    "cp",
    join(dir, entry),
    s3Uri(store, releaseKey(bundle.id, entry)),
    "--only-show-errors",
  ]);
}

export function runUiPublish(config: QmConfig, o: UiPublishOptions): void {
  if (Boolean(o.dir) === Boolean(o.release))
    throw new CliError("qm ui publish takes exactly one of --dir <built web UI> or --release <id>", {
      clause: "cli.invocation",
    });
  if (o.release !== undefined && !RELEASE_ID.test(o.release))
    throw new CliError("--release takes a 64-character release id printed by an earlier qm ui publish", {
      clause: "cli.invocation",
    });
  const started = Date.now();
  const store = webReleaseStore(config);
  const previous = readPointer(store);
  let id: string;
  if (o.release) {
    id = o.release;
    if (!objectExists(store, releaseMarkerKey(id)))
      throw new CliError(`web UI release ${id} is not in ${s3Uri(store, "releases/")}`);
  } else {
    let bundle: WebBundleLayout;
    try {
      bundle = readWebBundleLayout(o.dir!);
    } catch (error) {
      throw new CliError(`cannot read the web UI bundle at ${o.dir}: ${(error as Error).message}`, { cause: error });
    }
    id = bundle.id;
    if (objectExists(store, releaseMarkerKey(id))) step(`web UI release ${id} is already uploaded`);
    else upload(store, o.dir!, bundle);
  }
  const pointer: LivePointer = { release: id, deployed: readPointer(store)?.deployed ?? "" };
  awsOk(
    store,
    "switching the live web UI release",
    ["s3", "cp", "-", s3Uri(store, LIVE_KEY)],
    formatLivePointer(pointer),
  );
  ok(
    `web UI release ${id} is live (${((Date.now() - started) / 1000).toFixed(1)}s); running cores pick it up within seconds`,
  );
  if (!pointer.deployed)
    warn(
      `no deployed core has claimed ${s3Uri(store)} yet; only cores built without a bundled web UI serve this release until one does`,
    );
  if (previous && previous.release !== id) note(`  roll back with: qm ui publish --release ${previous.release}`);
}
