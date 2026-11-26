# Credential login and refresh

## Design

Logging in is a skill the agent follows (`skills-seed/interactive-login`):

1. The agent runs the native login as an ordinary background job with `HOME` and the XDG
   directories pointed at a fresh `mktemp -d` directory and relays the verification URL and
   code.
2. After the job exits, `scripts/save-login.mjs <service> <dir>` uploads only the files under
   that directory through `POST /v1/keychain/credentials` and deletes the directory. Secrets
   never enter model context. The keychain limits a login to 500 files and 8 MiB.
3. Later commands get the login only by naming its handle in `execute.credentials`.

Re-saving a service replaces the entry in place. The credential id is derived from owner,
service and slot, so the handle, owner and grants are unchanged; `createdAt` is kept, while
files, origin, label and expiry come from the new save.

Any run carrying the owner's authority may replace an existing entry, including a scheduled
fire or a background job whose turn has ended. Work a bot started may save a new service but
not replace one.

## Execution

Every command that names a saved login runs on the turn's scratch computer, in shared and
personal conversations alike, so the bundle is staged there and never on the conversation's
computer. A background job that names one runs on its own job computer.

`src/credentials/execute-files.ts` stages requested bundles in a private
`/tmp/qm-credentials.<random>/home`, points the CLI at it, captures changed files after the
command and writes them back with `keychain.updateFiles`, which rejects stale writes. Only the
owner's executions write back; a grant uses the saved files as they are. An owner's execution
writes back every change, whatever started it: a typed turn, a cron, loop, watch or webhook
fire, a subagent, a swarm worker, or a background job that outlives its turn, so a full
re-login made in the background is saved like one made in a conversation. Each execution
removes its own directory in `finally`.

Background jobs accept the same `credentials` handles. The staging plan, credential ids,
grant ids and baseline fingerprints (no secrets) are stored on the job's `process_sessions`
row (`credential_files`). Any path that observes the exit (background poll/stop, monitor,
reaper, reconcile on provision) re-checks the baseline against the keychain, writes
refreshes back, clears the column and removes the directory. If a write fails for a reason
other than a keychain rejection, the column and directory stay so a later observer or the
next provision retries. A start that fails after the process launched leaves cleanup to
these paths. The start call masks the job's env credential values in its initial output;
later polls are unmasked because no secret values are stored.

Directories older than two hours are swept when the next credentialed execution starts,
which is longer than any execution or background job may live, so concurrent operations never
remove each other's files.

## Known gaps

- The staging directory is protected by mode 0700 and a random name, not by a separate user.
  Another process running as the same user during the command can read it.
- No proactive refresh for idle AWS sessions; the CLI refreshes only when a command runs.
- Refreshes made through a grant are not saved.
