import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInfo } from "../server/build-info.ts";

test("a release image reports its version and short commit", () => {
  assert.deepEqual(buildInfo({ QM_VERSION: "0.1.13", GIT_SHA: "9143874b0123456789abcdef0123456789abcdef" }), {
    version: "0.1.13",
    sha: "9143874",
  });
});

test("a prerelease version is shown as cut", () => {
  assert.deepEqual(buildInfo({ QM_VERSION: "0.2.0-rc.1" }), { version: "0.2.0-rc.1" });
});

test("a source build reports only its commit, keeping the dirty marker", () => {
  assert.deepEqual(buildInfo({ GIT_SHA: "9143874b0123456789abcdef0123456789abcdef-dirty" }), { sha: "9143874-dirty" });
  assert.deepEqual(buildInfo({ QM_VERSION: "", GIT_SHA: "9143874b" }), { sha: "9143874" });
});

test("unset or malformed build metadata is dropped rather than shown", () => {
  assert.equal(buildInfo({}), undefined);
  assert.equal(buildInfo({ QM_VERSION: "latest", GIT_SHA: "v0.1.13" }), undefined);
  assert.deepEqual(buildInfo({ QM_VERSION: "0.1.13", GIT_SHA: "<script>" }), { version: "0.1.13" });
});
