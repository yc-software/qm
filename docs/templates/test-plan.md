# Test plan: Short title

**Status: Proposed | Active | Complete | Historical**

**Owner:** [Independent quality owner]

**Scope revision:** [Commit or PR]

**Related:** [Feature specification, ADRs, protocols, and implementation]

## Objectives and exclusions

[State what confidence this plan provides and what it does not cover.]

## Environment and data

[List prerequisites, services, credentials, fixtures, isolation, cleanup, and sensitive
data restrictions.]

## Test matrix

| ID    | Scenario                      | Level       | Preconditions | Expected evidence        | Blocking |
| ----- | ----------------------------- | ----------- | ------------- | ------------------------ | -------- |
| T-001 | Success path                  | Integration | [State]       | [Assertion/artifact]     | Yes      |
| T-002 | Permission denied             | Integration | [State]       | [No side effect + audit] | Yes      |
| T-003 | Concurrent or duplicate input | Integration | [State]       | [Idempotent result]      | Yes      |
| T-004 | Partial failure and recovery  | End to end  | [State]       | [Recoverable result]     | Yes      |

## Commands

```bash
[Repository-verified command]
```

## Entry and exit criteria

[Define required implementation state, allowed test limitations, severity thresholds,
and evidence required to pass.]

## Residual risk

[List untested behavior, environment limitations, non-blocking defects, and owners.]
