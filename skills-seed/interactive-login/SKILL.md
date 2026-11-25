---
name: interactive-login
description: Log a CLI in with a browser/device-code flow (aws sso, gh, glab, gcloud, …) and save the result to the keychain so later commands can request it through execute.credentials.
---

# Interactive login

Nothing captures logins for you. Every login runs in a fresh temporary home and is saved
to the keychain with the script shipped with this skill. Never log in against the real
`$HOME`, and never treat a token or config already in `$HOME` as a usable login: only a
keychain handle is. Use the same explicit `sandbox_id` for the skill read, login,
and save-login commands so the temporary home and save script stay on one computer.

## One expiry, one code

A saved login is shared: every conversation that names its handle gets the same files. When
it expires, it expires for all of them at once, and one approved code that gets saved fixes
it for all of them. Asking the person twice for the same expiry is a mistake on your side.

- **Check before you ask, and again before you ask twice.** Name the handle in
  `execute.credentials` and run the CLI's identity check (AWS:
  `aws sts get-caller-identity --profile <profile>`). Another conversation may have renewed
  the login while you waited.
- **A subagent does not start a sign-in.** Report the expired login to whoever started
  you. The conversation that started you runs one sign-in and relays one code.
- **Don't send a second code until you know why the first approval didn't stick**, and tell
  the person what happened.

### How an approved code gets lost

A command that names a handle does not use your computer's home directory. It works on a
private copy of the saved files. Its changes are saved back at most once, when that command
or background job exits, and then the copy is deleted. That loses approved codes three ways:

- **The login outlives its command.** This job exits after six seconds, before anyone can
  approve:

  ```bash
  nohup aws sso login --profile work --use-device-code --no-browser > /tmp/sso.log 2>&1 &
  sleep 6; cat /tmp/sso.log
  ```

  The login keeps waiting on its own. The person approves, the CLI prints "Successfully
  logged into Start URL", and the token goes into a copy that was already thrown away. A
  script that starts the login and returns does the same.

- **You check from another command.** Each command gets its own copy of what was last
  saved, so it cannot see a login that is still running or was never saved.
- **You log in with no handle and no save.** The token stays in the computer's own `$HOME`,
  which no saved login reads.

The steps below avoid all three: the login is the background job's own command, it writes
to a directory that stays on your computer, and step 3 saves it.

## Steps

1. Make a fresh directory, then start the login with `execute(background:true)` with every
   config location pointed into the directory. Copy in any config the CLI needs first (for
   AWS, the `[profile …]`/`[sso-session …]` blocks in `.aws/config`); everything under that
   directory becomes the saved login.

   ```bash
   d=$(mktemp -d) && echo "$d"
   in_d() { env HOME="$d" XDG_CONFIG_HOME="$d/.config" XDG_DATA_HOME="$d/.local/share" XDG_STATE_HOME="$d/.local/state" XDG_CACHE_HOME="$d/.cache" "$@"; }
   in_d aws sso login --profile work --use-device-code --no-browser
   in_d gh auth login --hostname github.com --git-protocol https --web
   in_d glab auth login --hostname gitlab.com --web
   in_d gcloud auth login --no-launch-browser
   ```

   Use the CLI's device-code mode (AWS needs `--use-device-code`); a browser flow only
   completes on the same machine.

2. Relay the verification URL and code from the job output. Answer any prompt with
   `background` action `send_input`. Use its `watch` or `poll` action with the returned
   `process_id`; never stop the job while the person is approving.

3. When it exits successfully, save the directory with the script shipped with this skill,
   under the absolute directory the skill read reported:

   ```bash
   node <skill dir>/scripts/save-login.mjs aws "$d" --label "work (123456789012)"
   ```

   The script uploads only the files under that directory, removes the directory, and
   prints the credential handle. It also removes a directory that holds no usable login.
   Never remove the directory yourself; if the save fails, run the script again.
   Saving the same service again replaces that entry in place: its id, handle, owner and
   grants stay the same.

4. Use the login only by naming the handle in `credentials` on `execute` (including `background:true`), including to check that it works. The files are staged in a private home for
   that command or job, and refreshes the CLI writes are saved back when it ends.

Never print token files or paste their contents into the conversation. If the login fails
or expires, follow "One expiry, one code" above before starting again from step 1 with a
new directory.
