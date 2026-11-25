# Browser QA on a dev instance

Three commands drive the real web UI and admin portal of a running dev instance in Playwright. Start the
instance first (`npm run dev-instance:web`); the scripts find it from the current checkout, sign in through
the portal's localhost bypass, and use the instance's own signing secrets for setup calls. They need Linux
(`/proc`). The first run installs Playwright and its browsers into `~/.cache/qm-qa`; if a browser can't
start, the error prints the `install-deps` command for its system libraries.

| Command                      | What it does                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run qa:web`             | Chat, cron, approval, background-run and Slack checks in Chromium and WebKit, in parallel |
| `npm run qa:portal`          | Opens every settings page and checks it renders without page errors or 5xx responses      |
| `npm run qa:event -- <kind>` | Triggers one background event so you can look at the resulting UI state yourself          |

Screenshots and `report.json` go to `~/.cache/qm-qa/runs/<kind>-<time>/`. Each command
exits non-zero when a check fails.

## Web UI

`npm run qa:web -- --browser webkit --check approval,slack` narrows the run. Checks:

- `chat`: starts a new session, sends a prompt, waits for the streamed reply.
- `cron`: opens an empty session, fires a cron that delivers into it, and waits for the delivered message to
  appear without a reload.
- `approval`: makes the agent run a command that the scope's command policy holds for approval, clicks
  "Allow once" on the composer card, and waits for the result.
- `background`: submits a turn outside the browser and waits for its session to appear in the sidebar and
  its reply to land.
- `slack`: submits a Slack-surface turn and checks the session shows the Slack mark and reply. Nothing is
  sent to Slack; the reply stays queued for a Slack plugin that isn't running.

The approval check adds a `qa-approval-probe` rule to the signed-in person's command policy and leaves it in
place.

## Admin portal

`npm run qa:portal -- --list` prints the page keys, discovered from the settings navigation plus the
onboarding, keychain, ack emoji, user detail and session transcript pages. `--page users,user` checks only
those pages; `--browser chromium,webkit` adds WebKit. 4xx responses and console errors are reported as notes
rather than failures, because several settings pages probe optional features that answer 403 or 404 when
they are off.

## Triggering events by hand

`npm run qa:event -- cron|approval|background|slack` prints JSON with the session's URL. `approval` returns a
`requestId`; resolve it with `npm run qa:event -- approve <requestId>` or `deny <requestId>`.
