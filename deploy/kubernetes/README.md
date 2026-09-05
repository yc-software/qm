# Kubernetes sandbox prototype

This adds a sandbox backend to QM. Use a core image built from this branch; its
Dockerfile includes kubectl. Configure QM's database, model access, authentication,
and application exposure separately.

## Helm

The existing chart at `deploy/helm` supports an opt-in configuration:

```yaml
kubernetesSandbox:
  enabled: true
  image: your-registry.example/qm-sandbox:prototype
  runtimeClassName: ""
  storageClassName: ""
  storageSize: 10Gi
```

With the option enabled, the chart selects the Kubernetes backend on core, wires
its environment and client label, and creates a dedicated ServiceAccount plus
namespace-scoped Role and RoleBinding. Core uses one replica and Recreate updates.
The chart rejects a missing sandbox image, multiple core replicas, a disabled core,
and conflicting backend variables in `env`, `secretEnv`, or `services.core.env`.
Use `kubernetesSandbox` values for those settings; explicit core variables also
take precedence over imported `envFrom` values.

The sandbox namespace defaults to `<fullname>-sandboxes`. Set
`kubernetesSandbox.namespace` to choose another dedicated namespace. Set
`kubernetesSandbox.createNamespace: false` if it already exists; it must differ
from the core release namespace. The RoleBinding always refers to the core
ServiceAccount in the Helm release namespace.

A chart-created sandbox namespace has `helm.sh/resource-policy: keep` to preserve
resident PVCs on uninstall. Drain runs and remove sandbox Pods before disabling
the option or uninstalling core; dynamically created sandboxes are not Helm-owned.
Retained namespace and PVC cleanup is an explicit operator action. Before a fresh
installation reuses that namespace, set `createNamespace: false`.

The option defaults to false and leaves existing rendered resources unchanged.
RuntimeClass is optional; its name refers to an operator-configured runtime.
Build and publish the sandbox image as described below before enabling it.

## Manual deployment

Run one core replica inside the cluster. Its Pod must use
`serviceAccountName: qm-sandbox-manager` and the label
`qm.dev/sandbox-client: "true"`. The manual RBAC below is an alternative to the
chart-managed resources; do not apply both configurations.

Create the core namespace `qm` first, then apply `sandbox-rbac.yaml`. Change both
namespace names and the RoleBinding subject if your deployment uses other names.
The service account has lifecycle permissions only in `qm-sandboxes`. Sandbox Pods
have no service account token. Do not assign this account to untrusted workloads.

Build and publish an amd64 sandbox image from the existing local Dockerfile:

```sh
export LOCAL_SANDBOX_IMAGE=your-registry.example/qm-sandbox:prototype
npm run sandbox:local:build
docker push "$LOCAL_SANDBOX_IMAGE"
```

Set these environment variables on core, using an immutable image tag or digest:

```text
SANDBOX_BACKEND=kubernetes
KUBERNETES_SANDBOX_IMAGE=your-registry.example/qm-sandbox:prototype
KUBERNETES_SANDBOX_NAMESPACE=qm-sandboxes
KUBERNETES_CORE_NAMESPACE=qm
KUBERNETES_SANDBOX_STORAGE_SIZE=10Gi
```

Omit `KUBERNETES_SANDBOX_RUNTIME_CLASS` to use the cluster default runtime,
commonly runc. To select another runtime, set it to an existing RuntimeClass name:

```text
KUBERNETES_SANDBOX_RUNTIME_CLASS=your-runtime-class
```

The class can select a runtime such as gVisor or Kata. Class names are defined by
the operator; the backend does not assume a particular name or install runtimes.
Verify image and tool compatibility with the selected runtime.

`KUBERNETES_SANDBOX_STORAGE_CLASS` optionally
selects an existing StorageClass; otherwise the cluster default applies. Nodes
must be able to pull the image; this prototype does not configure imagePullSecrets.
Pods request and limit 1 CPU / 1 GiB and select amd64 nodes.

The local image starts the existing HTTP daemon on port 8080. Core must reach Pod
IPs directly. A NetworkPolicy admits traffic only from the core namespace AND the
core Pod label above. Use a CNI that enforces NetworkPolicy. Other policies can
add access because Kubernetes policies are additive; use a dedicated sandbox
namespace. Host/node access is outside this policy's isolation guarantee. The
backend does not enforce outbound network restrictions.

Parking removes the Pod and policy but retains its ReadWriteOnce PVC. Reprovisioning
mounts the same /root; scratch runs instead use emptyDir and retain no files after
teardown. Process-session records also use a Pod-local emptyDir; sessions are lost
on Pod replacement, so stale PIDs cannot be signaled in a new Pod. Files elsewhere in the image do not persist. Unlike Docker volumes, a
new PVC starts empty and does not copy image contents from /root. The shared image
must keep required tools outside /root. Initialization creates the workspace and
credential links.

Use one core replica: lifecycle reference counts and serialization are in memory.
Do not run a second core against the same organization/namespace, including during
a rolling update; use Recreate. After a crash, reprovision can reuse a Pod, but there
is no orphan sweeper. A failed new provision cleans up its new Pod/policy and keeps
any PVC for recovery. Inspect resources labeled `qm.dev/sandbox=true` when cleaning
up; deleting PVCs deletes resident workspace data according to the storage policy.

Before changing image, runtime, resource limits, or core namespace, drain active
runs, stop core, and remove the managed sandbox Pods and NetworkPolicies while
keeping PVCs. An existing policy with a different configuration causes a closed
failure instead of silently keeping stale access rules.

Validation in this branch covers mocked Kubernetes lifecycle/API failures and the
shared subprocess runner. Before deployment, verify actual image startup, core to
daemon connectivity, denied peer-sandbox access, exec/file operations, park/resume,
process sessions, cancellation, and destructive teardown on a disposable scope.
No live Kubernetes runtime validation is claimed.
