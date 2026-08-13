import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalSandbox,
  localContainerName,
  localMigrationOwnerName,
  localNetworkName,
  localVolumeName,
} from "../src/sandbox/local-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { sleep } from "../src/util/async.ts";
import { shortHash } from "../src/util/crypto.ts";
import { scopeId } from "../src/types.ts";
import { installFakeDocker, type FakeDocker } from "./support/fake-docker.ts";

const tmp = mkdtempSync(join(tmpdir(), "local-sbx-"));
const guestHome = join(tmp, "home");
let daemon: ChildProcess;
let daemonPort = 0;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

before(async () => {
  daemonPort = await freePort();
  daemon = spawn(process.execPath, [join(process.cwd(), "aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(daemonPort), HOME: guestHome },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`);
      if (res.status === 200) return;
    } catch {
      if (Date.now() > deadline) throw new Error("test daemon never became reachable");
    }
    await sleep(100);
  }
});

after(() => {
  daemon?.kill("SIGKILL");
});

function makeSandbox(fake: FakeDocker, opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  return createLocalSandbox(createLocalWorkspaceStore(dir), {
    dockerExec: fake.dockerExec,
    homeDir: guestHome,
    repoRoot: tmp,
    ...opts,
  });
}
const rw = (scope: string) => [{ scopeId: scope, mountPath: "", mode: "rw" as const }];
const legacySlug = (id: string): string => {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
};

function seedMigrationOwner(fake: FakeDocker, scope: string, volume: string, orgId = "acme"): void {
  const name = localMigrationOwnerName(scope, orgId);
  fake.containers.set(name, {
    name,
    imageId: fake.imageId,
    running: true,
    labels: { "qm.volume-owner": "1", "qm.volume-org": orgId, "qm.scope": scope },
    volume,
  });
}

test("profile declares the local Docker substrate honestly", () => {
  const sb = makeSandbox(installFakeDocker(daemonPort));
  assert.equal(sb.profile.backend, "local-docker");
  assert.equal(sb.profile.writablePersistence, "resident_disk");
  assert.equal(sb.profile.processSessions, true);
  assert.equal(supportsProcessSessions(sb), true);
});

test("a stopped Docker daemon fails provision with the actionable message", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.daemonDown = true;
  const sb = makeSandbox(fake);
  await assert.rejects(
    sb.provision(rw(scopeId("personal", "U0"))),
    /requires a running Docker daemon \(is Docker Desktop running\?\)/,
  );
});

test("a missing sandbox image fails provision with the build hint", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.imageMissing = true;
  const sb = makeSandbox(fake);
  await assert.rejects(sb.provision(rw(scopeId("personal", "U0"))), /not found — run `npm run sandbox:local:build`/);
});

test("cold provision creates volume + container, run() execs over the daemon, bytes round-trip", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U1");
  const h = await sb.provision(rw(scope));
  assert.equal(h.id, localContainerName(scope));
  assert.equal(h.rootDir, `${guestHome}/workspace`);
  assert.equal(h.homeDir, guestHome);
  assert.equal(h.coldStart, true);
  assert.equal(fake.runCount, 1);
  assert.equal(fake.volumes.has(localVolumeName(scope)), true);
  const c = fake.containers.get(h.id)!;
  assert.equal(c.labels["qm.sandbox"], "1");
  assert.equal(c.labels["qm.scope"], scope);
  assert.equal(c.labels["qm.org"], "default-org");
  assert.equal(c.labels["agent_env"], "dev");
  assert.equal(c.volume, localVolumeName(scope));

  const r = await sb.run(h, "echo hello");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "hello");

  const payload = Uint8Array.from([0, 1, 2, 250, 251, 252]);
  await sb.writeFileBytes(h, "bin/blob.dat", payload);
  assert.deepEqual(Uint8Array.from((await sb.readFileBytes(h, "bin/blob.dat"))!), payload);
  assert.equal(await sb.readFileBytes(h, "bin/missing.dat"), null);
});

