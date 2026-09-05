import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dockerSocketCandidates,
  dockerSocketMountArgs,
  dockerSocketProbeArgs,
  resolveDockerSocket,
} from "../src/backends/docker.ts";

test("forwarded macOS Docker sockets prefer the daemon-side socket", () => {
  for (const dockerHost of [
    "unix:///Users/operator/.colima/default/docker.sock",
    "unix:///Users/operator/.docker/run/docker.sock",
    "unix:///Users/operator/.orbstack/run/docker.sock",
  ]) {
    assert.deepEqual(dockerSocketCandidates(dockerHost, "darwin"), [
      "/var/run/docker.sock",
      dockerHost.slice("unix://".length),
    ]);
  }
});

test("explicit native and rootless Linux sockets stay authoritative", () => {
  assert.deepEqual(dockerSocketCandidates(undefined, "linux"), ["/var/run/docker.sock"]);
  assert.deepEqual(dockerSocketCandidates("unix:///var/run/docker.sock", "linux"), ["/var/run/docker.sock"]);
  assert.deepEqual(dockerSocketCandidates("unix:///run/user/1000/docker.sock", "linux"), [
    "/run/user/1000/docker.sock",
  ]);
  assert.deepEqual(dockerSocketCandidates("unix:///home/operator/.docker/desktop/docker.sock", "linux"), [
    "/var/run/docker.sock",
    "/home/operator/.docker/desktop/docker.sock",
  ]);
});

test("local sandboxes reject invalid Docker transports", () => {
  assert.throws(
    () => dockerSocketCandidates("tcp://docker.example.test:2376", "linux"),
    /requires a Unix Docker socket/,
  );
  assert.throws(() => dockerSocketCandidates("unix://", "linux"), /requires a Unix Docker socket path/);
  assert.throws(() => dockerSocketCandidates("unix:///tmp/a,b.sock", "linux"), /cannot contain a comma/);
});

test("socket probing bypasses image entrypoints and uses a read-only daemon-side mount", () => {
  assert.deepEqual(dockerSocketProbeArgs("/var/run/docker.sock", "qm-core:local"), [
    "run",
    "--rm",
    "--entrypoint",
    "/bin/stat",
    "--mount",
    "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly",
    "qm-core:local",
    "-c",
    "%g",
    "/var/run/docker.sock",
  ]);
});

test("socket resolution validates GIDs and falls back only for forwarded clients", () => {
  const calls: string[][] = [];
  const socket = resolveDockerSocket(
    "qm-core:local",
    "unix:///Users/operator/.colima/default/docker.sock",
    "darwin",
    (args) => {
      calls.push(args);
      if (args.some((arg) => arg.includes("source=/var/run/docker.sock"))) throw new Error("missing");
      return "991\n";
    },
  );
  assert.deepEqual(socket, { path: "/Users/operator/.colima/default/docker.sock", gid: "991" });
  assert.equal(calls.length, 2);
  assert.throws(
    () => resolveDockerSocket("qm-core:local", undefined, "linux", () => "not-a-gid"),
    /cannot mount the Docker daemon socket/,
  );
  assert.throws(
    () =>
      resolveDockerSocket("qm-core:local", undefined, "linux", () => {
        throw new Error("probe failed");
      }),
    /cannot mount the Docker daemon socket/,
  );
});

test("socket mount args preserve group access and reject mount delimiters", () => {
  assert.deepEqual(dockerSocketMountArgs({ path: "/var/run/docker.sock", gid: "991" }), [
    "--mount",
    "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
    "--group-add",
    "991",
  ]);
  assert.throws(() => dockerSocketProbeArgs("/tmp/a,b.sock", "qm-core:local"), /cannot contain a comma/);
  assert.throws(() => dockerSocketMountArgs({ path: "/tmp/a,b.sock", gid: "991" }), /cannot contain a comma/);
});
