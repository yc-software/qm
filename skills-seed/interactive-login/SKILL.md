---
name: interactive-login
description: Log a CLI in with a browser/device-code flow (aws sso, gh, glab, gcloud, …) and save the result to the keychain so later commands can request it through execute.credentials.
---

# Interactive login

Nothing captures logins for you. Run the login in a private temporary HOME, then save
that directory to the keychain with the script shipped with this skill.

1. Start the login as a background job with HOME pointed at a fresh directory. Copy in
   any config the CLI needs first (for AWS, the `[profile …]`/`[sso-session …]` blocks in
   `.aws/config`); everything under that directory becomes the saved login.

   ```bash
   d=$(mktemp -d) && echo "$d"
   HOME=$d aws sso login --profile work --use-device-code --no-browser
   HOME=$d gh auth login --hostname github.com --git-protocol https --web
   HOME=$d glab auth login --hostname gitlab.com --web
   HOME=$d gcloud auth login --no-launch-browser
   ```

   AWS needs `--use-device-code`: the default PKCE flow only completes in a browser on the
   same machine.

2. Relay the verification URL and code from the job output. Answer any prompt with
   send_input. Watch the job; never stop it while the person is approving.

3. When it exits successfully, save and delete the directory:

   ```bash
   node skills/interactive-login/scripts/save-login.mjs aws "$d" --label "work (123456789012)"
   ```

   The script uploads only the files under that directory and prints the credential handle.
   Saving the same service again replaces that entry in place: its id, handle, owner and
   grants stay the same.

4. Use the login only by naming the handle in `execute.credentials`. The files are staged
   in a private home for that one command, and refreshes the CLI writes are saved back.

Never print token files or paste their contents into the conversation. If the login fails
or expires, delete the directory and start again.
