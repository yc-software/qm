import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUiPublish, uiReleaseId } from "../src/commands/ui.ts";

function withFakeAws(fn: (dir: string, calls: () => string[][]) => void, failHeadObject = false): void {
  const dir = mkdtempSync(join(tmpdir(), "qm-ui-publish-"));
  const log = join(dir, "aws.log");
  const bin = join(dir, "aws");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nfor last; do :; done\ncase "$1 $2" in "s3 cp") case "$3" in /*) [ -f "$3" ] && case "$4" in *channels/live.json) cat "$3" >> ${JSON.stringify(log)};; esac;; esac;; "s3api head-object") ${failHeadObject ? "exit 254" : "exit 0"};; esac\n`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(log, "");
  const previous = process.env.AWS_BIN;
  process.env.AWS_BIN = bin;
  try {
    fn(dir, () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(" ")),
    );
  } finally {
    if (previous === undefined) delete process.env.AWS_BIN;
    else process.env.AWS_BIN = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function build(dir: string, marker: string): string {
  const dist = join(dir, "dist-web");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<html>${marker}</html>`);
  writeFileSync(join(dist, "shared.html"), "<html>shared</html>");
  writeFileSync(join(dist, "assets", "main-1.js"), "js");
  return dist;
}

test("the release id hashes the built documents", () => {
  withFakeAws((dir) => {
    const dist = build(dir, "one");
    const first = uiReleaseId(dist);
    assert.match(first, /^[a-f0-9]{16}$/);
    assert.equal(uiReleaseId(dist), first);
    writeFileSync(join(dist, "index.html"), "<html>two</html>");
    assert.notEqual(uiReleaseId(dist), first);
  });
});

test("publishing uploads assets and documents before moving the live pointer", () => {
  withFakeAws((dir, calls) => {
    const dist = build(dir, "one");
    const id = uiReleaseId(dist);
    runUiPublish({ bucket: "ui-bucket", dir: dist });
    const log = calls();
    const targets = log.map((args) => args.find((arg) => arg.startsWith("s3://")) ?? args.at(-1));
    assert.deepEqual(targets, [
      "s3://ui-bucket/assets",
      `s3://ui-bucket/releases/${id}/index.html`,
      `s3://ui-bucket/releases/${id}/shared.html`,
      "s3://ui-bucket/channels/live.json",
      `{"id":"${id}"}`,
    ]);
    assert.ok(log[0]!.includes("immutable"));
    assert.ok(log[3]!.includes("no-cache"));
  });
});

test("rollback points live at an earlier release without uploading, and refuses one that is missing", () => {
  withFakeAws((dir, calls) => {
    runUiPublish({ bucket: "ui-bucket", dir, release: "0123456789abcdef" });
    assert.deepEqual(
      calls().map((args) => args.slice(0, 2).join(" ")),
      ["s3api head-object", "s3 cp", '{"id":"0123456789abcdef"}'],
    );
  });
  withFakeAws((dir) => {
    assert.throws(
      () => runUiPublish({ bucket: "ui-bucket", dir, release: "0123456789abcdef" }),
      /web UI release 0123456789abcdef is not in s3:\/\/ui-bucket/,
    );
  }, true);
});
