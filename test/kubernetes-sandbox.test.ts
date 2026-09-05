import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKubernetesSandbox } from "../src/sandbox/kubernetes-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { loadConfig } from "../src/config.ts";
import type { CommandExec } from "../src/sandbox/command-exec.ts";

type ObjectResource = {
  kind: string;
  metadata: { name: string; uid: string; labels: Record<string, string> };
  spec: Record<string, any>;
  status?: { phase: string; podIP: string; conditions: { type: string; status: string }[] };
};

function fixture(runtimeClassName?: string) {
  const objects = new Map<string, ObjectResource>();
  const calls: { args: string[]; input?: string }[] = [];
  const requests: { url: string; body: Record<string, string> }[] = [];
  const files = new Map<string, string>();
  const state = { failGet: false, failReady: false, failInitialization: false, failDelete: false, timedOut: false };
  const commandExec: CommandExec = async (args, _timeout, input) => {
    calls.push({ args, input });
    assert.deepEqual(args.slice(0, 2), ["--namespace", "sandboxes"]);
    const [op, kind, name] = args.slice(2);
    if (op === "get") {
      if (state.failGet) return { code: 1, stdout: "", stderr: "Forbidden" };
      const object = objects.get(`${kind}/${name}`);
      return { code: 0, stdout: object ? JSON.stringify(object) : "", stderr: "" };
    }
    if (op === "create") {
      assert.deepEqual(args.slice(3), ["-f", "-"]);
      const object = JSON.parse(input!) as ObjectResource;
      object.metadata.uid = `uid-${calls.length}`;
      if (object.kind === "Pod")
        object.status = { phase: "Running", podIP: "10.42.0.5", conditions: [{ type: "Ready", status: "True" }] };
      objects.set(`${object.kind}/${object.metadata.name}`, object);
    } else if (op === "delete") {
      if (state.failDelete) return { code: 1, stdout: "", stderr: "delete unavailable" };
      const url = args[4]!;
      const object = [...objects.values()].find(
        (o) =>
          url.endsWith(`/${o.metadata.name}`) &&
          url.includes(
            `/${({ Pod: "pods", PersistentVolumeClaim: "persistentvolumeclaims", NetworkPolicy: "networkpolicies" } as Record<string, string>)[o.kind]}/`,
          ),
      );
      assert.ok(object);
      assert.equal(JSON.parse(input!).preconditions.uid, object.metadata.uid);
      objects.delete(`${object.kind}/${object.metadata.name}`);
    } else if (op === "wait" && kind === "--for=condition=Ready" && state.failReady) {
      return { code: 1, stdout: "", stderr: "timed out waiting" };
    } else assert.equal(op, "wait");
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const address = String(url);
    requests.push({ url: address, body });
    if (address.endsWith("/write")) files.set(body.path, body.b64);
    if (address.endsWith("/read"))
      return files.has(body.path) ? Response.json({ b64: files.get(body.path) }) : new Response(null, { status: 404 });
    return Response.json({
      code: state.failInitialization && body.cmd?.includes("mkdir -p") ? 1 : 0,
      stdout: "hello",
      stderr: "",
      timedOut: state.timedOut && !body.cmd?.includes("pgid=$(cat"),
    });
  };
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "qm-k8s-test-")));
  const sandbox = createKubernetesSandbox(workspace, {
    orgId: "test-org",
    namespace: "sandboxes",
    coreNamespace: "core",
    image: "example.test/sandbox:v1",
    runtimeClassName,
    commandExec,
    fetchImpl,
  });
  return { sandbox, objects, calls, requests, state };
}
const layers = [{ scopeId: "personal/test", mode: "rw" as const, mountPath: "" }];

test("Kubernetes config selects the backend and optional RuntimeClass", () => {
  const config = loadConfig({
    SANDBOX_BACKEND: "kubernetes",
    KUBERNETES_SANDBOX_IMAGE: "image:v1",
    KUBERNETES_SANDBOX_RUNTIME_CLASS: "kata",
    KUBERNETES_SANDBOX_NAMESPACE: "sandboxes",
  });
  assert.equal(config.sandboxBackend, "kubernetes");
  assert.equal(config.kubernetesSandbox.runtimeClassName, "kata");
  assert.equal(config.kubernetesSandbox.namespace, "sandboxes");
});

