# Prime Agent as a harness

## Idea

Add `prime-agent` (PrimeIntellect-ai/prime-agent) as a fifth harness engine, alongside pi/opencode/codex/claude.

QM is the "organization shell" (scopes, ACLs, audit, budgets, sandboxes) and prime-agent is the "execution kernel": recursive RLM sub-agents, a persistent IPython kernel, `/refine` self-improvement, a resident daemon. They both sit on top of `@earendil-works/pi-coding-agent`, so this is capability injection on a shared spine, not a heterogeneous integration.

## Why it fits

- **Multi-tenancy**: prime-agent is a single-user terminal tool with no org concept. QM's scope isolation, `--session-dir` per scope, budgets and audit give it the guardrails it lacks.
- **Security**: prime-agent's kernel runs Python with the user's privileges (it says so in its own WARNING). In QM it can run with cwd confined to the scope dir and tool calls gated by the existing `toolApprovalGate` / extension-UI bridge.
- **Cost**: its persistent session + prompt caching cut input tokens ~98% vs. re-reconstructing history every turn (measured: deepseek-v4-flash, 5-task benchmark).

## How it would work

- `--mode rpc` (JSONL over stdio) — stable protocol, we've verified it end to end.
- One `prime-agent` child process per scope, lazy spawn, crash recovery.
- `runTurn` → RPC `prompt` → stream `agent_end` → assemble reply from `text_delta`.
- `resetSession` → RPC `new_session` (kernel reset policy).
- Token/cost via `get_session_stats` deltas → existing `recordLlmRequest` / budget path.

We have a working implementation on a private fork (`yh/qm-integration`, ~4 commits: adapter + registration + config env vars + one API deps bugfix, see issue #314). Happy to upstream the whole thing, or just the parts you like — this text is the pitch, the code is available on request.

Status: proposal (no code changes in this PR).