test("a containerized core reaches the sandbox by name without publishing a host port", async () => {
  const fake = installFakeDocker(daemonPort);
  const urls: string[] = [];
  const sb = makeSandbox(fake, {
    coreContainer: "qm-acme-core",
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      url.hostname = "127.0.0.1";
      url.port = String(daemonPort);
      return fetch(url, init);
    },
  });
  const h = await sb.provision(rw(scopeId("personal", "container-core")));
  const run = fake.commands.find((args) => args[0] === "run")!;
  assert.equal(run.includes("-p"), false);
  assert.ok(
    fake.commands.some(
      (args) =>
        args[0] === "network" &&
        args[1] === "connect" &&
        args.at(-2) === localNetworkName(h.id) &&
        args.at(-1) === "qm-acme-core",
    ),
  );
  assert.ok(urls.some((url) => url.startsWith(`http://${h.id}:8080/`)));
});

test("a replacement core reconnects before using a warm sandbox", async () => {
  const fake = installFakeDocker(daemonPort);
  const core = "qm-acme-core";
  const sb = makeSandbox(fake, {
    coreContainer: core,
    orgId: "acme",
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      url.hostname = "127.0.0.1";
      url.port = String(daemonPort);
      return fetch(url, init);
    },
  });
  const handle = await sb.provision(rw(scopeId("personal", "warm-core")));
  const network = localNetworkName(handle.id);
  fake.networkMembers.get(network)?.delete(core);
  await sb.run(handle, "echo reconnected");
  assert.equal(fake.networkMembers.get(network)?.has(core), true);
});

test("sandbox resources are org-scoped and routed names stay within one DNS label", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "shared-user");
  const first = await makeSandbox(fake, { orgId: "org-a" }).provision(rw(scope));
  const second = await makeSandbox(fake, { orgId: "org-b" }).provision(rw(scope));
  assert.notEqual(first.id, second.id);
  assert.notEqual(localVolumeName(scope, "org-a"), localVolumeName(scope, "org-b"));
  assert.ok(localContainerName("s".repeat(200), "o".repeat(200)).length <= 63);
  const scratch = await makeSandbox(fake, { orgId: "o".repeat(200) }).provision(rw(scope), {
    scratch: { key: "k".repeat(200) },
  });
  assert.ok(scratch.id.length <= 63);
});

test("an owned legacy container and home migrate to org-scoped storage", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "legacy-running");
  const slug = legacySlug(scope);
  const name = `qm-sbx-${slug}`;
  const volume = `qm-home-${slug}`;
  fake.volumes.add(volume);
  fake.containers.set(name, {
    name,
    imageId: fake.imageId,
    running: true,
    labels: { "qm.org": "acme", "qm.scope": scope },
    volume,
  });
  const handle = await makeSandbox(fake, { orgId: "acme" }).provision(rw(scope));
  assert.equal(handle.id, localContainerName(scope, "acme"));
  assert.equal(fake.containers.get(handle.id)?.volume, localVolumeName(scope, "acme"));
  assert.equal(handle.coldStart, false);
  assert.equal(fake.containers.get(localMigrationOwnerName(scope, "acme"))?.running, true);
  assert.equal(
    fake.commands.some((args) => args.some((arg) => arg.includes("rm -rf /to/.qm-local-volume-migrated-v1"))),
    false,
  );
});

