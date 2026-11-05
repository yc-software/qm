# Core-hosted web front door and web UI releases

Core is the only application workload besides the optional egress proxy. When `PUBLIC_PORT` is set, core serves the public front door on that port: the portal's sign-in and reverse proxy, the built-in auth broker on `127.0.0.1:8099` when `AUTH_EMBEDDED=1`, and the web UI server on a loopback port. Core's API stays on `PORT`. Every CLI target sets `PUBLIC_PORT=8000` and routes public traffic there; the API port stays private, except that on AWS a separate `apiUrl` host and the apps domain route by host header straight to core's API port through a second target group attached to core's port 8080. Slack remains in core.

## Web UI releases

The browser application is a static, content-hashed release. A release id is the SHA-256 of every file in the built bundle (`plugins/web-ui/dist-web`). Core keeps releases in its object store, under `<S3_PREFIX>web-ui/` in `S3_BUCKET` when `SNAPSHOT_STORE=s3`, or under `$DATA_DIR/web-ui/` otherwise:

| Key                    | Contents                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `assets/<name>`        | Hashed scripts, styles, fonts and images (with `.gz` siblings), shared by releases |
| `releases/<id>/<file>` | The release's documents and unhashed files; `index.html` is written last           |
| `live.json`            | `{"release": "<id>", "deployed": "<id of the last core image's bundled release>"}` |

Core serves `index.html`, `shared.html` and unhashed files from the live release and serves `/assets/*` from the shared directory, so a tab opened on an older release keeps loading its chunks after a newer release goes live. Each core re-reads `live.json` at most every two seconds. If a read fails, core keeps serving the release it already has and logs the failure with its cause; a core that has never read a release answers `503` and logs why.

Every core image carries the bundle built from its source. At boot core uploads that bundle if the store lacks it, then makes it live only when `live.json` names a different `deployed` release. A core deploy therefore ships its web UI, while restarting the same image keeps any release published since. A core whose bundled release is not the `deployed` one, such as an old instance during a rolling deploy or after a failed rollout, keeps serving its own bundled release, so the browser code always matches the core API it talks to.

Publish a web UI change without deploying core:

```bash
npm run build --prefix plugins/web-ui
qm ui publish --dir plugins/web-ui/dist-web
```

The command uploads the assets, then the documents, then switches `live.json`, and prints the previous release. Roll back with `qm ui publish --release <id>`. It writes with the operator's AWS CLI credentials: on AWS, the deployment's objects bucket; on any target whose `env.core` sets `SNAPSHOT_STORE=s3` and `S3_BUCKET`, that bucket (set `AWS_ENDPOINT_URL_S3` and the storage keys for Tigris or another S3-compatible store). Render's object storage is private to its project, and a core without S3 keeps releases in its data directory; those deployments ship web UI changes with `qm up`. A release must speak the API of the running core; publish bundles built from the deployed core's source line.

## Configuration

`services` declares `core`, the optional `egress-proxy`, and the core-hosted capabilities `slack` and `auth`. The former `web-ui` and `portal` services no longer exist: drop them from `services`, move their `env` and `secretEnv` settings into `core`, and drop their `vms` and `imageOverrides` entries. Keep `auth` to enable email sign-in; its settings stay under `env.auth`. Omitting `auth` keeps external OIDC sign-in, configured in `env.core`.

## Upgrade an existing deployment

1. Record the existing release's source, image digests, configuration and secret versions.
2. Make the configuration edits above and update `publicUrl` if it named the retired portal host (for example `https://<prefix>-portal.fly.dev`); register the new callback URL with an external identity provider.
3. Deploy with `qm up`. Core starts serving the front door and publishes its bundled web UI.
4. Verify signed-in chat, `/settings`, login, logout, and a `qm ui publish` round trip.
5. Remove the retired web-ui, portal and auth workloads by hand, following the target's upgrade steps in its deployment reference. The CLI does not remove them.

There is no database migration. Session keys, the auth broker's signing key and the token secret keep their values and move to core.

For source development, install root and web-ui dependencies. The dev supervisor runs one core process that serves the front door on the slot's public port; with `--watch` the web UI is served by Vite with hot reload instead of from releases, for local editing only.
