import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createSdkModalClient,
  modalEgressAllowlist,
  MODAL_EXEC_GRACE_MS,
  MODAL_MAX_EXEC_ARG_BYTES,
} from "../src/sandbox/modal-client.ts";
import { createSdkE2bClient } from "../src/sandbox/e2b-client.ts";

const modalCalls: unknown[][] = [];
const modalCreateParams: Record<string, unknown>[] = [];
const modalExecs: { args: string[]; params: Record<string, unknown> }[] = [];
const modalWrites: { path: string; bytes: number }[] = [];
const modalRunning = new Map<string, boolean>();
class SandboxFilesystemFileTooLargeError extends Error {
  override name = "SandboxFilesystemFileTooLargeError";
}
const modalSandbox = {
  sandboxId: "sb-native",
  async exec(args: string[], params: Record<string, unknown>) {
    if (typeof params.timeoutMs === "number" && params.timeoutMs % 1000 !== 0)
      throw new Error(`timeoutMs must be a multiple of 1000ms, got ${params.timeoutMs}`);
    modalExecs.push({ args, params });
    return { stdout: { readText: async () => "ok" }, stderr: { readText: async () => "" }, wait: async () => 0 };
  },
  filesystem: {
    async writeBytes(data: Uint8Array, path: string) {
      modalWrites.push({ path, bytes: data.byteLength });
    },
    async readBytes(path: string) {
      if (path.endsWith("huge.bin")) throw new SandboxFilesystemFileTooLargeError("file too large");
      return new Uint8Array([1]);
    },
  },
  async snapshotDirectory(path: string, options: unknown) {
    modalCalls.push(["snapshot", path, options]);
    return { imageId: "im-native" };
  },
  async mountImage(path: string, image: unknown) {
    modalCalls.push(["mount", path, image]);
  },
};
mock.module("modal", {
  namedExports: {
    ModalClient: class {
      apps = { fromName: async () => ({ appId: "ap-1" }) };
      images = { fromRegistry: () => ({}), fromId: async (imageId: string) => ({ imageId }) };
      sandboxes = {
        create: async (_app: unknown, _image: unknown, params: Record<string, unknown>) => {
          modalCreateParams.push(params);
          return modalSandbox;
        },
        list: async function* (params: { appId?: string; tags?: Record<string, string> }) {
          modalCalls.push(["list", params]);
          for (const [sandboxId, running] of modalRunning) yield { sandboxId, poll: async () => (running ? null : 0) };
        },
      };
    },
  },
});

const e2bCalls: unknown[][] = [];
let pauseError: Error | undefined;
mock.module("e2b", {
  namedExports: {
    Sandbox: class {
      static async create(template: string, options: unknown) {
        e2bCalls.push(["create", template, options]);
        return {
          sandboxId: "e2b-native",
          async pause(options: unknown) {
            e2bCalls.push(["pause", options]);
            if (pauseError) throw pauseError;
            return false;
          },
        };
      }
      static async getInfo() {
        e2bCalls.push(["info"]);
        return { state: "paused", endAt: new Date(1000), lifecycle: { onTimeout: "pause" } };
      }
    },
  },
});

test("Modal native directory snapshot has a ten-minute timeout, finite retention, and restores the exact image", async () => {
  const client = createSdkModalClient({
    tokenId: "id",
    tokenSecret: "secret",
    appName: "test",
    image: "ubuntu",
    snapshotRetentionMs: 60_000,
  });
  const session = await client.create({ name: "test" });
  const before = Date.now();
  const snapshot = await session.snapshotHome!();
  assert.deepEqual(modalCalls[0], ["snapshot", "/root", { ttlMs: 60_000, timeoutMs: 600_000 }]);
  assert.ok(snapshot.expiresAtMs >= before + 60_000);
  await session.restoreHome!(snapshot.imageId);
  assert.deepEqual(modalCalls[1], ["mount", "/root", { imageId: "im-native" }]);
  assert.equal(client.lifetimeMs, 24 * 3600_000);
});

test("Modal exec deadlines are whole seconds with a single grace margin, even near a snapshot deadline", async () => {
  const client = createSdkModalClient({ tokenId: "id", tokenSecret: "secret", appName: "test", image: "ubuntu" });
  const session = await client.create({});
  modalExecs.length = 0;
  await session.runCommand("wc -c < /root/.qm-home.tar", { timeoutMs: 12_345 });
  await session.runCommand("true", { timeoutMs: 7 });
  await session.runCommand("true");
  assert.deepEqual(
    modalExecs.map((call) => call.params.timeoutMs),
    [13_000 + MODAL_EXEC_GRACE_MS, 1000 + MODAL_EXEC_GRACE_MS, 3600_000 + MODAL_EXEC_GRACE_MS],
  );
  assert.deepEqual(modalExecs[0]!.args, ["sh", "-c", "wc -c < /root/.qm-home.tar"]);
});