test("legacy migration resumes after target creation or completed copy", async () => {
  for (const completed of [false, true]) {
    const fake = installFakeDocker(daemonPort);
    const scope = scopeId("personal", completed ? "legacy-copied" : "legacy-created");
    const slug = legacySlug(scope);
    const name = `qm-sbx-${slug}`;
    const source = `qm-home-${slug}`;
    const target = localVolumeName(scope, "acme");
    fake.volumes.add(source);
    fake.volumes.add(target);
    fake.volumeLabels.set(target, {
      "qm.org": "acme",
      "qm.scope": scope,
      "qm.migration": "legacy-v1",
    });
    if (completed) seedMigrationOwner(fake, scope, target);
    fake.containers.set(name, {
      name,
      imageId: fake.imageId,
      running: false,
      labels: { "qm.org": "acme", "qm.scope": scope },
      volume: source,
    });
    const handle = await makeSandbox(fake, { orgId: "acme" }).provision(rw(scope));
    assert.equal(handle.id, localContainerName(scope, "acme"));
    assert.equal(fake.containers.get(handle.id)?.volume, target);
    assert.equal(fake.containers.has(localMigrationOwnerName(scope, "acme")), true);
  }
});

test("legacy migration resumes after the old container was removed", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "legacy-removed");
  const source = `qm-home-${legacySlug(scope)}`;
  const target = localVolumeName(scope, "acme");
  fake.volumes.add(source);
  fake.volumes.add(target);
  fake.volumeLabels.set(target, {
    "qm.org": "acme",
    "qm.scope": scope,
    "qm.migration": "legacy-v1",
  });
  seedMigrationOwner(fake, scope, target);
  fake.containers.get(localMigrationOwnerName(scope, "acme"))!.running = false;
  const handle = await makeSandbox(fake, { orgId: "acme" }).provision(rw(scope));
  assert.equal(fake.containers.get(handle.id)?.volume, target);
  assert.equal(fake.containers.get(localMigrationOwnerName(scope, "acme"))?.running, true);
  assert.equal(handle.coldStart, false);
});

test("a migration target without its source requires the external ownership record", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "legacy-incomplete-no-source");
  const target = localVolumeName(scope, "acme");
  fake.volumes.add(target);
  fake.volumeLabels.set(target, {
    "qm.org": "acme",
    "qm.scope": scope,
    "qm.migration": "legacy-v1",
  });
  await assert.rejects(makeSandbox(fake, { orgId: "acme" }).provision(rw(scope)), /migration target .* is incomplete/);
});

test("legacy migration refuses to copy a live home when stop fails", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "legacy-stop-fails");
  const slug = legacySlug(scope);
  const name = `qm-sbx-${slug}`;
  const source = `qm-home-${slug}`;
  fake.volumes.add(source);
  fake.containers.set(name, {
    name,
    imageId: fake.imageId,
    running: true,
    labels: { "qm.org": "acme", "qm.scope": scope },
    volume: source,
  });
  fake.failStop = true;
  await assert.rejects(makeSandbox(fake, { orgId: "acme" }).provision(rw(scope)), /migration stop failed/);
  assert.equal(fake.volumes.has(localVolumeName(scope, "acme")), false);
});

test("an orphaned legacy home fails closed without durable ownership evidence", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "legacy-orphan");
  fake.volumes.add(`qm-home-${legacySlug(scope)}`);
  await assert.rejects(
    makeSandbox(fake, { orgId: "acme" }).provision(rw(scope)),
    /has no owning container; copy it into .* labeled qm.org=acme and qm.scope=/,
  );
});

test("an operator-labeled recovery target restores an orphaned legacy home", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "legacy-recovered");
  const source = `qm-home-${legacySlug(scope)}`;
  const target = localVolumeName(scope, "acme");
  fake.volumes.add(source);
  fake.volumes.add(target);
  fake.volumeLabels.set(target, { "qm.org": "acme", "qm.scope": scope });
  const handle = await makeSandbox(fake, { orgId: "acme" }).provision(rw(scope));
  assert.equal(fake.containers.get(handle.id)?.volume, target);
  assert.equal(handle.coldStart, false);
});

