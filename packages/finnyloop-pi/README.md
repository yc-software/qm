# FinnyLoop Pi package

This package adds a Pi lifecycle extension for FinnyLoop resumability. It does not move policy or trust into Pi.

## Host adapter

Before Pi emits `session_start`, the QM host must install its authenticated job reader:

```ts
import { installFinnyJobReader } from "@qm/finnyloop-pi/extensions/finnyloop.ts";

installFinnyJobReader({
  readCurrentJob: ({ sessionId, signal }) => qmFinnyJobs.readCurrentForSession({ sessionId, signal }),
});
```

The reader must derive scope, job, run, and role from the authenticated QM session. It must not accept those bindings from prompts or Pi custom entries. Install it once per process before starting a Pi session.

## Project installation

From the QM repository root:

```bash
pi install -l ./packages/finnyloop-pi
pi --skill ./skills-seed/finnyloop/SKILL.md
```

The project package loads `extensions/finnyloop.ts`. QM seeds `skills-seed/finnyloop` through its normal seed-skill installation; `--skill` is the direct local Pi equivalent for development.

Without the host adapter, the extension fails closed and injects an authority-unavailable instruction. It never treats cached `finny-job-state.v1` entries as authority.

## Validation

```bash
npm --prefix packages/finnyloop-pi test
npm --prefix packages/finnyloop-pi run typecheck
npx eslint packages/finnyloop-pi --max-warnings=0
npx oxlint --deny-warnings packages/finnyloop-pi
node --test test/skill-conformance.test.ts
```
