# ADR 0004 — File movement: core brokers references, never moves bytes

Status: accepted · Owner: alice · Reviewers: sandbox + deploy component owners

This is the detailed design record for the file-movement contract: this records the
mechanism and the rationale.

## Problem

The platform has no single way to move a file from where it is produced to where it is
consumed, so it grew ~19 ad-hoc byte paths — inbound and outbound attachments, the
publish bundle, cross-scope shares, skill file trees, device-flow credentials, the
Slack emoji image — each carrying bytes its own way. Several of them push file bytes
through the sandbox's **command/exec channel**: `FlySandbox` and `FlyDeployProvider`
base64-encode a file and write it over `fly machines exec` in 12 KB chunks
(`FLY_B64_WRITE_CHUNK`), then reassemble it on the machine. For anything real this is
hundreds of sequential round-trips, runs at exec's bandwidth limit, and corrupts at
scale — the observed prod failures (a publish that takes ~159s and stalls; large
attachments that never arrive).

The exec channel is a control plane: small commands and small results. It was never a
file transport, and using it as one is the root mistake. Meanwhile two real byte stores
already exist and don't know about each other:

- **Ephemeral transfer blobs** (`src/persistence/blob-transfer.ts`, `BlobTransferStore`):
  content-hashed, streamed up and down, swept on a 6h TTL by an in-process sweeper
  (`wiring.ts`, `BLOB_TTL_MS`). Used today only for attachment hand-off between a surface
  plugin and core.
- **Durable artifacts** (`src/files/durable-byte-store.ts` + `FileArtifactStore`):
  content-addressed in S3, indexed in Postgres (`file_artifacts`) by owner with an ACL
  join key, no TTL. The agent's `read`/`write`/`share` workspace files.

The blob endpoints (`/v1/blobs`, `src/api/routes/blobs.ts`) are **source-authed** — only
a holder of `CORE_SIGNING_SECRET` (a surface plugin) can call them. The sandbox, which is
the busiest producer and consumer of large files, has no key for them, so it falls back to
the exec channel. That auth gap is what forces the broken pattern.

## North star

**Core is a broker of references, never a mover of bytes.** Everything with size lives in
object storage. What flows through core is a `blobId` reference plus a short-lived, scoped
capability to fetch it — never the bytes. Core decides who may read what; it never holds
or relays the file. This keeps core out of the data plane (latency, memory, and bandwidth
all stop scaling with file size), and it is the direction that survives moving the blob
store off our own infrastructure: a participant fetches from wherever the reference points.

## Decision

### 1. One primitive: stage / materialize, by reference

A file moves `producer → blob store → consumer` in three steps:

1. The producer **stages** the bytes into the blob store and gets back a `blobId` (a
   content hash) plus size.
2. The `blobId` travels through core as an ordinary reference — in a turn, an attachment
   record, a share grant, a publish manifest.
3. The consumer **materializes** the file by dereferencing the `blobId` against the blob
   store, authorized by a short-lived capability core minted for exactly that read.

All ~19 ad-hoc paths collapse to this one shape. Inbound and outbound attachments,
publish bundles, cross-scope shares, skill trees, device-flow creds, and emoji images all
become "stage a blob, pass the reference, materialize on the other side."

### 2. The sandbox is a first-class storage participant

The bug is that the sandbox can't call the blob endpoints. The fix is to make it one:

- **Capability-auth the blob endpoints.** `/v1/blobs` (PUT) and `/v1/blobs/:id` (GET)
  accept a per-turn capability token in addition to source-auth. Core scopes the
  capability to the specific `blobId` and direction (read vs write) and a short
  expiry, so a sandbox token can fetch the one file it's owed and nothing else. Source-auth
  stays for the surface plugins that already use it.
- **`stageIn` / `stageOut` sandbox verbs.** Thin in-guest helpers that the harness calls:
  `stageOut` reads a path on the machine's disk, streams it to `/v1/blobs`, returns the
  `blobId`; `stageIn` takes a `blobId` + a capability, GETs the bytes, writes them to a
  path. They go **over the network the sandbox already trusts** — it already reaches core's
  control-plane host (allowlisted through the egress proxy) and already carries a capability
  token — so no new trust surface. They never touch the exec channel.

This deletes the base64-over-exec write path for files. The exec channel goes back to
carrying only commands and small results.

### 3. Size-aware dispatch

A single tiny write over one exec round-trip is cheaper than a blob round-trip (stage +
mint + fetch). Keep the existing inline single-exec write for tiny payloads (under ~9 KB —
one exec frame); route everything larger through the blob channel. The dispatch is on
payload size, decided at the helper, transparent to callers.

