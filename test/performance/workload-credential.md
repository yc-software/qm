# Native credential broker lane

`workload-credential.ts` creates one uniquely named synthetic broker credential through the real admin API, then drives `POST /v1/credentials/broker` at independent arrival rates through the existing workload scheduler. Successful calls return a verified fixture response over HTTPS. The denial class requests a path outside the same credential's allowlist and must return the real `403 path_not_allowed` response. No model calls, sandbox launches, or fabricated audit inserts are involved.

The driver checks the live `qm_perf_*` database marker, signed core transcript sentinel, and responder profile identity before creating the credential. It uses the existing portal identity/source signers for the admin mutation and the existing capability signer with audience `credential-broker` for broker requests; the native gate checks the active synthetic actor. The secret must be a generated `qm-perf-synthetic-…` value. Creation starts disabled with no grants. Only an acknowledged creation can be activated using its exact version. Each active credential permits only GET, its pinned responder hostname, and `/__qm_perf/broker/`; its only ACL grantee is the synthetic actor's personal scope. Deployment use is disabled.

Cleanup uses native conditional updates to advance the disabled credential's version and remove its grants, then verifies durable state. The version change prevents a delayed activation from succeeding with an older version. A late initial creation remains disabled by construction. Bounded cleanup emits the unique slug and explicit unresolved state if mutation completion or final cleanup cannot be proven; that run fails. An ambiguous activation remains unresolved even after a disabled row is observed, because the original grant mutation may still be completing. No missing row is treated as proof that an in-flight write cannot arrive.

The responder is a separate Node HTTPS process. Supply certificate/key file paths in its environment. The certificate must validate normally in the driver and core: use a trusted certificate or explicitly provision a private fixture CA through `NODE_EXTRA_CA_CERTS` at process startup. TLS verification bypasses are rejected. The responder's control token differs from its synthetic credential; neither token is returned or logged.

| Request                                                      | Purpose                                                                                                         |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET /__qm_perf/identity` with `x-qm-perf-control`           | Bind fixture and responder profile hashes.                                                                      |
| `GET /__qm_perf/broker/<run UUID>/<sequence>`                | Require the broker-injected synthetic Bearer value; return fixture/request identity and the configured payload. |
| `GET /__qm_perf/metrics/<run UUID>` with `x-qm-perf-control` | Verify exactly one unique responder receipt per successful call and zero unexpected arrivals.                   |
| `/__qm_perf/denied/…`                                        | Must be blocked by the native broker before any responder fetch.                                                |

Run the responder with private profile/manifest paths:

```sh
node test/performance/workload-credential-responder.ts --profile /private/responder.json --fixture /private/fixture.json
```

After the fixture core trusts that certificate and the concrete profile is reviewed:

```sh
node test/performance/workload-credential.ts --profile /private/credential-workload.json --fixture /private/fixture.json --output /private/credential-evidence.jsonl
```

`CredentialWorkloadProfile` names environment variables for the database URL, source/capability/portal signers, synthetic credential, and responder control token. It contains the core workload origin/duration/concurrency limits, explicit successful and denied request rates, completion-rate bounds, synthetic org/principal, owned transcript guard, responder HTTPS origin/profile hash, and a bounded persistence wait. Its input request/stream arrays are empty: the driver generates the two fixed broker lanes. Remote origins require the existing core origin binding and a separate exact `QM_PERFORMANCE_BROKER_ALLOWED_ORIGIN` binding.

A pass requires all offered requests to start and validate, completion rates within the supplied bounds, exact scoped durable `credential_usage` and `audit_log` counts, zero unexpected usage/audit outcomes, and an equal count of unique responder receipts. The responder counts run-specific forbidden, malformed, or duplicate arrivals separately; any such arrival fails the proof. Per-request evidence retains actual HTTP status, latency, and bytes; expected denials remain 403. Global PostgreSQL counters are also captured, but may include concurrent traffic and stats lag. The original fixture manifest is never changed.

This lane exercises native capability verification, active-principal checks, credential point lookup, decryption, host/path/method checks, actual HTTPS proxying, and asynchronous durable usage/audit writes. Each successful call produces `credential.broker.use`; each policy denial produces `credential.broker.denied`. `keychain.materialize` is emitted by native sandbox credential preparation in `src/tools/primitives.ts` and `src/core/orchestrator/sandboxes.ts`. Egress events originate from the separate egress proxy/audit path. This broker lane does not claim either cost. One synthetic credential and a fixed response size also do not establish production credential diversity or upstream latency parity; qualification remains false.

The focused checks create an ephemeral trusted certificate, test the real keychain encryption/decryption and broker policy against HTTPS, prove that an untrusted certificate is rejected, and reject a proof after a deliberately injected forbidden upstream arrival. Delayed native-mutation simulations verify inert creation, activation version fencing, and explicit unresolved cleanup evidence:

```sh
node --test test/performance/workload.test.ts test/performance/workload-credential.test.ts
```
