# Make the docker target deployable with SANDBOX_BACKEND=local

`SANDBOX_BACKEND=local` runs agent computers as local Docker containers with no
Fly agent-computer app, and the production config fixture already runs on it —
but the docker target can't actually deploy with it end to end.

`qm init --target docker` scaffolds a `sandbox.app` block, then `qm up` throws
"sandbox.app is set but no sandbox layer image is pinned" because the local
backend never publishes a pinned Fly image. Removing the block hits the gate
in the other direction ("a Fly agent-computer app is required"). So docker+local
is documented-valid but unbootable either way.

A few more gaps in the same area once the gate clears: core runs in a container
but the local backend reaches the sandbox exec daemon at `127.0.0.1`, which is
core's own loopback (the daemon never becomes reachable); core has no Docker
CLI or socket so it can't spawn sandboxes at all; and the auth broker is
addressed as `http://auth:8080`, a bare Docker DNS name portal's private-network
guard rejects.

Could the docker target support `SANDBOX_BACKEND=local` as a first-class path —
relaxing the `sandbox.app` gate for docker+local, giving core access to the host
Docker socket + CLI, reaching the sandbox by name on a shared network (keeping
per-scope isolation), and addressing the auth broker on `.internal`? We got it
working on a single host with these changes and are happy to share the diff.
