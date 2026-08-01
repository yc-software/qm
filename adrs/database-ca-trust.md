## A supported CA trust path for the core's Postgres connection

We're deploying QM v0.1.4 on the Fly target with a supplied `DATABASE_URL`
pointing at a managed Postgres provider (Supabase, via its regional session
pooler). The provider's TLS chain terminates in a private root CA that the
provider publishes for pinning.

**What we observe at v0.1.4:** core receives only `DATABASE_URL` and passes
it to the Node `pg` stack. With `sslmode=verify-full` (or current
`pg-connection-string` semantics treating `sslmode=require` as
certificate-validating), the connection is rejected as self-signed, because
the container's trust store does not include the provider's root and there
is no supported way to add it: no CA env var, no documented secret-file
materialization path in the Fly contract, and no config key that reaches the
`pg` `ssl.ca` option. Core exits before creating its lazy state tables, so
the deployment cannot come up at all against a provider-pinned CA.

The operator's realistic options today are (a) disable certificate
verification, accepting encrypted-but-unverified TLS to the database that
holds every session and secret-adjacent record, or (b) fork the core image
to bake in a CA, losing the ability to run upstream images unmodified. Both
feel wrong for a system whose broker design is otherwise so careful about
trust boundaries.

**What we'd like:** a supported way to hand core (and anything else that
dials Postgres) one or more additional trusted root certificates, applied
with full verification semantics.

Shapes that seem compatible with the current design, from the outside:

1. A `DATABASE_CA_CERT` (PEM content) env/secret that core materializes and
   wires into the `pg` client's `ssl.ca`, keeping `DATABASE_URL` untouched.
   Secrets already flow through the target's secret store, so this adds no
   new channel.
2. Honoring `NODE_EXTRA_CA_CERTS` by documenting a contract-supported way to
   materialize the referenced file inside the image at boot (today the env
   var is settable but there is no file to point it at).
3. A config-level `database.ca` entry in the deployment config that the CLI
   renders into whichever of the above the images support, so `check` can
   validate the chain before `up` and `check --live` can assert
   `pg_stat_ssl` afterwards.

Shape 3 layered over shape 1 would let preflight catch this class of
failure before anything deploys. We're happy to test a patch against a
Supabase-pinned deployment and contribute the `check` probe.
