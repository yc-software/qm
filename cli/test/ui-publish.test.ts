import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUiPublish } from "../src/commands/ui.ts";

function fakeAws(dir: string): { calls: () => string[][]; pointer: () => string } {
  const log = join(dir, "calls.jsonl");
  const pointer = join(dir, "pointer.json");
  const bin = join(dir, "aws");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[1] === "cp" && args[3]?.includes("/channels/")) fs.copyFileSync(args[2], ${JSON.stringify(pointer)});
if (args[1] === "cp" && args[3] === "-") process.stdout.write(JSON.stringify({ id: "0123456789abcdef", protocol: 1 }));
`,
    { mode: 0o755 },
  );
  process.env.AWS_BIN = bin;
  return {
    calls: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
    pointer: () => readFileSync(pointer, "utf8"),
  };
}

test("publish uploads assets, then the release documents, then repoints the channel and invalidates it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ui-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, "dist-web");
  mkdirSync(join(dist, "assets"), { recursive: true });
  for (const name of ["index.html", "shared.html"]) writeFileSync(join(dist, name), "<html></html>");
  writeFileSync(join(dist, "release.json"), JSON.stringify({ id: "fedcba9876543210", protocol: 1 }));
  const aws = fakeAws(dir);
  runUiPublish({ bucket: "ui-bucket", channel: "pr-42", dir: dist, distribution: "E123" });
  const calls = aws.calls();
  assert.deepEqual(
    calls.map((c) => [c[0], c[1], c.find((a) => a.startsWith("s3://")) ?? c.at(-1)]),
    [
      ["s3", "sync", "s3://ui-bucket/assets"],
      ["s3", "cp", "s3://ui-bucket/releases/fedcba9876543210/index.html"],
      ["s3", "cp", "s3://ui-bucket/releases/fedcba9876543210/shared.html"],
      ["s3", "cp", "s3://ui-bucket/releases/fedcba9876543210/release.json"],
      ["s3", "cp", "s3://ui-bucket/channels/pr-42.json"],
      ["cloudfront", "create-invalidation", "/channels/pr-42.json"],
    ],
  );
  assert.ok(calls[0]!.includes("*.gz"));
  assert.deepEqual(JSON.parse(aws.pointer()), { id: "fedcba9876543210", protocol: 1 });
});

test("publish --release repoints a channel at an existing release without uploading", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ui-rollback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const aws = fakeAws(dir);
  runUiPublish({ bucket: "ui-bucket", channel: "live", dir: join(dir, "absent"), release: "0123456789abcdef" });
  assert.deepEqual(
    aws.calls().map((c) => [c[0], c[1], c.find((a) => a.startsWith("s3://"))]),
    [
      ["s3", "cp", "s3://ui-bucket/releases/0123456789abcdef/release.json"],
      ["s3", "cp", "s3://ui-bucket/channels/live.json"],
    ],
  );
  assert.deepEqual(JSON.parse(aws.pointer()), { id: "0123456789abcdef", protocol: 1 });
});

test("publish refuses an unbuilt directory and a malformed channel", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ui-refuse-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  fakeAws(dir);
  assert.throws(() => runUiPublish({ bucket: "b", channel: "live", dir }), /build the web UI first/);
  assert.throws(() => runUiPublish({ bucket: "b", channel: "../x", dir }), /--channel must be/);
});
