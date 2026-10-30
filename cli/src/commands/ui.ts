import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, ok, step } from "../log.ts";
import { capture } from "../util.ts";

export interface UiPublishOptions {
  bucket: string;
  dir: string;
  release?: string;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const DOCUMENTS = ["index.html", "shared.html"] as const;

export function uiReleaseId(dir: string): string {
  const hash = createHash("sha256");
  for (const name of DOCUMENTS) {
    try {
      hash.update(readFileSync(join(dir, name)));
    } catch (error) {
      throw new CliError(`${join(dir, name)} not found; build the web UI first (npm run build)`, { cause: error });
    }
  }
  return hash.digest("hex").slice(0, 16);
}

export function runUiPublish(o: UiPublishOptions): void {
  const aws = process.env.AWS_BIN ?? "aws";
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(o.bucket))
    throw new CliError("--bucket takes a bucket name, such as my-ui-releases", { clause: "cli.invocation" });
  const bucket = `s3://${o.bucket}`;
  const started = Date.now();
  const id = o.release ?? uiReleaseId(o.dir);
  if (!/^[a-f0-9]{16}$/.test(id)) throw new CliError("--release must be a 16-character release id");
  if (o.release) {
    try {
      capture(aws, ["s3api", "head-object", "--bucket", o.bucket, "--key", `releases/${id}/index.html`]);
    } catch (error) {
      throw new CliError(`web UI release ${id} is not in ${bucket}`, { cause: error });
    }
  } else {
    step(`uploading web UI release ${id}`);
    capture(aws, [
      "s3",
      "sync",
      join(o.dir, "assets"),
      `${bucket}/assets`,
      "--size-only",
      "--cache-control",
      IMMUTABLE,
    ]);
    for (const name of DOCUMENTS)
      capture(aws, ["s3", "cp", join(o.dir, name), `${bucket}/releases/${id}/${name}`, "--cache-control", IMMUTABLE]);
  }
  const scratch = mkdtempSync(join(tmpdir(), "qm-ui-"));
  try {
    const pointer = join(scratch, "live.json");
    writeFileSync(pointer, `${JSON.stringify({ id })}\n`);
    capture(aws, [
      "s3",
      "cp",
      pointer,
      `${bucket}/channels/live.json`,
      "--cache-control",
      "no-cache",
      "--content-type",
      "application/json",
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  ok(`web UI release ${id} is live (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