### 4. Three edges where raw bytes are unavoidable — bridge once, never inward

Reference-only is the rule at every boundary _inside_ the system. Three edges face the
outside world where bytes genuinely exist; at each, bridge to a blob **once, at the edge**,
and pass references inward from there:

1. **Surfaces (e.g. Slack).** A surface receives or must deliver real bytes. The plugin
   downloads the file once and immediately stages a blob, then hands core only the
   reference; on the way out it materializes a blob once to deliver. (Already done for
   Slack attachments.)
2. **The model.** The model needs file content in its context. Dereference at the
   **provider edge** — hand the provider a file reference (e.g. the Anthropic Files API, or
   a URL the provider fetches) rather than core base64-inlining the bytes into the prompt.
   Core stays out of the byte path here too.
3. **The sandbox's own filesystem.** Files at rest on the machine are bytes — that's what a
   computer is. Reference-only applies at the _boundary_, realized by the thin `stageIn` /
   `stageOut` verbs above; inside the guest the agent works with ordinary files.

The discipline is: bridge at exactly one place per edge, and let references flow
everywhere else.

### 5. Two lifetimes, one throwaway-vs-keeper choice

Both stores already exist; unify them behind a single choice the producer makes:

- **Ephemeral transfer blob** — a file in transit (an attachment being handed off, a
  publish bundle in flight). Short TTL, content-hashed, no owner index. The default for
  anything passing through.
- **Durable artifact** — a file that is a keeper (a workspace file, a shared deliverable).
  Content-addressed, owner-indexed in Postgres, ACL'd, no TTL.

Two transitions connect them:

- **Promote (ephemeral → durable).** When an in-transit file becomes something to keep
  (an inbound attachment the agent saves, a deliverable it shares), promote the blob to a
  durable artifact **before** the 6h transfer window closes. Promotion is by content hash,
  so it's a metadata + index operation, not a re-copy.
- **Retire (durable → gone).** A durable artifact's lifetime is tied to its **referent**:
  when the owner deletes the file or a share is revoked, the artifact retires. Retirement
  must **mind dedupe** — content-addressing means two scopes can reference the same bytes;
  revoking one share or deleting one reference must not erase bytes another scope still
  references. Bytes are reclaimed only when the last reference drops (reference-counted by
  content hash).

### 6. Move ephemeral expiry to an S3 lifecycle rule

The 6h transfer-blob TTL is swept today by an **in-process** sweeper
(`createSweeper` in `wiring.ts`) — per-instance, and a blue-green deploy restarts the timer
on every instance, so expiry is neither reliable nor uniform across the fleet. Move it to
an **S3 lifecycle rule**: the object store expires transfer blobs server-side on its own
clock, surviving deploys and needing no process to be alive. (Durable artifacts get no
lifecycle rule — they have no TTL and retire only via the reference-counted retire path.)

## Why direct/reference access, not core-relay

The alternative is core proxying every byte: a participant uploads to core, core writes
the blob; a participant asks core, core streams the blob back. It's simpler to authorize
(core is in the path) but it puts core in the **data plane**: file-sized memory and
bandwidth per request, latency that scales with file size, and an instance that can't be
drained mid-transfer. It also pins us to our own storage forever.

Direct/reference access resolves this: core mints a scoped, short-lived capability and gets
out of the way; the participant moves bytes directly against the blob store. Core's job
shrinks to _deciding who may read what and for how long_ — which is the only part that
needs core's authority. This mirrors deploy reconciliation: core nudges and authorizes;
the machine moves the bytes.

## Touch points

- `src/api/routes/blobs.ts`, `src/api/server.ts` — capability-auth on the blob routes
  (scoped to `blobId` + direction + expiry); keep source-auth alongside.
- `src/sandbox/fly-sandbox.ts` — `stageIn` / `stageOut` verbs; delete the
  `FLY_B64_WRITE_CHUNK` byte path for files; size-aware dispatch.
- `src/deploy/fly-deploy-provider.ts` (since deleted with the Fly deploy provider) — drop
  bundle/file bytes over exec; the publish bundle becomes a blob the machine materializes
  (the git-pull nudge already covers the reconcile transport).
- `src/core/attachments.ts` — inbound/outbound attachments stage and materialize through
  the unified path; promote on save.
- `src/persistence/blob-transfer.ts`, `src/files/durable-byte-store.ts`,
  `src/files/file-artifact-store.ts` — the promote (ephemeral → durable, by hash) and
  retire (reference-counted, dedupe-aware) transitions; one throwaway-vs-keeper façade.
- `src/wiring.ts` — remove the in-process blob sweeper; configure the S3 lifecycle rule
  for the transfer prefix.
