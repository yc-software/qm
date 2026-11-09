# Baseten agent sandboxes

The `baseten` backend runs each QM scope in a named
[Baseten sandbox](https://docs.baseten.co/sandboxes/overview). Idle sandboxes go to standby and
resume on the next request, keeping their disk and running processes. Commands and background
process sessions run over the sandbox's process API; files move over its filesystem API. QM calls
both through Baseten's TypeScript SDK, `@basetenlabs/sandbox`.

## Build the image

Baseten boots the QM sandbox base image (`fly/Dockerfile`) with the sandbox API server added as
the entrypoint, so the agent gets the same tools as on the other backends. From a git checkout of
the QM release you deploy, with `BASETEN_API_KEY` set:

```sh
node scripts/build-baseten-sandbox-image.ts qm-sandbox
```

It builds the committed source tree on Baseten and prints the image reference to use,
`qm-sandbox-<tree>:latest`, where `<tree>` names the source it was built from. Run it again on
each upgrade and set the new reference; a tree that is already built is reused.

## Configure

```sh
SANDBOX_BACKEND=baseten
BASETEN_API_KEY=your-baseten-api-key
BASETEN_SANDBOX_IMAGE=qm-sandbox-<tree>:latest
```

Store `BASETEN_API_KEY` as a core service secret. Use a personal API key or a team key with full
access, for a single team. Use a distinct `BASETEN_SANDBOX_NAME_PREFIX` (default `qm`) for each
deployment sharing a team, including development instances.

For CLI deployments:

```json
{
  "sandbox": { "backend": "baseten" },
  "env": { "core": { "BASETEN_SANDBOX_IMAGE": "qm-sandbox-<tree>:latest" } }
}
```

For local development, export the variables and run `npm run dev-instance -- --sandbox baseten`.

## Behavior

| Variable                      | Default  | Purpose                                                  |
| ----------------------------- | -------- | -------------------------------------------------------- |
| `BASETEN_API_KEY`             | Required | API key, held by core.                                   |
| `BASETEN_SANDBOX_IMAGE`       | Required | Image built by `scripts/build-baseten-sandbox-image.ts`. |
| `BASETEN_SANDBOX_NAME_PREFIX` | `qm`     | Prefix of sandbox names.                                 |
| `SANDBOX_TIMEOUT_SEC`         | `600`    | Default command deadline in seconds.                     |
| `EGRESS_PROXY_URL`            | unset    | Proxy every sandbox request goes through.                |

Each scope maps to one sandbox named after it, so any core instance finds it again after a
restart without a database record. Sandboxes get 8 GiB of memory and 4 vCPUs in the team's
default region. Ending a turn leaves the sandbox in place; Baseten puts it on standby when idle.
Destroying a scope deletes its sandbox. Scratch sandboxes are deleted when their last handle
closes.

Baseten deletes every sandbox 7 days after it was created
([Sandbox lifecycle](https://docs.baseten.co/sandboxes/lifecycle)). The next turn on that scope
creates a fresh sandbox under the same name, with an empty disk; the agent is told to publish
durable work to git or Files. Each Baseten organization runs a limited number of sandboxes at
once (10 by default); creating one past the limit fails with Baseten's quota error until a scope
is destroyed or support raises the limit.

Each command is one blocking process request. When the request returns while the command still
runs, the edge cuts it off, or the connection drops, core polls the named process until it exits;
commands are not bound by one HTTP request. A command refused before it starts is sent again
under the same name. Sandbox names are capped at 49 characters so the sandbox's hostname fits a
DNS label. With `EGRESS_PROXY_URL` set, sandbox commands get the proxy environment; Baseten does
not block direct connections, so egress is not enforced.
