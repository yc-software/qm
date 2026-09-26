# Controlled auxiliary and loop responses

`workload-companion.ts` serves the fixture-only Anthropic messages endpoint while running the unchanged `workload-provider.ts` on an internal loopback listener. There is no configurable forwarding destination or external fallback. Its fixture/database and synthetic-token checks are the same as the frozen provider's. Keep the frozen provider source digest in the executable artifact manifest.

```sh
node test/performance/workload-companion.ts --profile /private/companion.json --provider /private/provider.json --fixture /private/fixture.json --out /private/companion-events.jsonl
```

Configure QM's ordinary Anthropic endpoint to this listener only after checking the isolated runtime and enabling the intended real Pi utility adapter. A per-turn Pi choice with a mock default does not enable all native utility traffic. This program does not change QM policy or runtime configuration. It writes a new mode-0600 JSONL file and never logs request bodies, response bodies, headers or keys.

The companion profile has `schemaVersion:1`, matching `fixtureId`, listener `host`/`port`, the provider's `tokenEnv`, `utilities`, and optional `loop`. Remote binding requires the exact `QM_PERFORMANCE_BIND_HOST` value. Each utility rule contains:

| Field                                | Contract                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `name`, `model`                      | Unique rule name and exact request model ID                                  |
| `systemSha256`                       | SHA-256 of the exact system text; text blocks are joined by a single newline |
| `response`                           | Fixed synthetic text matching the real utility's response contract           |
| `delayMs`                            | Wait before the response or first stream event                               |
| `chunkCharacters`, `chunkIntervalMs` | Unicode code points per text chunk and time between chunks                   |

Utility requests must contain one text-only user message and no tools. Streaming SSE and ordinary JSON responses use the same rule. Pi `oneShot` appends `\nCurrent working directory: <cwd>` to the source system prompt. Its ordinary cwd is stable for each prefix (`join(tmpdir(), prefix + '-cwd')`); its random agent directory does not appear in the prompt. Bind exact wire digests for the actual runtime paths. If Pi cannot create its stable directory and falls back to a random cwd, the request is rejected. There is no prefix match or automatic prompt learning. Acknowledgment requests use their source system text directly. Direct compaction has its own installed-client system prompt and also needs an explicit digest. Native compaction uses the configured turn model, while acknowledgment and default title/detection helpers use the auxiliary model.

`loop` contains the same pacing fields plus exact `model` and `shipAction`. A native loop's playbook must carry `[qm-perf-loop:<fixtureId>:<nonce>]`. Only one current user stage header and its matching end header are accepted: `[Loop intake]`, `[Loop work]` or `[Loop judge]`. A unique matching fixture marker must occur in that current message. Intake produces one synthetic item whose `sourceKey` preserves the marker plus a deterministic request digest. That source key reaches the real judge prompt, which omits the playbook. Work prepares one output with the configured action; judge returns `met` with no checks. Create this diagnostic loop with a matching synthetic success condition, no declared checks, no destination, a **hold** ship gate, and bounded caps. This responder never executes a ship action. Distinct intake requests produce distinct keys; repeatability across native recurring fires still requires live proof of distinct request identities and expected item counts.

Ordinary c35 turns must have a complete marker in the current user message, the actual QM `files` tool, and pass the frozen provider's own model/shape/tool checks. Empty, image-only and incomplete-marker user messages cannot fall back to an older marker. A continuation must contain exactly one successful tool result matching the immediately preceding expected `files(action: "read")` call, including its ID and path; the validated chain must lead back to a marked originating user turn. Unknown requests fail before forwarding. The provider identity endpoint exposes both profile hashes and separate counters; frozen-provider counters retain their original meaning. `companion-call` records retain exact request/system digests, request bytes and gzip bytes, response bytes, timing, stream mode, matched rule and errors. Frozen-provider calls also retain their original records. A forwarded request has one record at each layer; do not sum both as separate model calls.

Shutdown aborts both listeners and waits for companion and frozen-provider terminal evidence before resolving. Repeated close calls share the same promise; repeated process signals close the evidence sink once.

Optional `nativeShapes` admit `[qm-perf-native:<fixtureId>:<shape>:<nonce>]` on the current user turn. Each shape declares an exact `model`, independent `modelCalls` and `toolCalls`, `batches` with one positive count per nonterminal model response, and matching `operations`. Operations are either an actual `files(action: "read")` with exact durable path/bytes/hash, or a fixed `sandbox(action: "exec")` command that prints deterministic synthetic bytes on an explicitly owned sandbox. The profile cannot supply a command or network destination. Every continuation validates the complete preceding batch, input identities, successful results and actual returned bytes. Earlier conversation markers cannot authorize a new turn.

Native shapes also declare `outputBytes`, `repeatedFraction`, the ordinary pacing fields and a terminal contract: `reply` or `loop-intake-empty`. The latter requires the actual current intake stage and returns no items, so one native intake run can represent one controlled arrival without creating work/judge descendants. It does not prove the historical loop-stage mix. Impossible call/tool joints must be resolved explicitly in the external workload mapping or rejected; the responder never invents extra calls or tools. Native records include the shape, nonce, step and batch size. Run `node --test test/performance/workload-native.test.ts` for the installed-client multi-tool protocol and malformed-continuation checks.

Every companion evidence record remains `qualified:false`. Synthetic token counts estimate bytes divided by four. These responses exercise QM's real client, scheduler, persistence and delivery work under explicit pacing; they do not establish real provider inference capacity, correctness of arbitrary model outputs, complete source-mix coverage, or production byte/latency parity. Calibrate response sizes, pacing, source arrivals and resulting DB/CPU/SSE pressure from measured evidence before using a separate campaign attestation.

```sh
node --test test/performance/workload-companion.test.ts
```

The focused tests use the installed Pi `oneShot`, the actual Pi acknowledgment helper, and the installed Anthropic streaming client. They verify native compaction model binding, loop-stage contracts, the unchanged provider's two-call tool continuation, active-response shutdown drainage, and rejection of altered utility prompts, wrong models/fixtures, ambiguous loop stages, unauthorized access and stale markers.
