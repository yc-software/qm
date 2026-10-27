# Screening gate

Security screening runs in observe mode. A classifier reads external content and records its verdict in the audit log as `security_screen.classify`, with status `allow`, `would_block` or `error`. Nothing it decides changes a turn.

The screening gate is the one place where that verdict could turn into enforcement. It is the function `screeningGate` in `src/core/orchestrator/screening-gate.ts`. The security observer (`createSecurityObserver` in `src/core/orchestrator/security-screen.ts`) calls it after every classification and returns its decision. Today the gate always allows.

## What the gate decides

For one screened item, the gate decides whether it may reach the model. It returns one of two answers:

- `{ action: "allow" }`
- `{ action: "block", reason }`

It decides nothing else. It does not change postures, credentials, sharing, approvals or the turn's tool set.

## Inputs

The inputs are what the shadow screener already produces for the item:

| Field     | Source                                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hook`    | `user_input` for inbound content (messages, webhook and cron payloads, attachments, overheard thread messages, steered documents); `tool_response` for external tool results.          |
| `surface` | Where the content came from: `slack`, `web`, `webhook`, `steer`, and so on.                                                                                                            |
| `origin`  | The turn's origin kind: `human`, `ambient`, `automation` or `direct`.                                                                                                                  |
| `verdict` | The classifier's verdict: `decision` (`strict` or `auto`), `reason`, and `unscreened` when the classifier gave no usable answer. It is absent when the classifier timed out or failed. |

The screened text is not an input. The gate decides from the verdict alone, so its decisions can be audited without storing the content.

## What blocking does

Blocking is not built yet. This is the intended behaviour for when the gate first returns `block`:

- **Tool result (`tool_response`).** The model gets a fixed notice in place of the result, saying the output was withheld by security screening. The tool has already run. The audit row is written with status `block`.
- **Inbound content (`user_input`).** The item is left out of the prompt, and the turn still runs on whatever was not blocked. The person who sent the turn sees a short line saying that some content was withheld.
- **No release path.** Blocked content stays blocked. If the verdict was wrong, the fix is to the rubric or to the gate, not a per-item approval.
- **Errors and missing verdicts.** These allow, as they do today.

For a block to take effect, the call site has to wait for the decision. Today every caller starts the observation and moves on without waiting. Enabling blocking for a given hook means awaiting the observer at that call site, so that hook pays the screening latency, bounded by `securityScreenTimeoutMs`.

## How it is turned on

The gate is turned on by changing code: `screeningGate` starts returning `block` for the hooks, surfaces, origins or verdicts chosen. There is no environment variable, setting or feature flag. Enforcement ships in a reviewed change, together with its tests and the awaiting call sites, and can be rolled back the same way.

## Why it is not the old quarantine flow

The old enforce mode was removed on 2026-10-26 (`c6b3b1e83`, `e86cf0b5f`). It wove screening through the turn path:

- quarantined tool output and inbound input, then released them through one-time `quarantine:` approvals;
- added model-visible release prompts;
- had steer blocks, fail-open and fail-closed audit actions, and grant-based overrides (`security_posture.*`);
- tied all of this to the security posture and a `SECURITY_SCREEN` mode setting.

The gate is different:

- **One function with one answer.** There is no held state, no release approvals, and no extra prompt text for the model.
- **Posture stays separate.** It is not tied to the security posture or to configuration.
- **The screener is unchanged.** It writes the same audit rows, and the gate reads its verdict.
- **Small to review and test.** Enforcing means changing a pure function and the call sites that await it.
