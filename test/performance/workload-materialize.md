# Native credential materialization shape

`workload-materialize.ts` adds one optional, explicitly configured `materialize` shape to the existing companion. It leaves ordinary provider shapes unchanged. The configuration names a synthetic run UUID, exact native credential handle, SHA-256 of a high-entropy synthetic secret, installed model/tool, and optional exact sandbox ID. It never accepts arbitrary command text or a plaintext credential.

The originating message must be exactly `materializeMarker(fixtureId, runId)`. The companion emits the installed `sandbox` tool with `action: exec` (or the legacy `execute` tool). Its fixed Python command hashes `QM_PERF_MATERIALIZATION_TOKEN`, checks the configured hash, and prints a unique sentinel. The next request must contain that exact tool call and one matching successful result with the sentinel and `[exit 0]`. An altered command, wrong credential handle, unexpected extra call, error result, or missing real tool schema fails closed. Allowlisted title/utility calls retain their existing handling.

For a native proof, create a unique owned env credential using `/v1/keychain/credentials`, verify the returned handle, then submit the marked turn through `/v1/turns?async=1` with Pi. Require actual successful run/tool completion and exactly one correctly attributed `keychain.materialize` audit event for the unique handle. The audit occurs before execution, so the event alone is insufficient. Delete the synthetic credential afterward through the native keychain API. Retire only a newly created fixture-owned sandbox, if one was needed. Preserve request ambiguity and cleanup failures as failures.

The focused tests validate the fixed command and installed Pi streaming tool protocol. They do not establish native keychain decryption, sandbox execution, grant consumption, owner-auth file restoration, production rate, or remote sandbox network parity. The live proof and its private identity/bindings/evidence must establish the relevant boundaries separately.

Run `node --test test/performance/workload-materialize.test.ts test/performance/workload-companion.test.ts`.