test("creates scoped JSON resources with Kata and restricted daemon ingress", async () => {
  const f = fixture("kata");
  const handle = await f.sandbox.provision(layers);
  const pod = f.objects.get(`Pod/${handle.id}`)!;
  assert.equal(handle.coldStart, true);
  assert.equal(pod.spec.runtimeClassName, "kata");
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.deepEqual(pod.spec.nodeSelector, { "kubernetes.io/arch": "amd64" });
  assert.equal(
    pod.spec.volumes.find((v: { name: string }) => v.name === "home").persistentVolumeClaim.claimName,
    handle.id,
  );
  const policy = f.objects.get(`NetworkPolicy/${handle.id}`)!;
  assert.deepEqual(policy.spec.ingress[0].from, [
    {
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "core" } },
      podSelector: { matchLabels: { "qm.dev/sandbox-client": "true" } },
    },
  ]);
  assert.equal(JSON.parse(f.calls.find((c) => c.args[2] === "create")!.input!).kind, "NetworkPolicy");
});

test("parking retains PVC, resume is warm, destroy uses UID preconditions", async () => {
  const f = fixture();
  const first = await f.sandbox.provision(layers);
  assert.equal(f.objects.get(`Pod/${first.id}`)!.spec.runtimeClassName, undefined);
  await f.sandbox.teardown(first);
  assert.deepEqual([...f.objects.keys()], [`PersistentVolumeClaim/${first.id}`]);
  const second = await f.sandbox.provision(layers);
  assert.equal(second.id, first.id);
  assert.equal(second.coldStart, false);
  await f.sandbox.teardown(second, { destroy: true });
  assert.equal(f.objects.size, 0);
});

test("shared handles keep their Pod until the final release", async () => {
  const f = fixture();
  const a = await f.sandbox.provision(layers);
  const b = await f.sandbox.provision(layers);
  await f.sandbox.teardown(a);
  assert.ok(f.objects.has(`Pod/${a.id}`));
  await f.sandbox.teardown(b, { keepWarm: true });
  assert.ok(f.objects.has(`Pod/${a.id}`));
});

test("scratch uses emptyDir and removes all resources even with keepWarm", async () => {
  const f = fixture();
  const handle = await f.sandbox.provision(layers, { scratch: { key: "scratch-1" } });
  assert.deepEqual(
    f.objects.get(`Pod/${handle.id}`)!.spec.volumes.find((v: { name: string }) => v.name === "home").emptyDir,
    {},
  );
  assert.equal(f.objects.has(`PersistentVolumeClaim/${handle.id}`), false);
  await f.sandbox.teardown(handle, { keepWarm: true });
  assert.equal(f.objects.size, 0);
});

test("API errors never become absence or trigger creation", async () => {
  const f = fixture();
  f.state.failGet = true;
  await assert.rejects(f.sandbox.provision(layers), /Forbidden/);
  assert.equal(
    f.calls.some((c) => c.args[2] === "create"),
    false,
  );
});

test("foreign ownership prevents deletion", async () => {
  const f = fixture();
  const h = await f.sandbox.provision(layers);
  f.objects.get(`Pod/${h.id}`)!.metadata.labels["qm.dev/sandbox-owner"] = "another-org";
  await assert.rejects(f.sandbox.teardown(h, { destroy: true }), /unowned/);
  assert.equal(
    f.calls.some((c) => c.args[2] === "delete"),
    false,
  );
});

test("a readiness timeout does not return a usable handle", async () => {
  const f = fixture();
  f.state.failReady = true;
  await assert.rejects(f.sandbox.provision(layers), /timed out/);
  assert.equal(f.requests.length, 0);
  assert.equal(
    [...f.objects.values()].some((o) => o.kind !== "PersistentVolumeClaim"),
    false,
  );
});

