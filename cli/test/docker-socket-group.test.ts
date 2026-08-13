import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerSocketGroupArgs } from "../src/backends/docker.ts";

test("a mounted docker socket owned by a real group is joined by gid", () => {
  const dir = mkdtempSync(join(tmpdir(), "sock-gid-"));
  const sock = join(dir, "docker.sock");
  writeFileSync(sock, "");
  const gid = statSync(sock).gid;
  const args = dockerSocketGroupArgs(sock);
  if (gid > 0) assert.deepEqual(args, ["--group-add", String(gid)]);
  else assert.deepEqual(args, [], "a root-group socket needs no supplementary group");
});

test("a socket owned by root's group adds nothing", () => {
  assert.deepEqual(dockerSocketGroupArgs("/proc/1/cmdline"), []);
});

test("a missing socket adds nothing", () => {
  assert.deepEqual(dockerSocketGroupArgs(join(tmpdir(), "definitely-absent-docker.sock")), []);
});
