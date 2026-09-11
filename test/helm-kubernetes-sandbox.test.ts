import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

const skip = spawnSync("helm", ["version", "--short"]).status !== 0 ? "helm is required" : false;
const base = ["template", "demo", "deploy/helm", "--namespace", "core"];
const enabled = ["--set", "kubernetesSandbox.enabled=true", "--set", "kubernetesSandbox.image=example.test/sandbox:v1"];
const render = (args: string[] = []) => execFileSync("helm", [...base, ...args], { encoding: "utf8" });
const coreDoc = (yaml: string) =>
  yaml.split("---").find((doc) => doc.includes("kind: Deployment") && doc.includes("name: demo-qm-core\n"))!;

test("disabled Kubernetes integration adds no sandbox permissions or core settings", { skip }, () => {
  const yaml = render();
  assert.doesNotMatch(yaml, /kind: (Namespace|ServiceAccount|Role|RoleBinding)\n/);
  assert.doesNotMatch(yaml, /qm.dev\/sandbox-client|KUBERNETES_SANDBOX_|type: Recreate/);
});

test("enabled integration scopes permissions and runtime settings to core", { skip }, () => {
  const yaml = render(enabled);
  const core = coreDoc(yaml);
  assert.match(core, /type: Recreate/);
  assert.match(core, /rollingUpdate: null/);
  assert.match(core, /qm.dev\/sandbox-client: "true"/);
  assert.match(core, /serviceAccountName: demo-qm-sandbox-manager/);
  assert.match(core, /name: SANDBOX_BACKEND\s+value: "kubernetes"/);
  assert.match(core, /name: KUBERNETES_CORE_NAMESPACE\s+value: "core"/);
  assert.match(core, /name: KUBERNETES_SANDBOX_NAMESPACE\s+value: "demo-qm-sandboxes"/);
  assert.match(core, /name: KUBERNETES_SANDBOX_RUNTIME_CLASS\s+value: ""/);
  for (const doc of yaml.split("---").filter((doc) => doc.includes("kind: Deployment") && doc !== core)) {
    assert.doesNotMatch(doc, /sandbox-manager|sandbox-client|KUBERNETES_SANDBOX_|type: Recreate/);
  }
  assert.doesNotMatch(yaml, /kind: ClusterRole/);
  const role = yaml.split("---").find((doc) => doc.includes("kind: Role\n"))!;
  assert.match(role, /namespace: demo-qm-sandboxes/);
  assert.match(role, /resources: \[pods, persistentvolumeclaims\]/);
  assert.doesNotMatch(role, /secrets|pods\/exec|\*/);
  const binding = yaml.split("---").find((doc) => doc.includes("kind: RoleBinding"))!;
  assert.match(binding, /namespace: demo-qm-sandboxes/);
  assert.match(binding, /subjects:[\s\S]*name: demo-qm-sandbox-manager\s+namespace: core/);
  assert.match(yaml, /helm.sh\/resource-policy: keep/);
});

test("existing namespace and arbitrary RuntimeClass are configurable", { skip }, () => {
  const yaml = render([
    ...enabled,
    "--set",
    "kubernetesSandbox.namespace=workers",
    "--set",
    "kubernetesSandbox.createNamespace=false",
    "--set",
    "kubernetesSandbox.runtimeClassName=custom-runtime",
    "--set",
    "kubernetesSandbox.storageClassName=fast",
    "--set",
    "kubernetesSandbox.storageSize=20Gi",
  ]);
  assert.doesNotMatch(yaml, /kind: Namespace\n/);
  const core = coreDoc(yaml);
  assert.match(core, /name: KUBERNETES_SANDBOX_NAMESPACE\s+value: "workers"/);
  assert.match(core, /name: KUBERNETES_SANDBOX_RUNTIME_CLASS\s+value: "custom-runtime"/);
  assert.match(core, /name: KUBERNETES_SANDBOX_STORAGE_CLASS\s+value: "fast"/);
  assert.match(core, /name: KUBERNETES_SANDBOX_STORAGE_SIZE\s+value: "20Gi"/);
});

test("invalid enabled configurations fail rendering", { skip }, () => {
  for (const [value, message] of [
    ["kubernetesSandbox.image=", "image is required"],
    ["services.core.replicas=2", "replicas=1"],
    ["services.core.replicas=0", "replicas=1"],
    ["services.core.enabled=false", "requires services.core.enabled"],
    ["kubernetesSandbox.namespace=core", "must differ"],
    ["kubernetesSandbox.namespace=Bad_Name", "valid namespace name"],
    ["env.SANDBOX_BACKEND=local", "configure SANDBOX_BACKEND"],
    ["env.SANDBOX_BACKEND=", "configure SANDBOX_BACKEND"],
    ["services.core.env.KUBERNETES_CORE_NAMESPACE=elsewhere", "configure KUBERNETES_CORE_NAMESPACE"],
    ["secretEnv.SANDBOX_BACKEND=local", "configure SANDBOX_BACKEND"],
  ]) {
    const result = spawnSync("helm", [...base, ...enabled, "--set", value!], { encoding: "utf8" });
    assert.notEqual(result.status, 0, value);
    assert.ok(result.stderr.includes(message!), result.stderr);
  }
});