test("daemon calls re-resolve Pod IP and round-trip binary file payloads", async () => {
  const f = fixture();
  const h = await f.sandbox.provision(layers, { env: { TEST: "$(touch /tmp/no);'" } });
  const bytes = Buffer.from([0, 255, 123, 10]);
  await f.sandbox.writeFileBytes(h, "binary", bytes);
  assert.deepEqual(await f.sandbox.readFileBytes(h, "binary"), bytes);
  assert.equal(await f.sandbox.readFile(h, "missing"), null);
  f.objects.get(`Pod/${h.id}`)!.status!.podIP = "fd00::123";
  await f.sandbox.run(h, "printf hello");
  assert.equal(f.requests.at(-1)!.url, "http://[fd00::123]:8080/exec");
  assert.ok(f.requests.at(-1)!.body.cmd!.includes("$(touch /tmp/no)"));
  await assert.rejects(f.sandbox.run({ ...h, env: { "BAD;KEY": "x" } }, "true"), /environment key/);
});

test("process records are isolated from the resident home PVC", async () => {
  const f = fixture();
  const h = await f.sandbox.provision(layers);
  const pod = f.objects.get(`Pod/${h.id}`)!;
  assert.deepEqual(
    pod.spec.volumes.find((v: { name: string }) => v.name === "processes"),
    { name: "processes", emptyDir: {} },
  );
  assert.ok(
    pod.spec.containers[0].volumeMounts.some(
      (v: { mountPath: string; name: string }) => v.mountPath === "/root/.agent-proc" && v.name === "processes",
    ),
  );
});

test("timed out execution awaits a process-group cleanup command", async () => {
  const f = fixture();
  const h = await f.sandbox.provision(layers);
  f.state.timedOut = true;
  const result = await f.sandbox.run(h, "sleep 100", { timeoutMs: 1000 });
  assert.equal(result.timedOut, true);
  assert.ok(f.requests.at(-2)!.body.cmd!.startsWith("exec setsid"));
  assert.ok(f.requests.at(-1)!.body.cmd!.includes('kill -KILL -"$pgid"'));
});

test("scratch provisioning failure cleans up without a returned handle", async () => {
  const f = fixture();
  f.state.failReady = true;
  await assert.rejects(f.sandbox.provision(layers, { scratch: { key: "fails" } }), /timed out/);
  assert.equal(f.objects.size, 0);
});

test("a completed Pod is replaced after its final handle is released", async () => {
  const f = fixture();
  const h = await f.sandbox.provision(layers);
  const oldUid = f.objects.get(`Pod/${h.id}`)!.metadata.uid;
  await f.sandbox.teardown(h, { keepWarm: true });
  f.objects.get(`Pod/${h.id}`)!.status!.phase = "Succeeded";
  const resumed = await f.sandbox.provision(layers);
  assert.equal(resumed.coldStart, false);
  assert.notEqual(f.objects.get(`Pod/${h.id}`)!.metadata.uid, oldUid);
});

test("a failed second provision preserves the active sandbox", async () => {
  const f = fixture();
  const h = await f.sandbox.provision(layers);
  const uid = f.objects.get(`Pod/${h.id}`)!.metadata.uid;
  f.state.failInitialization = true;
  await assert.rejects(f.sandbox.provision(layers), /initialization failed/);
  assert.equal(f.objects.get(`Pod/${h.id}`)!.metadata.uid, uid);
  assert.ok(f.objects.has(`NetworkPolicy/${h.id}`));
  await f.sandbox.teardown(h, { destroy: true });
  assert.equal(f.objects.size, 0);
});

test("initialization failure cleans up a new Pod while preserving its PVC", async () => {
  const f = fixture();
  f.state.failInitialization = true;
  await assert.rejects(f.sandbox.provision(layers), /initialization failed/);
  assert.deepEqual(
    [...f.objects.values()].map((o) => o.kind),
    ["PersistentVolumeClaim"],
  );
});

test("failed Pod deletion keeps the ingress policy in place", async () => {
  const f = fixture();
  const h = await f.sandbox.provision(layers);
  f.state.failDelete = true;
  await assert.rejects(f.sandbox.teardown(h, { destroy: true }), /delete unavailable/);
  assert.ok(f.objects.has(`Pod/${h.id}`));
  assert.ok(f.objects.has(`PersistentVolumeClaim/${h.id}`));
  assert.ok(f.objects.has(`NetworkPolicy/${h.id}`));
});
