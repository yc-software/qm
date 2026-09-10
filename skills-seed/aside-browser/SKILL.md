---
name: aside-browser
description: Use a person's own logged-in Aside Browser through Remote Control for browser tasks across websites, accounts, files, history, and Aside memory. Also use when the person asks to connect, disconnect, or troubleshoot Aside in QM.
---

# Aside Browser through Remote Control

Aside Remote Control keeps the browser, cookies, passwords, and website sessions on the person's Mac. QM runs the official Aside CLI on the person's agent computer; the CLI sends the task through Aside's relay, and the selected Mac streams the session result back. Session content crosses the relay while attached, but the browser profile does not leave the Mac.

Use this only in the person's own DM. Never connect or use a personal remote browser from a channel, group, scheduled run, webhook, or unattended trigger.

## Check the connection

Run `aside guide` before using the CLI. Then run:

```bash
aside host list --json
```

A usable host has both `remoteControlEnabled: true` and `online: true`. Never target an offline or disabled host. If exactly one host is usable, select it with `aside host use <host-id>`. If several are usable, ask which device to use and show only their device names. Do not show host IDs unless two names are identical.

If `aside` is missing and the person explicitly asked to connect or use Aside, install the official CLI, then re-run `aside guide`:

```bash
curl -fsSL https://releases.aside.com/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
aside guide
```

For any other request, ask before installing software.

## Connect once

If `aside host list --json` says to sign in, never ask for or accept an Aside password in chat. On the person's live turn, mint one secure multi-field drop with a one-time grant:

```bash
curl -fsS -X POST "$AGENT_API_URL/v1/keychain/drops" -H "x-agent-capability: $AGENT_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"service":"aside.com","purpose":"sign in the official Aside CLI once, then delete the submitted password","grantMode":"once","fields":[{"key":"ASIDE_EMAIL","label":"Aside email","secret":false},{"key":"ASIDE_PASSWORD","label":"Aside password","secret":true}]}'
```

Give the returned URL to the person. The conversation wakes when they submit it. Load the one-time grant using the exact `keychain/use` command in the wake message, then sign in without printing either field:

```bash
printf '%s\n' "$ASIDE_PASSWORD" | aside login --email "$ASIDE_EMAIL"
unset ASIDE_EMAIL ASIDE_PASSWORD
rm -f /tmp/keychain.env /tmp/aside-login.env
```

After sign-in succeeds, immediately delete the temporary `aside.com` credential through `DELETE /v1/keychain/credentials/:id`. The CLI keeps only its revocable access and refresh tokens in its private durable home. Never read, copy, upload, or print `~/.aside/cli/auth.json`.

If the account was created only with Google and direct password sign-in is rejected, explain that the current Aside CLI requires app-backed sign-in for that account. Do not ask for Google credentials or improvise a token transfer.

Run `aside host list --json` again. If no usable host appears, tell the person to open Aside on the Mac, go to Settings → Developers, enable “Allow remote sessions on this machine,” and leave Aside running. Remote Control requires Aside Pro. Recheck only after they confirm it is enabled.

## Run a browser task

Use `aside exec`, not `aside repl`, for normal work. Pass the selected host explicitly even after saving the default, keep Guard on, and shell-quote the person's task as one argument:

```bash
aside exec --host <host-id> --permission guard "<task>"
```

Use `--permission full-access` only when the person explicitly authorizes it. For a task likely to run longer than the foreground tool window, start it with the background tool and poll that job instead of launching another copy. Relay the final answer and any artifact paths back to the person.

The CLI prints the Aside session ID. Keep it for follow-ups:

```bash
aside session resume <session-id> "<follow-up>"
aside session steer <session-id> "<new direction>"
aside session queue <session-id> "<next step>"
aside session stop <session-id>
```

Resume the same session for follow-ups instead of starting a new one. Never expose relay URLs, bearer tokens, CLI auth files, or host IDs in shared conversations.

## Disconnect

When the person asks to disconnect QM from Aside, run:

```bash
aside logout
```

Confirm that `aside host list --json` now requires sign-in. Do not disable Remote Control on the Mac unless the person separately asks for that.
