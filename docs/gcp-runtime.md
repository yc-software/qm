# GCP runtime adapter

The GCP runtime uses two provider-native contracts:

- `SANDBOX_BACKEND=gke` provisions `SandboxClaim` resources from a named GKE Agent Sandbox template and routes the existing QM agent-daemon protocol through the upstream sandbox router. GKE can satisfy matching claims from a separately managed warm pool.
- `SNAPSHOT_STORE=gcs` and `TRANSFER_STORE=gcs` use Cloud Storage with Application Default Credentials and `GCS_BUCKET`.

The control plane must run with Workload Identity and a namespace-scoped role that can create, get, list, watch, and delete `sandboxclaims.extensions.agents.x-k8s.io`. It does not need permission to create arbitrary Pods, Deployments, Secrets, Roles, or cluster-scoped resources.

Required runtime environment:

| Variable                 | Purpose                                      |
| ------------------------ | -------------------------------------------- |
| `SANDBOX_BACKEND=gke`    | Select GKE Agent Sandbox                     |
| `GKE_SANDBOX_NAMESPACE`  | Namespace containing the template and claims |
| `GKE_SANDBOX_TEMPLATE`   | Existing `SandboxTemplate` name              |
| `GKE_SANDBOX_ROUTER_URL` | Internal sandbox-router URL                  |
| `SNAPSHOT_STORE=gcs`     | Store file bytes in Cloud Storage            |
| `TRANSFER_STORE=gcs`     | Store staged transfer blobs in Cloud Storage |
| `GCS_BUCKET`             | Dedicated runtime bucket                     |
| `GCS_PREFIX`             | Optional deployment prefix                   |

The sandbox template owns isolation, persistence, limits, and egress policy. QM claims the template but cannot weaken it. Agent Pods should run non-root under gVisor, omit service-account tokens, drop all capabilities, use bounded resources, and accept ingress only from the sandbox router. The router should accept ingress only from QM core.

The GKE workspace is created at `/home/agent/qm-workspace`. Managed Agent Sandbox mounts `/home/agent` as a writable volume root but can preserve an image-baked `/home/agent/workspace` directory as root-owned; using a runtime-created child keeps the agent non-root without an init container or ownership escalation.

`GKE_SANDBOX_WARM_POOL` is not a claim selector in the managed `v1alpha1` API. Replace that legacy setting with `GKE_SANDBOX_TEMPLATE`; a separately managed warm pool can still reference the same template.

The adapter intentionally does not create GKE, Cloud SQL, buckets, IAM, or Secret Manager resources. Those belong to the operator's versioned infrastructure repository. It also does not synchronize Secret Manager into Kubernetes Secret objects.

Set `DEPLOY_PROVIDER=disabled` for the GKE control plane. The GCP adapter covers QM agent computers and durable stores, not QM's separate hosted-app deployment feature. This makes hosted-app requests fail closed instead of falling through to a Docker daemon that does not exist in the cluster.
