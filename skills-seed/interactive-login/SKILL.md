---
name: interactive-login
description: Log a CLI in with a browser/device-code flow (aws sso, gh, glab, gcloud, …) and save the result to the keychain so later commands can request it through execute.credentials.
---

# Interactive login

Nothing captures logins for you. Every login runs in a fresh temporary home and is saved
to the keychain with the script shipped with this skill. Never log in against the real
`$HOME`, and never treat a token or config already in `$HOME` as a usable login: only a
keychain handle is.

1. Make a fresh directory and start the login as a background job with every config
   location pointed into it. Copy in any config the CLI needs first (for AWS, the
   `[profile …]`/`[sso-session …]` blocks in `.aws/config`); everything under that
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
   send_input. Watch the job; never stop it while the person is approving.

3. When it exits successfully, save the directory with the script under the absolute
   directory the skill read reported:

   ```bash
   node <skill dir>/scripts/save-login.mjs aws "$d" --label "work (123456789012)"
   ```

   The script uploads only the files under that directory, removes the directory, and
   prints the credential handle. It also removes a directory that holds no usable login.
   Never remove the directory yourself; if the save fails, run the script again.
   Saving the same service again replaces that entry in place: its id, handle, owner and
   grants stay the same.

4. Use the login only by naming the handle in `credentials` on `execute` or a background
   start, including to check that it works. The files are staged in a private home for
   that command or job, and refreshes the CLI writes are saved back when it ends.

Never print token files or paste their contents into the conversation. If the login fails
or expires, start again from step 1 with a new directory.
