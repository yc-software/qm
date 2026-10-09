# Credential capture and refresh handoff

## Status

Draft implementation. Do not merge or deploy this version.

The capture/writeback repair is implemented and covered by affected tests. The current isolation workaround blocks ordinary commands and sandbox file operations whenever a background process is running. That restriction is unacceptable as a permanent change and must be replaced before merging. Work on that replacement has only reached investigation; it is not implemented.

## Required behavior

- Saved credentials become available to an execution only when explicitly requested through `execute.credentials`.
- A grant authorizes access. It is not itself a request to load credentials.
- Capture credentials from the computer that performed the login or refresh, including explicitly selected computers and disposable owner/scratch computers.
- Persist refreshed material into the original encrypted keychain entry, preserving ownership, grants, and metadata.
- Ordinary dev servers, watchers, tests, commands, and file operations must remain usable concurrently.
- Preserve the selected computer's workspace and installed-tool behavior by default. Do not silently redirect commands to a blank computer or invent automatic workspace synchronization without resolving its semantics.
- The broader platform requirement is to keep refreshable credentials active. This draft repairs capture and writeback; it does not implement proactive idle refresh for AWS file credentials.

## Findings

The former turn-end capture path was anchored to the default computer. A login or CLI refresh performed in an explicitly selected or disposable computer could therefore succeed without updating the durable keychain copy. Disposable computer teardown then discarded that state.

Saved CLI bundles were also restored during provisioning rather than exclusively through `execute.credentials`. The raw `/v1/keychain/use` endpoint could return a sourceable credential-loading script outside that explicit field.

Native capture protected entries whose origin was not `device-flow-auto-capture`. An entry saved through the API could consequently remain stale even after a successful later native login. The repair must preserve metadata rather than rewriting origins to bypass this guard.

AWS CLI SSO caches contain refreshable token material. CLI-driven refresh and platform scheduling are separate responsibilities: persisting a CLI's updated cache does not create a platform refresh job.

## Implemented in this draft

### Explicit loading and writeback

- `src/core/orchestrator.ts` includes file credentials in the execution catalog and resolves only requested handles.
- `src/credentials/execute-files.ts` stages requested bundles in a temporary command home, provides CLI environment pointers, captures updated files, writes back through the keychain, and removes the staging directory in `finally`.
- `src/credentials/keychain.ts` adds atomic file writeback against the materialized baseline. A stale command cannot overwrite a newer keychain value. Owner and grant metadata are preserved.
- Granted AWS writeback permits changes to existing SSO token-cache refresh fields while rejecting configuration and registration-metadata replacement. Derived AWS role-cache changes are discarded. Modified granted bundles for other providers are currently rejected; general safe provider writeback remains a design gap.
- Provisioning no longer restores saved login bundles automatically.
- `/v1/keychain/use` returns HTTP 410 with guidance to use `execute.credentials`; prompts and the API catalog have been adjusted. This is an intentional compatibility change that needs deployment consideration.

### Native login capture

- `src/core/orchestrator/sandboxes.ts` tracks the actual default, selected, scratch, and owner handles eligible for capture.
- Capture takes a metadata fingerprint baseline before execution, rather than treating the keychain contents at completion as the original baseline.
- `src/credentials/device-flow-persist.ts` captures against that baseline and cleans native credential files afterward. Saved entries retain their origin. New capture merges with an existing bundle rather than replacing it with a partial file set.
- Cleanup also covers first-time capture failure and legacy credential staging locations.

### Background lifecycle

- `src/processes/process-registry.ts` adds migration `processes/registry/0004`, a nullable `credential_capture` JSONB column, durable capture snapshots, selection by sandbox across initiating scopes, and capture completion consumption.
- `src/connectors/background-exec-broker.ts` serializes start/poll/write/stop completion handling with execution, restores pending capture after broker reconstruction, and avoids replaying completed capture.
- The monitor exit path in `src/wiring.ts` re-reads the durable capture snapshot inside the same lock before capturing and consuming it.
- Admission accounts for completed-but-uncaptured processes and checks actual process state instead of treating TTL expiry as termination.
- Admission applies independently of capture ownership, including untracked cross-scope and reached handles.

