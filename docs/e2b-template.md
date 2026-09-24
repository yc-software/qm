# E2B sandbox template

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
