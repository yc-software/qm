# Credential login and refresh

## Design

The platform no longer captures logins. Logging in is a skill the agent follows
(`skills-seed/interactive-login`):

1. The agent runs the native login as an ordinary background job with `HOME` pointed at a
   fresh `mktemp -d` directory and relays the verification URL and code.
2. After the job exits, `scripts/save-login.mjs <service> <dir>` uploads only the files under
   that directory through `POST /v1/keychain/credentials` and deletes the directory. Secrets
   never enter model context.
3. Later commands get the login only by naming its handle in `execute.credentials`.

Re-saving a service replaces the entry in place. The credential id is derived from owner,
service and slot, so the handle, owner and grants are unchanged; `createdAt` is kept, while
files, origin, label and expiry come from the new save.

## Execution

`src/credentials/execute-files.ts` stages requested bundles in a private
`/tmp/qm-credentials.<random>/home`, points the CLI at it, captures changed files after the
command and writes them back with `keychain.updateFiles`, which rejects stale writes and
applies the AWS grant rules. Each execution removes its own directory in `finally`.

Background jobs accept the same `credentials` handles. The staging plan, credential ids,
grant ids and baseline fingerprints (no secrets) are stored on the job's `process_sessions`
row (`credential_files`). Any path that observes the exit (background poll/stop, monitor,
reaper, reconcile on provision) re-checks the baseline against the keychain, writes
refreshes back, clears the column and removes the directory. If a write fails for a reason
other than a keychain rejection, the column and directory stay so a later observer or the
next provision retries. A start that fails after the process launched leaves cleanup to
these paths. The start call masks the job's env credential values in its initial output;
later polls are unmasked, as on main, because no secret values are stored.

Directories older than two hours are swept when the next credentialed execution starts,
which is longer than any execution or background job may live, so concurrent operations never
remove each other's files.

There is no capture lock, background-process restriction or `register_login` tool. Nothing
is restored into `$HOME` at provisioning. `/v1/keychain/use` no longer exists.

## Known gaps

- The staging directory is protected by mode 0700 and a random name, not by a separate user.
  Another process running as the same user during the command can read it.
- No proactive refresh for idle AWS sessions; the CLI refreshes only when a command runs.
- Granted non-AWS file credentials cannot be written back.