## Blocking design problem

The current temporary home is still inside the same computer. It is not a security boundary against sibling processes with equivalent privileges.

Two races drove the current blanket restriction:

1. A pending background login can write native credentials after an uncredentialed foreground operation passes its admission check.
2. Capturing and clearing a shared home when one job exits can interfere with another job's unfinished login.

The workaround in `prepareCredentialExecution` rejects commands and sandbox file operations while any actual background process runs. Polling and stopping remain available. This also blocks unrelated dev servers and watchers, so it must be removed through proper isolation rather than merely deleting the check.

The desired replacement gives each credential operation or login its own protected storage and lifecycle, captures only its own files, and cleans only its own files. It must survive process completion, retries, core restart, and deployment handover without relying solely on in-memory bookkeeping.

The current `Sandbox` interface exposes whole-computer provisioning, execution, process sessions, file operations, and exports. It has no protected per-command filesystem view. Disposable computers are available; file export/import also exists, but does not transparently preserve all installed tools, live services, concurrent writes, or workspace semantics. A random directory, different `HOME`, or permissions shared by the same privileged execution identity is insufficient isolation. No backend isolation implementation has been added.

## Validation completed

- Affected run: 252 passed, zero failed, one PostgreSQL test skipped in the ordinary run.
- Tool-schema/behavior run: 142 passed, zero failed.
- Separate isolated PostgreSQL registry run: nine passed, including durable snapshot reconstruction and capture completion.
- Typecheck, lint, formatting checks, and `git diff --check` passed at the last implementation checkpoint.
- Two independent source reviews found no remaining concrete security/lifecycle defect after the last repairs, while explicitly flagging the broad background restriction. Those reviews do not approve the unfinished isolation replacement.

Covered cases include explicit loading only, default/owner/scratch/selected execution, capture before scratch teardown, updating an API-origin entry from a selected computer, writeback after nonzero command exit, stale-write rejection, granted AWS configuration poisoning, symlink replacement, orphan cleanup, concurrent file reads, background reconstruction/idempotence, and cross-scope pending-capture lookup.

Live local QA attempted a synthetic login through the real web surface and model. Scratch execution was initially disabled; after enabling it, Docker failed to allocate a sandbox network because its address pools were exhausted. The command did not run. No real AWS login or refresh was verified, and nothing was deployed.

## Commands for continuation

Run affected tests with GNU coreutils on macOS because the fake sandbox exercises GNU shell utilities:

```sh
PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH" node --experimental-test-module-mocks --test test/execute-file-credentials.test.ts test/execute-env-credentials.test.ts test/execute-credential-preparation.test.ts test/open-speaker-keychain.test.ts test/device-flow-persist.test.ts test/background-exec-broker.test.ts test/background-tool-context.test.ts test/process-registry.test.ts test/monitor-poller.test.ts test/keychain.test.ts test/keychain-ask.test.ts test/durable-process-sessions.test.ts test/background-controller.test.ts test/process-reaper.test.ts test/agent-tools.test.ts
npm run typecheck
npm run lint
```

With a disposable local PostgreSQL server configured through `DATABASE_URL`, run:

```sh
node scripts/run-pg-tests.mjs test/process-registry.test.ts
```

## Next work

1. Resolve the isolation mechanism while preserving existing workspace/tool behavior. Implement it for both foreground credential use and background login completion; do not leave the latter on a shared-home sweep.
2. Remove the blanket background-process restriction and obsolete shared-home coordination, rather than layering more flags around it.
3. Add adversarial concurrency tests: a dev server remains usable during credential use; unrequested foreground/background operations cannot read staged credentials; overlapping logins cannot capture or clean each other's files; restart and teardown do not lose the latest refresh.
4. Inspect remaining generic-provider gaps, including granted file refresh rules and custom capture roots, before claiming general refresh support.
5. Unblock local sandbox provisioning, complete live QA using synthetic material first, then verify the applicable real provider flow without exposing credentials in logs.
6. Run fresh independent reviews on the final design and inspect CI. Keep this PR a draft until the blocking behavior is gone and live validation is complete.
