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

## Execution

In a shared conversation, every command that names a saved login runs on the turn's
scratch computer, so the bundle is staged there and never on the conversation's computer;
in the owner's personal conversation it is staged on their own computer unless another
conversation shares that computer through an environment.

`src/credentials/execute-files.ts` stages requested bundles in a private
`/tmp/qm-credentials.<random>/home`, points the CLI at it, captures changed files after the
command and writes them back with `keychain.updateFiles`, which rejects stale writes. Only the
owner's executions write back; a grant uses the saved files as they are. The owner's live turn
writes back everything: a turn the owner's own message started in an all-internal conversation,
meaning a DM or a room whose turn carries a member list in which everyone is internal (a live
ambient wake included), a subagent delegated from one, the turn that resumes when that subagent
reports back, a conversation such a turn starts or forks, and a background job any of these
started. Every other run writes back only a token refresh: a file the saved login already holds
in `.aws/sso/cache/` in which only `accessToken`, `expiresAt` and `refreshToken` changed. That
covers cron, loop, watch and webhook fires, swarm workers (a swarm a live turn started
included), resumes after a credential request or secret drop, reaction turns, messages between
sessions, bot-marked and impersonated turns, the owner's own messages in a room whose turns
carry no member list (a web shared channel or group that isn't a project, and a partner-chat
group chat), and the jobs they start. Anything else such a run changed keeps the stored version;
the core log names each path and why, and a foreground command's stderr says so. Each execution
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
- An unattended refresh of a CLI that rotates its refresh token outside the declared token
  caches is not saved, so the next use asks the owner to sign in again.