test("Modal passes command env through exec and spools oversized commands through the filesystem", async () => {
  const client = createSdkModalClient({ tokenId: "id", tokenSecret: "secret", appName: "test", image: "ubuntu" });
  const session = await client.create({});
  modalExecs.length = 0;
  modalWrites.length = 0;
  await session.runCommand("echo $SECRET_TOKEN", { env: { SECRET_TOKEN: "s3cret" } });
  assert.deepEqual(modalExecs[0]!.params.env, { SECRET_TOKEN: "s3cret" });
  assert.ok(!modalExecs[0]!.args[2]!.includes("s3cret"));
  await session.runCommand("true", { env: {} });
  assert.equal("env" in modalExecs[1]!.params, false);
  const huge = `printf '%s' '${"A".repeat(MODAL_MAX_EXEC_ARG_BYTES)}' | base64 -d`;
  await session.runCommand(huge);
  assert.equal(modalWrites.length, 1);
  assert.equal(modalWrites[0]!.bytes, Buffer.byteLength(huge));
  assert.match(modalWrites[0]!.path, /^\/tmp\/\.qm-exec-[0-9a-f-]{36}\.sh$/);
  assert.equal(modalExecs[2]!.args[2], `sh ${modalWrites[0]!.path}; rc=$?; rm -f ${modalWrites[0]!.path}; exit $rc`);
  assert.ok(Buffer.byteLength(modalExecs[2]!.args[2]!) < MODAL_MAX_EXEC_ARG_BYTES);
});

test("Modal creates sandboxes with a real reservation, an idle backstop, tags and the egress allowlist", async () => {
  modalCreateParams.length = 0;
  const bare = createSdkModalClient({ tokenId: "id", tokenSecret: "secret", appName: "test", image: "ubuntu" });
  await bare.create({ name: "qm-scope", tags: { "qm-kind": "scope" } });
  assert.deepEqual(modalCreateParams[0], {
    name: "qm-scope",
    tags: { "qm-kind": "scope" },
    timeoutMs: 24 * 3600_000,
    idleTimeoutMs: 12 * 3600_000,
    cpu: 1,
    memoryMiB: 2048,
  });
  const tuned = createSdkModalClient({
    tokenId: "id",
    tokenSecret: "secret",
    appName: "test",
    image: "ubuntu",
    cpus: 4,
    memoryMb: 8192,
    regions: ["us-west-2"],
    idleTimeoutMs: 6 * 3600_000 + 1,
    egressProxyUrl: "https://egress.example.com",
  });
  await tuned.create({});
  assert.deepEqual(modalCreateParams[1], {
    timeoutMs: 24 * 3600_000,
    idleTimeoutMs: 6 * 3600_000 + 1000,
    cpu: 4,
    memoryMiB: 8192,
    regions: ["us-west-2"],
    outboundDomainAllowlist: ["egress.example.com"],
  });
  assert.deepEqual(modalEgressAllowlist("http://10.1.2.3:3128"), { outboundCidrAllowlist: ["10.1.2.3/32"] });
  assert.deepEqual(modalEgressAllowlist("http://[2001:db8::1]:3128"), { outboundCidrAllowlist: ["2001:db8::1/128"] });
  assert.throws(() => modalEgressAllowlist("http://egress.example.com:3128"), /https URL on port 443/);
  assert.throws(() => modalEgressAllowlist("https://egress.example.com:8443"), /https URL on port 443/);
});

test("Modal lists running tagged sandboxes within the app and reports oversized reads clearly", async () => {
  const client = createSdkModalClient({ tokenId: "id", tokenSecret: "secret", appName: "test", image: "ubuntu" });
  modalRunning.set("sb-live", true);
  modalRunning.set("sb-done", false);
  modalCalls.length = 0;
  const ids: string[] = [];
  for await (const id of client.listRunning!({ "qm-kind": "scope" })) ids.push(id);
  assert.deepEqual(ids, ["sb-live"]);
  assert.deepEqual(modalCalls[0], ["list", { appId: "ap-1", tags: { "qm-kind": "scope" } }]);
  const session = await client.create({});
  assert.deepEqual(await session.readFileBytes("/root/small.bin"), new Uint8Array([1]));
  await assert.rejects(session.readFileBytes("/root/huge.bin"), /exceeds Modal's filesystem read limit/);
});

test("Modal rejects invalid checkpoint retention", () => {
  for (const snapshotRetentionMs of [0, -1, Infinity, NaN]) {
    assert.throws(
      () =>
        createSdkModalClient({
          tokenId: "id",
          tokenSecret: "secret",
          appName: "test",
          image: "ubuntu",
          snapshotRetentionMs,
        }),
      /positive finite/,
    );
  }
});

test("E2B sends explicit pause lifecycle, reads state without connect, and surfaces failed pause", async () => {
  const client = createSdkE2bClient({ apiKey: "test" });
  const session = await client.create({ metadata: { name: "test" }, autoPause: true });
  assert.deepEqual((e2bCalls[0]![2] as { lifecycle: unknown }).lifecycle, { onTimeout: "pause", autoResume: false });
  assert.equal(await client.info!(session.sandboxId).then((info) => info.state), "paused");
  await session.pause();
  assert.deepEqual(e2bCalls.at(-1), ["pause", { keepMemory: true }]);
  pauseError = new Error("snapshot backlog");
  await assert.rejects(session.pause(), /snapshot backlog/);
  pauseError = undefined;
  await client.create({ metadata: {}, autoPause: false });
  assert.deepEqual((e2bCalls.at(-1)![2] as { lifecycle: unknown }).lifecycle, { onTimeout: "kill", autoResume: false });
});
