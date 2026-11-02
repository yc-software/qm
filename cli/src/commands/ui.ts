import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QmConfig } from "../config.ts";
import { CliError, note, ok, step } from "../log.ts";
import { awsObjectStoreBucket } from "../terraform.ts";

export interface UiPublishOptions {
  dir?: string;
  release?: string;
}

interface ReleaseStore {
  root: string;
  region: string;
}

interface LivePointer {
  release: string;
  deployed: string;
}

const RELEASE_ID = /^[0-9a-f]{64}$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

function webReleaseStore(config: QmConfig): ReleaseStore {
  const core = config.env.core ?? {};
  const prefix = core.S3_PREFIX?.trim() ?? "";
  if (config.target === "aws" && config.aws) {
    const bucket = core.S3_BUCKET?.trim() || awsObjectStoreBucket(config);
    return { root: `s3://${bucket}/${prefix}web-ui/`, region: config.aws.region };
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
  return { root: `s3://${bucket}/${prefix}web-ui/`, region: core.S3_REGION?.trim() || "auto" };
}

function aws(store: ReleaseStore, args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.env.AWS_BIN ?? "aws", [...args, "--region", store.region], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
  });
  if (r.error) throw new CliError(`could not run the AWS CLI: ${r.error.message}`, { cause: r.error });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function awsOk(store: ReleaseStore, what: string, args: string[], input?: string): string {
  const r = aws(store, args, input);
  if (r.status !== 0)
    throw new CliError(`${what} failed (aws exited ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

const isMissingObject = (stderr: string): boolean => /\(404\)|Not Found|NoSuchKey|does not exist/i.test(stderr);

function readPointer(store: ReleaseStore): LivePointer | null {
  const r = aws(store, ["s3", "cp", `${store.root}live.json`, "-"]);
  if (r.status !== 0) {
    if (isMissingObject(r.stderr)) return null;
    throw new CliError(`reading ${store.root}live.json failed (aws exited ${r.status}): ${r.stderr.trim()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (error) {
    throw new CliError(`${store.root}live.json is not JSON: ${r.stdout}`, { cause: error });
  }
  const { release, deployed } = (parsed ?? {}) as Partial<Record<keyof LivePointer, unknown>>;
  if (typeof release !== "string" || !RELEASE_ID.test(release))
    throw new CliError(`${store.root}live.json names no release: ${r.stdout}`);
  return { release, deployed: typeof deployed === "string" ? deployed : "" };
}

function releaseExists(store: ReleaseStore, id: string): boolean {
  const r = aws(store, ["s3", "ls", `${store.root}releases/${id}/index.html`]);
  if (r.status === 0) return r.stdout.trim().length > 0;
  if (r.status === 1 && !r.stderr.trim()) return false;
  throw new CliError(`checking ${store.root}releases/${id}/ failed (aws exited ${r.status}): ${r.stderr.trim()}`);
}

function bundleFiles(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return bundleFiles(dir, path);
    return entry.isFile() ? [path] : [];
  });
}

function webBundleId(dir: string): { id: string; files: string[] } {
  let files: string[];
  try {
    files = bundleFiles(dir).sort();
  } catch (error) {
    throw new CliError(`cannot read the web UI bundle at ${dir}: ${(error as Error).message}`, { cause: error });
  }
  if (!files.includes("index.html"))
    throw new CliError(
      `${join(dir, "index.html")} is missing; build the web UI first (npm run build --prefix plugins/web-ui)`,
    );
  const id = createHash("sha256");
  for (const file of files) {
    const digest = createHash("sha256")
      .update(readFileSync(join(dir, file)))
      .digest("hex");
    id.update(`${file}\0${digest}\n`);
  }
  return { id: id.digest("hex"), files };
}

function upload(store: ReleaseStore, dir: string, id: string, files: string[]): void {
  step(`uploading web UI release ${id} to ${store.root}`);
  if (files.some((file) => file.startsWith("assets/")))
    awsOk(store, "uploading web UI assets", [
      "s3",
      "sync",
      join(dir, "assets"),
      `${store.root}assets`,
      "--size-only",
      "--only-show-errors",
      "--cache-control",
      IMMUTABLE,
    ]);
  const documents = files.filter((file) => !file.startsWith("assets/"));
  for (const file of [...documents.filter((f) => f !== "index.html"), "index.html"])
    awsOk(store, `uploading ${file}`, [
      "s3",
      "cp",
      join(dir, file),
      `${store.root}releases/${id}/${file}`,
      "--only-show-errors",
      "--cache-control",
      "no-cache",
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
    if (!releaseExists(store, id)) throw new CliError(`web UI release ${id} is not in ${store.root}releases/`);
  } else {
    const bundle = webBundleId(o.dir!);
    id = bundle.id;
    if (releaseExists(store, id)) step(`web UI release ${id} is already uploaded`);
    else upload(store, o.dir!, id, bundle.files);
  }
  const pointer: LivePointer = { release: id, deployed: previous?.deployed ?? "" };
  awsOk(
    store,
    "switching the live web UI release",
    ["s3", "cp", "-", `${store.root}live.json`, "--cache-control", "no-cache", "--content-type", "application/json"],
    `${JSON.stringify(pointer)}\n`,
  );
  ok(
    `web UI release ${id} is live (${((Date.now() - started) / 1000).toFixed(1)}s); running cores pick it up within seconds`,
  );
  if (previous && previous.release !== id) note(`  roll back with: qm ui publish --release ${previous.release}`);
}