test("destroy disconnects the core and removes the isolated sandbox network", async () => {
  const fake = installFakeDocker(daemonPort);
  const core = "qm-acme-core";
  const sb = makeSandbox(fake, {
    coreContainer: core,
    orgId: "acme",
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      url.hostname = "127.0.0.1";
      url.port = String(daemonPort);
      return fetch(url, init);
    },
  });
  const handle = await sb.provision(rw(scopeId("personal", "destroy-network")));
  const network = localNetworkName(handle.id);
  await sb.teardown(handle, { destroy: true });
  assert.equal(fake.networks.has(network), false);
});

test("a failed sandbox run removes its container and core-attached network", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.failRun = true;
  const sb = makeSandbox(fake, { coreContainer: "qm-acme-core", orgId: "acme" });
  await assert.rejects(sb.provision(rw(scopeId("personal", "run-fails"))), /Created state/);
  assert.equal(fake.containers.size, 0);
  assert.equal(fake.networks.size, 0);
});

test("a losing sandbox run never removes the winning concurrent container", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.conflictOnRun = true;
  const scope = scopeId("personal", "run-race");
  const name = localContainerName(scope, "acme");
  await assert.rejects(
    makeSandbox(fake, { coreContainer: "qm-acme-core", orgId: "acme" }).provision(rw(scope)),
    /already in use/,
  );
  assert.equal(fake.containers.get(name)?.labels["qm.provision"], "winning-provision");
  assert.equal(fake.networks.has(localNetworkName(name)), true);
});

test("existing sandbox resources must match their organization, scope, and mount", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "owned-resource");
  const name = localContainerName(scope, "acme");
  const volume = localVolumeName(scope, "acme");
  fake.volumes.add(volume);
  fake.volumeLabels.set(volume, { "qm.org": "other", "qm.scope": scope });
  fake.containers.set(name, {
    name,
    imageId: fake.imageId,
    running: false,
    labels: { "qm.org": "acme", "qm.scope": scope },
    volume,
  });
  await assert.rejects(makeSandbox(fake, { orgId: "acme" }).provision(rw(scope)), /volume .* is not owned/);
});

test("parking removes the isolated bridge and warm reuse rebuilds both attachments", async () => {
  const fake = installFakeDocker(daemonPort);
  const core = "qm-acme-core";
  const scope = scopeId("personal", "park-network");
  const sb = makeSandbox(fake, {
    coreContainer: core,
    orgId: "acme",
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      url.hostname = "127.0.0.1";
      url.port = String(daemonPort);
      return fetch(url, init);
    },
  });
  const first = await sb.provision(rw(scope));
  const network = localNetworkName(first.id);
  await sb.teardown(first);
  assert.equal(fake.networks.has(network), false);
  const second = await sb.provision(rw(scope));
  assert.equal(second.coldStart, false);
  assert.deepEqual(fake.networkMembers.get(network), new Set([core, first.id]));
});

test("teardown parks the container and the next provision restarts it warm", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U2"));
  const h1 = await sb.provision(layers);
  await sb.teardown(h1);
  assert.equal(fake.containers.get(h1.id)!.running, false);

  const h2 = await sb.provision(layers);
  assert.equal(h2.id, h1.id, "same container reused");
  assert.equal(h2.coldStart, false);
  assert.equal(fake.runCount, 1, "no new container run");
  assert.equal(fake.containers.get(h1.id)!.running, true, "restarted");
});

test("a stale-image container is recreated while its home volume survives", async () => {
  const fake = installFakeDocker(daemonPort);
  const layers = rw(scopeId("personal", "U3"));
  const h1 = await makeSandbox(fake).provision(layers);
  const volume = fake.containers.get(h1.id)!.volume!;

  fake.imageId = "sha256:image-v2";
  const h2 = await makeSandbox(fake).provision(layers);
  assert.equal(h2.id, h1.id);
  assert.equal(fake.runCount, 2, "container recreated on the new image");
  assert.equal(fake.containers.get(h2.id)!.imageId, "sha256:image-v2");
  assert.equal(fake.volumes.has(volume), true, "volume survived the recreate");
  assert.equal(h2.coldStart, false, "existing volume means a warm home");
});

