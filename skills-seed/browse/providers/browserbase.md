# Browse provider: Browserbase (browserbase.com)

Provider names for the shared flow in SKILL.md: API key `BROWSERBASE_API_KEY`, keychain
service `browserbase`. Run this before the shared profile snippets:

```bash
export PROFILE_ENV=BROWSERBASE_CONTEXT PROFILE_SERVICE=browserbase-context
```

All calls authenticate with the `X-BB-API-Key` header. `projectId` is optional
everywhere — it's inferred from the API key. `connectUrl` is a tokenized websocket — a
secret, like any CDP URL.

## Profiles (Browserbase calls them Contexts)

The profile value here is a provider-assigned **context id**, not a name you mint: in
SKILL.md's first-time bootstrap, REPLACE the minted `$PROFILE` with the id from a context
create, then continue with the keychain registration unchanged:

```bash
PROFILE=$(curl -fsS -X POST https://api.browserbase.com/v1/contexts \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' -d '{}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
export "$PROFILE_ENV"="$PROFILE"
```

A context stores the signed-in state (cookies, localStorage, and friends). Three rules
keep sign-ins alive across runs — each one broken means the person logs in again:

- **Only sign-in sessions write.** A task session names the context WITHOUT `persist`
  (defaults false — read-only load); only the dedicated sign-in session below sets
  `persist: true`, and its state lands in the context when the session is RELEASED, not
  while it runs.
- **One session per context at a time.** Browserbase warns that concurrent sessions on
  one context can force a logout at the site — always release the running session before
  starting another on the same context.
- **Give the write-back a beat.** After releasing a `persist: true` session, wait a few
  seconds before launching the next session on that context — persistence is async.

There is no hands-free re-auth tier: when a site expires the cookies, the person signs in
again through the same live-view flow below.

## Create the browser

`keepAlive` matters everywhere here: without it the session dies as soon as a CDP client
disconnects, so a runner retry or the sign-in handoff below would find a dead browser.
(It needs the Hobby plan or above.) In a DM, with the person's context:

```bash
CREATE=$(curl -fsS -X POST https://api.browserbase.com/v1/sessions \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d "{\"keepAlive\":true,\"timeout\":1800,\"browserSettings\":{\"context\":{\"id\":\"$BROWSERBASE_CONTEXT\"}}}")
CDP_URL=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('connectUrl',''))")
BB_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
LIVE_VIEW=$(curl -fsS "https://api.browserbase.com/v1/sessions/$BB_SID/debug" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('debuggerFullscreenUrl',''))")
```

Live-view URLs are PER-TAB: the top-level `debuggerFullscreenUrl` is tab one's, and it
goes stale once the task opens more tabs. Whenever you hand a live-view link over later,
re-fetch `/v1/sessions/$BB_SID/debug` at hand-off time and pick the right entry from
`pages[]` (each has its own `debuggerFullscreenUrl`, `url`, and `title`).

In a channel or group, OMIT `browserSettings.context` entirely (per the DM-only rule):

```bash
CREATE=$(curl -fsS -X POST https://api.browserbase.com/v1/sessions \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d '{"keepAlive":true,"timeout":1800}')
```

then extract `CDP_URL` / `BB_SID` / `LIVE_VIEW` exactly as above.

Timeout is seconds (60–21600); captcha solving is on by default. For a site behind
serious bot protection, add top-level `"proxies":true` and
`"browserSettings":{"advancedStealth":true}` (a Scale-plan feature) — billed extras,
reach for them on a block, not by default.

## Giving the browser a file

Upload via the Session Uploads API; files land at `/tmp/.uploads/<name>`:

```bash
curl -fsS -X POST "https://api.browserbase.com/v1/sessions/$BB_SID/uploads" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -F "file=@/tmp/receipt.jpg"
```

Then run the task with `BROWSE_FILES="/tmp/.uploads/receipt.jpg"` per SKILL.md.

## Routing a sign-in wall

Browserbase has no hosted login page or credential store in this flow — the person signs
in THEMSELVES through the live view, and the context keeps them signed in afterwards.
Release the old task browser first and give the release a beat: it's async, the keepAlive
session is still RUNNING when the call returns, and two sessions on one context is
exactly the forced-logout case:

```bash
curl -fsS -X POST "https://api.browserbase.com/v1/sessions/$BB_SID" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d '{"status":"REQUEST_RELEASE"}'
sleep 5
```

Create the sign-in session — the one place `persist: true` appears:

```bash
SIGNIN=$(curl -fsS -X POST https://api.browserbase.com/v1/sessions \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d "{\"keepAlive\":true,\"timeout\":1800,\"browserSettings\":{\"context\":{\"id\":\"$BROWSERBASE_CONTEXT\",\"persist\":true}}}")
SIGNIN_SID=$(printf '%s' "$SIGNIN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
SIGNIN_CDP=$(printf '%s' "$SIGNIN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('connectUrl',''))")
```

It opens on a blank page, so steer it to the wall, then fetch the live-view link
(`keepAlive` is what lets the session survive the nav script disconnecting — without it
the person would open a dead live view):

```bash
cat > /tmp/bb-nav.py <<'PY'
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(os.environ["SIGNIN_CDP"])



    ctx = b.contexts[0]
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(open("/tmp/wall-url.txt").read().strip(), timeout=60000)
    b.close()
PY
SIGNIN_CDP="$SIGNIN_CDP" /opt/browser-engine/venv/bin/python /tmp/bb-nav.py
curl -fsS "https://api.browserbase.com/v1/sessions/$SIGNIN_SID/debug" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('debuggerFullscreenUrl',''))"
```

Hand them the printed URL — it's their browser: they sign in, complete any 2FA, and say
done. Expectation-setting: the context persists session cookies, it can't re-answer
challenges — a site that re-verifies each visit (SMS/email OTP) will need the person
again next time. Then RELEASE the sign-in session (this is what writes the context), give
the write-back a beat, create a fresh task browser (it launches signed in), and re-run
the task:

```bash
curl -fsS -X POST "https://api.browserbase.com/v1/sessions/$SIGNIN_SID" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d '{"status":"REQUEST_RELEASE"}'
sleep 5
```

A mid-session verification check on a LIVE task browser needs no persist dance — hand the
person a FRESH live-view link (re-fetch `/debug` and pick the challenged tab from
`pages[]`, per the per-tab note above), wait for done, re-run the task on the same
browser.

## Clean up

Sessions bill by the minute and `keepAlive` sessions outlive disconnects — always release:

```bash
curl -fsS -X POST "https://api.browserbase.com/v1/sessions/$BB_SID" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d '{"status":"REQUEST_RELEASE"}'
```

## API reference

Read these instead of guessing when a call surprises you:

- Sessions (create/update/release, keepAlive, timeout, proxies): https://docs.browserbase.com/reference/api/create-a-session
- Contexts (persistence semantics, one-session rule): https://docs.browserbase.com/features/contexts
- Live view (debug URLs, human takeover): https://docs.browserbase.com/features/session-live-view
- Uploads: https://docs.browserbase.com/features/uploads
