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
Directories older than an hour are swept when the next execution starts; no execution lives
that long, so concurrent executions never remove each other's files.

There is no capture lock, background-process restriction, capture registry column or
`register_login` tool. Nothing is restored into `$HOME` at provisioning.

## Known gaps

- The staging directory is protected by mode 0700 and a random name, not by a separate user.
  Another process running as the same user during the command can read it.
- `/v1/keychain/use` returns 410; the `browse` skill still documents it.
- No proactive refresh for idle AWS sessions; the CLI refreshes only when a command runs.
- Granted non-AWS file credentials cannot be written back.
