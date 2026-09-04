---
name: interactive-login
description: How to complete browser/interactive logins (aws / gh / glab / gcloud). The platform backgrounds the login poller so it survives the human's browser round-trip — and when that does NOT work.
---

# Interactive login (and what backgrounding can and can't do)

Some logins are interactive: the CLI prints a verification URL + one-time code, then
**polls** the provider until the human approves in a browser, and only then writes the
token to `$HOME`. Run that as a plain blocking `execute` and it either hangs your whole
turn waiting for a human, or — worse — the turn's sandbox is torn down at turn end and
the poller dies _before_ the human finishes, so nothing is ever saved. The next turn
starts over and loops forever.

You usually don't have to manage any of this. **Just run the native login command.**

```bash
aws sso login --use-device-code
```

> **AWS (and CLIs that log in through AWS SSO):** always pass `--use-device-code`
> (`aws sso login` ≥ CLI v2 2.22). The bare form uses a PKCE flow
> that redirects to `127.0.0.1` and only completes if the approving browser is on the
> _same machine_ as the CLI. Since the user approves on _their_ computer, that flow can
> never finish on the agent computer; `--use-device-code` forces the device-grant (URL +
> code, completed by server-side polling) that works cross-device.

On the resident, per-scope agent computer (the production substrate), the platform
recognizes these as interactive logins and runs each as a **durable process session**
(ADR 0002): it returns the verification URL + code to you immediately instead of
blocking, and keeps polling the provider **on the agent computer across turns**. (This
recognition is wired only where the backend supports process sessions — on a per-turn
local/docker sandbox nothing intercepts the command and it just blocks; see "When it
will NOT work".) When the human approves, the poller writes the token into the
durable `$HOME` and exits. Give the user the URL + code, tell them to approve, then on
a later turn re-run the same command (or any command for that tool) — if approval
landed, the platform reports you're already authenticated; if not, you get the same URL

- code back. Each pending login self-expires (~10–15 min); if it lapses, just run the
  login again.

So the right pattern is: **run the native login, hand over the URL + code, continue,
and re-check later.** You do not poll in a loop, you do not hold the turn open, and you
do not hand-roll the exchange yourself.

## When backgrounding works

- The agent computer is a **resident, per-scope machine** (the production substrate —
  `SANDBOX=fly`): it has durable process sessions and a durable `$HOME`, so a login
  started in one turn is still polling in the next and the token persists.
- The command is one of the **recognized native flows**: `aws sso login`,
  `gh auth login`, `glab auth login`, `gcloud auth login`. The platform knows these
  poll-then-write and keeps them alive for you.

## When it will NOT work (don't rely on it)

- **On a per-turn sandbox (local/docker dev).** Those backends have no process
  sessions and are torn down at the end of every turn — there is nothing to keep the
  poller alive across the human's approval. An interactive browser login cannot
  complete there. Use a **non-interactive** path instead: a token via env or
  `--with-token` / `--token --stdin`, a service-account / credentials file, or
  `--cred-file`. The platform deliberately leaves those non-interactive token forms to
  run normally (it only backgrounds the interactive login).
- **For logins the platform doesn't recognize.** A CLI that prompts for a
  username/password at the TTY, or a bespoke OAuth flow that isn't in the list above,
  is **not** backgrounded — it runs as an ordinary blocking command and will hang and
  then die at turn teardown. Prefer that tool's non-interactive/token auth, or ask the
  user to provide a token you can configure.
- **For arbitrary processes you spawn yourself.** Backgrounding with `&` / `nohup`
  does **not** make a process survive between turns. Only _declared_ session kinds are
  kept alive past teardown, and today only the interactive-login broker is wired in.
  A dev server, a long build, or a `sleep` you launch will be reaped when the turn
  ends — don't architect a task around "I'll leave it running in the background."

## Boundaries

- A backgrounded login session is **scope-keyed** to the requesting scope and lives on
  that scope's computer only — it never crosses the data boundary; another principal in
  the same thread cannot read your session or use the resulting auth.
- A session is a **host for resident state, not an authority.** The login only
  completes the auth exchange; any side-effecting or destructive command you run
  afterward still goes through the normal approval path.
- Never echo the token, one-time code reuse, client secret, or resulting credentials
  into the channel — hand over only the verification URL + code the human needs.
