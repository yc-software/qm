import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, ok, step } from "../log.ts";
import { capture } from "../util.ts";

export interface UiPublishOptions {
  bucket: string;
  channel: string;
  dir: string;
  release?: string;
  distribution?: string;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

function parseRelease(text: string, source: string): { id: string; protocol: number } {
  let parsed: { id?: unknown; protocol?: unknown } | undefined;
  let cause: unknown;
  try {
    parsed = JSON.parse(text) as { id?: unknown; protocol?: unknown };
  } catch (error) {
    cause = error;
  }
  if (typeof parsed?.id === "string" && /^[a-f0-9]{8,64}$/.test(parsed.id) && Number.isSafeInteger(parsed.protocol))
    return { id: parsed.id, protocol: parsed.protocol as number };
  throw new CliError(`${source} is not a web UI release manifest; build the web UI first (npm run build)`, { cause });
}

export function runUiPublish(o: UiPublishOptions): void {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(o.channel))
    throw new CliError("--channel must be a lowercase name such as live or pr-123", { clause: "cli.invocation" });
  const aws = process.env.AWS_BIN ?? "aws";
  const bucket = `s3://${o.bucket}`;
  const started = Date.now();
  let manifest: string;
  if (o.release) {
    manifest = capture(aws, ["s3", "cp", `${bucket}/releases/${o.release}/release.json`, "-"]);
  } else {
    const local = join(o.dir, "release.json");
    try {
      manifest = readFileSync(local, "utf8");
    } catch (error) {
      throw new CliError(`${local} not found; build the web UI first (npm run build)`, { cause: error });
    }
  }
  const release = parseRelease(manifest, o.release ? `release ${o.release}` : join(o.dir, "release.json"));
  if (!o.release) {
    step(`uploading assets and release ${release.id}`);
    capture(aws, [
      "s3",
      "sync",
      join(o.dir, "assets"),
      `${bucket}/assets`,
      "--size-only",
      "--exclude",
      "*.gz",
      "--cache-control",
      IMMUTABLE,
    ]);
    for (const name of ["index.html", "shared.html", "release.json"])
      capture(aws, [
        "s3",
        "cp",
        join(o.dir, name),
        `${bucket}/releases/${release.id}/${name}`,
        "--cache-control",
        IMMUTABLE,
      ]);
  }
  const scratch = mkdtempSync(join(tmpdir(), "qm-ui-"));
  try {
    const pointer = join(scratch, "pointer.json");
    writeFileSync(pointer, `${JSON.stringify(release)}\n`);
    capture(aws, [
      "s3",
      "cp",
      pointer,
      `${bucket}/channels/${o.channel}.json`,
      "--cache-control",
      "no-cache",
      "--content-type",
      "application/json",
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (o.distribution)
    capture(aws, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      o.distribution,
      "--paths",
      `/channels/${o.channel}.json`,
    ]);
  ok(`channel ${o.channel} now serves web UI release ${release.id} (${Math.round((Date.now() - started) / 1000)}s)`);
}
