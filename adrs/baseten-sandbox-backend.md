# Baseten Sandboxes as an agent-computer backend

Michael from Baseten here. We'd like qm to run its agent computers on Baseten Sandboxes.

A Baseten sandbox is a named microVM that goes to standby when idle and resumes on the next request with its disk and running processes intact, which is the resident-disk lifecycle qm already assumes. So the mapping is plain: one sandbox per scope, named after the scope, created on first use, deleted on destroy. No database record is needed because the name is the lookup.

The one lifecycle difference: Baseten deletes every sandbox 7 days after it was created, whatever its expiration policy. The backend does not try to outlive that. When a turn provisions a scope whose sandbox is gone, it creates a fresh one under the same name (a cold start with an empty disk), and the agent's machine description says so, the same way the other resident-disk backends tell the agent to keep durable work in git or Files.

To avoid provider drift, it boots qm's own sandbox base image (`fly/Dockerfile`) with the sandbox API server added as the entrypoint; `scripts/build-baseten-sandbox-image.ts` builds it on Baseten from the committed tree. Config is `BASETEN_API_KEY`, `BASETEN_SANDBOX_IMAGE` and an optional name prefix, like every other backend's. `BASETEN_API_KEY` is an ordinary Baseten API key, the same kind Baseten's Model APIs take.

The backend rides the shared exec base, so process sessions, file ops, export and blob staging come from the common helpers. It uses our TypeScript SDK, `@basetenlabs/sandbox`, rather than raw requests: it is small (one dependency, our generated API client, and nothing else), and it owns the parts we would otherwise copy into qm: minting and refreshing the short-lived sandbox token from the API key, retrying idempotent reads and uploads, and uploading large files in parts. Tests use an in-process fake of the Baseten API; we also ran it end to end against a live Baseten team. We'd rather this live upstream than in a fork, and we'll keep it green as the sandbox contract moves.
