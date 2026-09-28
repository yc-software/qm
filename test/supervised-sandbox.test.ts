import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createSupervisedSandbox, type SupervisorTrust } from "../src/sandbox/supervised-sandbox.ts";
import type { Sandbox, SandboxHandle, SupervisorTransport } from "../src/sandbox/sandbox.ts";

function fixture() {
  const trust = createMemoryMap<SupervisorTrust>();
  const handle: SandboxHandle = {
    id: "logical-name",
    rootDir: "/workspace",
    env: { AGENT_API_TOKEN: "control-token-for-test" },
  };
  let fresh = true;
  let identity = "physical-generation-one";
  let dispatchFailure = false;
  const commands: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const files = new Map<string, Uint8Array>();
  const transport: SupervisorTransport = {
    ensureDependencies: async () => {},
    identity: async () => identity,
    isFresh: async () => fresh,
    async writeFile(_handle, path, data) {
      files.set(path, data);
    },
    async run(_handle, command) {
      assert.deepEqual(_handle.env, {});
      commands.push(command);
      if (command.includes('echo $! > "$P/pid"')) return { code: 0, timedOut: false, stdout: "OK\n", stderr: "" };
      if (command.includes(" --request ")) {
        if (dispatchFailure) throw new Error("ambiguous provider dispatch");
        const staged = [...files.entries()].find(([path]) => command.includes(path));
        assert.ok(staged);
        const request = JSON.parse(Buffer.from(staged[1]).toString()) as Record<string, unknown>;
        requests.push(request);
        files.delete(staged[0]);
        return {
          code: 0,
          timedOut: false,
          stderr: "",
          stdout: JSON.stringify({ code: 0, timedOut: false, stdout: "ok", stderr: "" }),
        };
      }
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    },
  };
  const raw = {
    profile: { backend: "test", writablePersistence: "resident_disk", processSessions: true },
    supervisorTransport: transport,
    provision: async () => handle,
  } as unknown as Sandbox;
  const sandbox = createSupervisedSandbox(raw, {
    trust,
    lock: createNoopAdvisoryLock(),
    workspace: { list: async () => [] } as never,
  });
  return {
    sandbox,
    transport,
    trust,
    handle,
    commands,
    requests,
    files,
    failDispatch: () => {
      dispatchFailure = true;
    },
    stale: () => {
      fresh = false;
    },
    replace: () => {
      identity = "physical-generation-two";
      fresh = false;
    },
  };
}

test("failed dispatch removes the request before clearing its cancellation marker", async () => {
  const f = fixture();
  f.failDispatch();
  await assert.rejects(f.sandbox.run(f.handle, "true"), /ambiguous provider dispatch/);
  const requestCleanup = f.commands.findIndex((command) => command.startsWith("rm -f ") && command.includes(".json"));
  const cancelCleanup = f.commands.findIndex(
    (command) => command.startsWith("rm -f ") && command.includes(".cancelled"),
  );
  assert.ok(requestCleanup > -1);
  assert.ok(cancelCleanup > requestCleanup);
});

test("supervised execution stages only requested credentials outside command text and clears them afterward", async () => {
  const f = fixture();
  await f.sandbox.run(f.handle, "echo hello", {
    credentials: {
      env: { SECRET: "selected-secret-value" },
      files: [{ path: ".config/tool/token", data: Buffer.from("file-secret-value") }],
    },
  });
  await f.sandbox.run(f.handle, "echo next");
  assert.equal((f.requests[0]!.env as Record<string, string>).SECRET, "selected-secret-value");
  assert.deepEqual(f.requests[0]!.files, [
    { path: ".config/tool/token", contentBase64: Buffer.from("file-secret-value").toString("base64") },
  ]);
  assert.equal((f.requests[1]!.env as Record<string, string>).SECRET, undefined);
  assert.deepEqual(f.requests[1]!.files, []);
  assert.ok(
    f.commands.every((command) => !command.includes("selected-secret-value") && !command.includes("file-secret-value")),
  );
  assert.equal([...f.files.keys()].filter((path) => path.endsWith(".json")).length, 0);
  assert.equal(f.handle.env?.SECRET, undefined);
});

test("a reused logical sandbox name cannot inherit another physical machine's trust", async () => {
  const f = fixture();
  await f.sandbox.run(f.handle, "true");
  f.stale();
  await f.sandbox.run(f.handle, "true");
  f.replace();
  await assert.rejects(f.sandbox.run(f.handle, "true"), /predates execution isolation/);
  assert.equal(f.requests.length, 2);
});

test("legacy computers fail closed without executing or mutating their files", async () => {
  const f = fixture();
  f.stale();
  await assert.rejects(f.sandbox.run(f.handle, "true"), /files have been preserved/);
  assert.deepEqual(f.commands, []);
  assert.equal(f.files.size, 0);
});

test("file reads pass through supervisor rather than privileged provider file APIs", async () => {
  const f = fixture();
  await f.sandbox.readFileBytes(f.handle, "link-to-host");
  assert.equal(f.requests.length, 1);
  assert.match(String(f.requests[0]!.command), /link-to-host/);
  assert.equal((f.requests[0]!.env as Record<string, string>).AGENT_API_TOKEN, undefined);
  await assert.rejects(f.sandbox.readFile(f.handle, "../outside"), /inside the workspace/);
});

test("background start invokes the provider lifecycle hook with the supervisor session identity", async () => {
  const f = fixture();
  const held: string[] = [];
  f.transport.processStarted = async (_handle, id) => {
    held.push(id);
  };
  const started = await f.sandbox.startProcess!(f.handle, "sleep 30");
  assert.deepEqual(held, [started.processId]);
  assert.ok(f.commands.some((command) => command.includes(`/run/qm-supervisor/processes/${started.processId}`)));
});

test("a failed provider process hold kills the started supervisor session", async () => {
  const f = fixture();
  f.transport.processStarted = async () => {
    throw new Error("provider hold unavailable");
  };
  await assert.rejects(f.sandbox.startProcess!(f.handle, "sleep 30"), /provider hold unavailable/);
  assert.ok(f.commands.some((command) => command.includes('kill -KILL -"$pid"')));
});