test("a scratch box has no volume and is removed on teardown", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U4")), { scratch: { key: "k1" } });
  assert.equal(h.scratch, true);
  assert.equal(h.coldStart, true);
  assert.equal(fake.containers.get(h.id)!.volume, undefined);
  await sb.teardown(h);
  assert.equal(fake.containers.has(h.id), false, "scratch container destroyed");
});

test("teardown destroy removes both the container and its volume", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U5");
  const h = await sb.provision(rw(scope));
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.containers.has(h.id), false);
  assert.equal(fake.volumes.has(localVolumeName(scope)), false);
});

test("concurrent provisions for one scope run a single container", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U6"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  assert.equal(a.id, b.id);
  assert.equal(fake.runCount, 1);
});

test("refcounted teardown: the container parks only after the last concurrent user releases", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U7"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  await sb.teardown(a);
  assert.equal(fake.containers.get(a.id)!.running, true, "still held by the sibling");
  await sb.teardown(b);
  assert.equal(fake.containers.get(b.id)!.running, false, "parked after the last release");
});

test("process sessions: start, read output, signal to exit", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  assert.ok(supportsProcessSessions(sb));
  const h = await sb.provision(rw(scopeId("personal", "U8")));
  const { processId } = await sb.startProcess!(h, "echo started; sleep 30");
  let out = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !out.includes("started")) {
    const r = await sb.readProcess!(h, processId, { waitMs: 200 });
    out += r.chunks;
  }
  assert.match(out, /started/);
  await sb.signalProcess!(h, processId, "TERM");
  let status = (await sb.readProcess!(h, processId, {})).status;
  const exitDeadline = Date.now() + 10_000;
  while (status.state !== "exited" && Date.now() < exitDeadline) {
    await sleep(200);
    status = (await sb.readProcess!(h, processId, {})).status;
  }
  assert.equal(status.state, "exited");
});

test("an aborted run returns control promptly", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U9")));
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  const startedAt = Date.now();
  await sb.run(h, "sleep 30", { signal: ctl.signal }).catch(() => {});
  assert.ok(Date.now() - startedAt < 5_000, "run returned promptly after abort");
});

test("read-only layers materialize into the workspace once per content fingerprint", async () => {
  const fake = installFakeDocker(daemonPort);
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  const workspace = createLocalWorkspaceStore(dir);
  const shared = scopeId("org", "default-org");
  await workspace.write(shared, "guide.md", "shared doc");
  const sb = createLocalSandbox(workspace, { dockerExec: fake.dockerExec, homeDir: guestHome, repoRoot: tmp });
  const h = await sb.provision([
    { scopeId: scopeId("personal", "U10"), mountPath: "", mode: "rw" as const },
    { scopeId: shared, mountPath: "shared", mode: "ro" as const },
  ]);
  assert.equal(await sb.readFile(h, "shared/guide.md"), "shared doc");
});

test("each container runs on its own network; destroy removes it", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scopeA = scopeId("personal", "U20");
  const scopeB = scopeId("personal", "U21");
  const ha = await sb.provision(rw(scopeA));
  const hb = await sb.provision(rw(scopeB));
  const netA = localNetworkName(ha.id);
  const netB = localNetworkName(hb.id);
  assert.notEqual(netA, netB);
  assert.equal(fake.networks.has(netA), true);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(ha, { destroy: true });
  assert.equal(fake.networks.has(netA), false);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(hb);
});

test("concurrent teardown and provision for one scope serialize (no stop of a fresh user)", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U22");
  const h1 = await sb.provision(rw(scope));
  const [, h2] = await Promise.all([sb.teardown(h1), sb.provision(rw(scope))]);
  assert.equal(fake.containers.get(h2.id)!.running, true);
  const r = await sb.run(h2, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
  await sb.teardown(h2);
  assert.equal(fake.containers.get(h2.id)!.running, false);
});
