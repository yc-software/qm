# Kubernetes sandbox via kubectl

Status: prototype for discussion; not tested on a live Kubernetes cluster.

QM already has an HTTP execution daemon and an image that runs it. A Kubernetes
backend can reuse `local/Dockerfile`, `aws/microvm-agent/agent.mjs`, and the shared
file, backup, and process-session helpers. The directory names do not require Fly
or AWS at runtime.

Use the existing subprocess execution pattern for `kubectl`. Send resource JSON
through stdin (`create -f -`), without a Kubernetes SDK or a cluster operator.
Add `SANDBOX_BACKEND=kubernetes` and an optional RuntimeClass setting. Kubernetes
selects the configured runtime. Omitting RuntimeClass uses the cluster default,
commonly runc; an operator can instead select a class backed by gVisor or Kata.
RuntimeClass names and runtime installation belong to cluster configuration.

Each writable scope gets a Pod and a PVC. Parking deletes the Pod and preserves
the PVC; destroying also deletes the PVC. Scratch sandboxes use emptyDir. Resource
names include the organization and scope identity. Reads check ownership; deletes
include a UID precondition. API errors must not be mistaken for missing objects.

Core runs inside the cluster and reaches the daemon at the current Pod IP. The
daemon has no authentication, so each sandbox gets a NetworkPolicy allowing port
8080 only from labeled core Pods in the configured core namespace. Operators must
use a CNI that enforces NetworkPolicy and restrict access to core's service account.
Sandbox Pods receive no Kubernetes service account token or host Docker socket.

The first prototype targets amd64, one core replica, and one writable layer per
sandbox. It does not install container runtimes, configure nodes, provide cloud
deployment CLI integration, enforce egress restrictions, or reconcile orphan
resources after a core crash. Isolation depends on the selected cluster runtime.
The PVC persists /root, not packages installed elsewhere in the container.

The existing Helm chart exposes this through `kubernetesSandbox.enabled`, disabled
by default, with core configuration and namespace-scoped RBAC.

See [deployment notes](../deploy/kubernetes/README.md) for the operator contract.
A follow-up should validate real Pod scheduling, runtime compatibility, NetworkPolicy
isolation, PVC resume, cancellation, and process sessions before production use.
