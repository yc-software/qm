# E2B sandbox template

## Public template

E2B publishes a ready agent-computer template, `qm-sandbox`. It has the same tools as
the sandbox base image (`fly/Dockerfile`): Claude Code, Codex, GitHub CLI, AWS CLI v2, the
Python venv at `/opt/agent-venv` and `x-api`. Each sandbox gets 8 vCPU and 8 GiB where the
plan allows.

```jsonc
"sandbox": { "backend": "e2b" },
"env": { "core": { "E2B_TEMPLATE_ID": "qm-sandbox:v1.0.0" } }
```

Set `E2B_API_KEY` with `qm secrets set`. Pin a version tag, so a new release does not
change the image of new scopes.

With `E2B_TEMPLATE_ID` set, the agent computer's profile lists gh, aws and `x-api` as
installed. Without it, core uses E2B's stock `base` image and lists them as missing.

On E2B plans capped at one hour, also set `SANDBOX_MAX_LIFETIME_SEC=3600` in `env.core`.
Core otherwise asks for a 61 minute sandbox timeout, and those plans reject every create
with `400: Timeout cannot be greater than 1 hours`. The setting also caps a command at 59
minutes.

To run core on E2B as well, `e2b sandbox create qm` starts it from the `qm-core` template
with a setup page for the E2B key, org, admin and model keys. See
[E2B's docs](https://e2b.dev/docs) for the CLI.

## Build your own

E2B stopped accepting V1 template builds (`e2b template build` against a bare
Dockerfile with an access token) on 2026-08-01. `deploy/e2b/e2b.Dockerfile` is still
the single source for the sandbox image, but it is now fed to the Template SDK, which
E2B's migration guide names as the replacement for Dockerfile-only builds.

From the matching source checkout, install dependencies with `npm ci`, export
`E2B_API_KEY`, then run:

```bash
npm run build:e2b-template
```

The command builds the Dockerfile as the template `qm-base` and prints
`E2B_TEMPLATE_ID=qm-base` with the template and build identifiers. Set
`E2B_TEMPLATE_ID` in the core deployment to that name. Sandboxes created from the
template run as the `user` account with `/home/user/workspace` as the working
directory, which is what `src/sandbox/e2b-sandbox.ts` assumes.

`E2B_TEMPLATE_NAME` renames the template. `E2B_TEMPLATE_CPUS` and
`E2B_TEMPLATE_MEMORY_MB` set the sandbox shape recorded on the template; E2B's plan
limits cap them, and the running shape is reported back through `Sandbox.getInfo`, so
the profile advertises whatever the sandbox actually received rather than a guessed
value. Leaving them unset uses E2B's default of 2 vCPU and 512 MiB.

## Layer tools baked into a child template

Core installs the deployment layer's tool files into every new sandbox on first
provision, after checking their checksums. To skip that step at runtime, point
`DEPLOYMENT_LAYER` at the layer directory when building:

```bash
DEPLOYMENT_LAYER=deploy/layers/<org> npm run build:e2b-template
```

This builds a second template, `qm-base-layer` (override with
`E2B_LAYER_TEMPLATE_NAME`), derived from `qm-base` with `fromTemplate` and containing
each declared install file at its destination path with its declared mode. Set
`E2B_TEMPLATE_ID` to the layer template instead. The runtime checksum probe finds the
files already present and installs nothing; when the layer changes, rebuild the child
template or let the runtime installer replace the stale copies on the next provision.

Rebuilding from unchanged inputs uses E2B's build cache. Existing sandboxes keep the
template they were created from; a paused scope sandbox only picks up a new template
after it is destroyed or restored from a recovery snapshot, which is itself a template
derived from the old image.

## Egress

E2B can filter a sandbox's outbound traffic itself (`network.allowOut` / `denyOut`), but
those rules cannot carry QM's egress policy, so QM keeps its own proxy as the enforcement
point and uses E2B's rules only to make that proxy unavoidable:

- QM policies are deny lists over open egress as well as allow lists. E2B accepts host
  names only in `allowOut`; `denyOut` takes IPs and CIDR ranges only, and allow rules
  always win over deny rules, so "allow `github.com` but not `gist.github.com`" has no
  E2B form.
- E2B matches host names only on ports 80 and 443 (HTTP `Host` and TLS SNI). Other
  ports, such as SSH to a git host, fall back to IP rules.
- QM resolves the policy per turn and per speaker and signs it into the turn's egress
  token. E2B rules are per sandbox, and one scope's computer serves concurrent turns from
  different people.
- The proxy also writes the egress audit log and checks the turn token; E2B's firewall
  does neither.

Set `SANDBOX_EGRESS_PROXY_URL` to a QM egress proxy reachable on port 443, for example
the `egress-proxy` service (TLS on 443 in front of the proxy's port 48080). Core then
creates every agent computer with `allowOut: [<proxy host>]` and `denyOut: ["0.0.0.0/0"]`
and points the computer's proxy settings at it with the turn's token. Without it, core
warns at boot and computers have open egress.

The proxy cannot run inside a core that is itself an E2B sandbox: E2B's public URL edge
forwards HTTP but answers `CONNECT` with 405, so sibling sandboxes cannot use it as a
forward proxy. Run it where it gets a real TCP listener on 443, and give it the same
`CORE_SIGNING_SECRET` as core so it can verify turn tokens.

See [Internet access](https://e2b.dev/docs/network/internet-access).

## Published apps

`DEPLOY_PROVIDER=e2b` runs each published app in its own E2B sandbox, created from
`E2B_TEMPLATE_ID` so an app gets the same machine as the agent that built it. It uses
the same `E2B_API_KEY`.

- The sandbox is created with `lifecycle: { onTimeout: "pause", autoResume: true }`. It
  pauses ten minutes after it starts or resumes, and the next request to its URL resumes
  it with memory intact, so the app process keeps running across pauses. E2B keeps paused
  sandboxes until they are killed.
- Its URL is `https://<port>-<sandbox>.<e2b domain>`, created with
  `network.allowPublicTraffic: false`. Only core holds the sandbox's traffic access token
  and sends it as `e2b-traffic-access-token` when it proxies a request, so viewers still
  go through QM's sign-in and sharing at `/d/<app>/` or the apps domain.
- A new version replaces `/home/user/app` in the running sandbox and restarts the
  entrypoint. `/home/user/data` (`$DATA_DIR`) survives redeploys and pauses; deleting the
  app kills the sandbox and its data.
- An always-on app is created with a 24 hour timeout. E2B still pauses it when that
  window ends, and the next request resumes it.
- Apps served at `/d/<app>/` always require sign-in, so "anyone with the link" sharing
  needs an apps domain (`DEPLOY_APPS_DOMAIN` plus `AWS_DEPLOY_GATE_SECRET`) with a
  wildcard DNS record routed to the portal. `e2b.app` cannot carry per-app subdomains, so
  a core running inside an E2B sandbox needs a domain you control in front of it. Without
  one, a request to make an app public is refused.

See [Auto-resume](https://e2b.dev/docs/sandbox/auto-resume) and
[Restricting public access](https://e2b.dev/docs/network/restrict-public-access).
