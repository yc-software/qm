# ADR: Goal-Oriented Scheduling for Background Work

**Status:** proposal
**Date:** 2026-08-02

## Context

QM schedules background work through three mechanisms:

1. **Crons** — tick-based scheduler with leader lease (`src/cron/scheduler.ts`). Fires on a fixed schedule (`*/5 * * * *` or ISO interval). Each tick polls the cron store, compares against `nextFireAt`, and dispatches.

2. **Monitors** — poll-based watchers (`src/monitors/monitor-poller.ts`) that check external state on a fixed interval.

3. **Wake** — event-driven engagement (`src/wake/wake.ts`). Routes incoming signals to `engage`, `steer`, or `drop` based on whether a run is already live.

All three are **time-driven**: they act when the clock says so, or when an external event pokes them. They don't act because a workload is *falling behind its goal*.

This works for QM's current scale (one org, tens of scopes). But as deployments grow — multiple scopes competing for the same sandbox host, dozens of crons overlapping, monitors saturating API rate limits — time-driven scheduling hits a wall: it can't answer *"which cron should I delay when the sandbox CPU is saturated?"*

## Decision Drivers

- QM already has per-scope resource isolation (sandboxes). What it doesn't have is **cross-scope resource arbitration**.
- The cron tick handler fires all due crons in sequence with `maxFiresPerTick`. When the sandbox host is under load, this means crons pile up and compete blindly.
- A goal-oriented scheduler would let operators declare *intent* ("interactive scopes get < 2s response time", "batch crons stay within budget") and let the system allocate resources accordingly.

## Prior Art: IBM z/OS Workload Manager

IBM's mainframe operating system has run a goal-oriented workload manager since 1994. Instead of fixed priorities, operators define **service classes** with business goals:

```
Service Class: INTERACTIVE
  Goal: response_time < 2s
  Importance: 1

Service Class: BATCH_CRON
  Goal: token_budget < 10K/hour
  Importance: 3
```

WLM observes system metrics (response time, CPU pressure, I/O wait), compares them against goals, and adjusts resource allocations in a closed loop. When resources are tight, high-importance workloads are protected first.

This is the opposite of Linux's default CFS scheduler, which answers "how much CPU should each process get?" — a resource-centric question. WLM answers "is each workload meeting its goal?" — a business-centric question.

## An Open-Source Implementation Exists

We built a Go implementation of WLM semantics for Linux: [deeparchi-ai/wlm](https://github.com/deeparchi-ai/wlm).

It uses:
- **cgroup v2** for CPU weight adjustment (no kernel changes)
- **PSI (Pressure Stall Information)** from `/proc/pressure/cpu` for real-time load observation
- **PID controller** (proportional-integral with anti-windup) per service class for stable closed-loop control
- **Token budget arbiter** that writes a signal file when a budget is exceeded, letting agents self-throttle

### Honest Assessment

- **Tests**: 34 unit tests pass. PID control loop behavior is verified against known step responses. Token budget arithmetic is exact.
- **Production use**: None. This is a prototype. It has never run against a live workload.
- **Limitations**: No memory pressure integration (CPU only). No multi-node awareness. The PID gains are untuned for real sandbox workloads — they were chosen for stability in simulation, not for responsiveness under bursty cron traffic.
- **What would need to happen for QM**: Everything below is a guess, not a tested path. The architecture maps (cgroup → sandbox resource limit, PSI → sandbox host metrics), but the implementation gap from "34 tests pass" to "QM sandboxes are goal-scheduled in production" is substantial.

## What This Could Mean for QM

If QM ever needs cross-scope resource arbitration, the WLM pattern offers a direction:

| QM Today | With Goal-Oriented Scheduling |
|---|---|
| Cron fires on fixed schedule | Cron fires *if budget allows*; delayed crons are queued by importance |
| Monitors poll blindly | Monitor interval adapts to resource pressure |
| Sandbox CPU contention → OS decides | Sandbox CPU contention → QM decides based on declared goals |
| Wake routes are binary (engage/drop) | Wake routes consider scope importance + current goal attainment |

Concretely, a `qm.config.jsonc` could gain:

```jsonc
{
  "scheduling": {
    "goals": {
      "interactive": { "responseTime": "2s", "importance": 1 },
      "batch":       { "tokenBudget": "10K/hour", "importance": 3 }
    }
  }
}
```

And the sandbox host would run a lightweight daemon that reads PSI, runs a PID loop, and adjusts sandbox CPU weights — the same pattern `wlmd` uses today for cgroups.

## Risks and Unknowns

1. **QM may never need this.** If sandbox hosts are over-provisioned (Fly machines, AWS microVMs), resource contention is the cloud provider's problem, not QM's. Goal-oriented scheduling only matters when QM becomes the resource bottleneck.

2. **The PID tuning problem is real.** A controller tuned for one workload profile (steady API serving) will oscillate under another (bursty cron + idle periods). Getting this right requires production telemetry.

3. **Complexity budget.** QM is v0.1.4. Three people. Adding a PID loop + PSI reader + goal config + importance arbitration is a non-trivial surface area. The value has to clearly outweigh the maintenance cost.

## Summary

Time-driven scheduling is the right choice for v0.1.4. Goal-oriented scheduling becomes worth considering when:

- Multiple scopes compete for the same sandbox host
- Operators start asking "why is my interactive scope slow when crons run?"
- The answer to "which cron should we delay?" stops being "we don't" and starts being "the least important one"

The WLM pattern (declarative goals → PID loop → resource adjustment) is proven on mainframes for 30 years. Whether it belongs in an agent harness is an open question. The Go implementation at `deeparchi-ai/wlm` exists as a reference if anyone wants to experiment — but it's a prototype, not a drop-in solution.
