# Live platform QA

`live-qa.ts` drives a running QM instance through its own API, the way production traffic does, and prints `PASS`/`FAIL` lines. It covers the paths a web chat smoke test misses: automated fires and the authority they carry, keychain credentials, and the sandbox provider path. Each check runs a real turn with a real model in a real sandbox.

```bash
node scripts/live-qa/live-qa.ts fires [typed cron webhook loop]
node scripts/live-qa/live-qa.ts credentials
node scripts/live-qa/live-qa.ts sandbox
```

Run it from the worktree of a running dev instance (`bash scripts/dev-instance.sh up --sandbox <backend>`); it reads the instance's settings from the core process. To target another instance, set `CORE_URL`, `CORE_SIGNING_SECRET`, `PORTAL_IDENTITY_SECRET`, `DATABASE_URL`, `ORG_ID`, `ADMIN_GRANTS`, and `PUBLIC_API_URL` when sandboxes reach core through a tunnel. The three surfaces can run in parallel against one instance. Exit status is non-zero when any check fails.

| Surface       | Checks                                                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fires`       | A typed admin turn, a cron fired now for an admin owner and for a non-admin owner, a signed webhook (a bad signature must get 401), and a loop fire each run the same self-API probe from inside the sandbox. The matrix shows the authority each origin carries: admin read, admin write, memory, skills, crons. |
| `credentials` | Saves a synthetic keychain credential, then runs `execute` with and without its handle: the value must be injected only when selected, masked in tool output, and absent from stored transcripts.                                                                                                                 |
| `sandbox`     | A brand-new principal's first turn provisions a box (cold), a second turn reuses it (warm), and both reach the self-API from inside the box. The run then retires the boxes it created through the admin API.                                                                                                     |

Evidence (transcripts, run provenance, verdicts) goes to `~/qa-evidence/<time>-<surface>/`, or `QA_EVIDENCE_DIR`. A fire must start a run within 90 s and every turn must finish within 6 minutes, several times the slowest cold sandbox turn seen; a slower run fails with the status it reached.

Models may refuse a probe that reads as privilege escalation, so the non-admin cron probe leaves out the admin write and the typed admin write goes through the `admin` tool. A manual loop fire runs only the intake stage, so the loop check covers wiring and provenance, not item work.
