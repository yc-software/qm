# Browse provider: Browser Use Cloud (browser-use.com)

Provider names for the shared flow in SKILL.md: API key `BROWSER_USE_API_KEY`, keychain
service `browser-use`. Run this before the shared profile snippets:

```bash
export PROFILE_ENV=BROWSER_USE_PROFILE PROFILE_SERVICE=browser-use-profile
```

All calls go to `https://api.browser-use.com/api/v4` and authenticate with the
`X-Browser-Use-API-Key` header (no `Bearer` prefix). Credits, concurrency and the key's
project are at `GET https://api.browser-use.com/api/v2/billing/account` — check it first
when a create returns 402 (out of credit) or 429 (too many active browsers).

Every browser runs Browser Use's hardened Chromium with stealth and anti-fingerprinting
on by default, plus a US residential proxy and automatic CAPTCHA solving — there is no
stealth flag to set.

## Profiles

The profile value here is a provider-assigned **profile id** (a UUID), not a name you
mint: in SKILL.md's first-time bootstrap, REPLACE the minted `$PROFILE` with the id from a
profile create, then continue with the keychain registration unchanged:

```bash
PROFILE=$(curl -fsS -X POST https://api.browser-use.com/api/v4/profiles \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"qm"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
export "$PROFILE_ENV"="$PROFILE"
```

A profile stores cookies and local storage. Rules that keep sign-ins alive:

- **State is written when the browser STOPS.** Closing CDP does not stop a Browser Use
  browser, and nothing is saved until the stop call in Clean up runs. A browser that
  times out instead loses what happened in it.
- **One browser per profile at a time.** Stop the running browser before starting another
  on the same profile; parallel sessions on one login invite forced logouts.
- **Give the write-back a beat.** Wait ~10 seconds after a stop before launching the next
  browser on that profile.
- **Use the default browser context.** A fresh incognito context (`new_context()`) does
  not inherit the profile's cookies.

`GET /profiles/$BROWSER_USE_PROFILE` returns `cookieDomains` — the quickest check of which
sites the profile holds state for.

## Create the browser

In a DM, with the person's profile:

```bash
CREATE=$(curl -fsS -X POST https://api.browser-use.com/api/v4/browsers \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" -H 'content-type: application/json' \
  -d "{\"profileId\":\"$BROWSER_USE_PROFILE\",\"timeout\":30}")
BU_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
CDP_BASE=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['cdpUrl'].rstrip('/'))")
CDP_URL=$(curl -fsS "$CDP_BASE/json/version" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['webSocketDebuggerUrl'])")
LIVE_VIEW=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['liveUrl'])")
```

`cdpUrl` is an `https://…cdp.browser-use.com` base; the `/json/version` hop turns it into
the websocket the runner drives. Both it and `LIVE_VIEW` are bearer material — anyone
holding either controls the browser.

In a channel or group, OMIT `profileId` (per the DM-only rule):

```bash
CREATE=$(curl -fsS -X POST https://api.browser-use.com/api/v4/browsers \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" -H 'content-type: application/json' \
  -d '{"timeout":30}')
```

then extract `BU_SID` / `CDP_URL` / `LIVE_VIEW` exactly as above.

`timeout` is minutes (1–240). `proxyCountryCode` defaults to `"us"`; pass another ISO
code to change it, or `null` to drop the proxy. Browsers bill per minute, refunded
pro rata on stop.

## Giving the browser a file

The browser's filesystem is not reachable from here, and `file://` pages are blocked, so
the runner's `available_file_paths` route does not apply. Hand the file to the page
directly instead: open the page with the file input, then inject the bytes over CDP.
Point `SELECTOR` at the target input:

```bash
cat > /tmp/bu-attach.mjs <<'JS'
import fs from "fs";
const [, , wsUrl, filePath, selector] = process.argv;
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const { targetInfos } = (await send("Target.getTargets")).result;
const page = targetInfos.find(t => t.type === "page");
const { sessionId } = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).result;
const b64 = fs.readFileSync(filePath).toString("base64");
const name = filePath.split("/").pop();
const expression = `(()=>{const s=atob(${JSON.stringify(b64)});const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);
const dt=new DataTransfer();dt.items.add(new File([u],${JSON.stringify(name)}));const el=document.querySelector(${JSON.stringify(selector)});
el.files=dt.files;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return el.files[0].size})()`;
const id2 = ++id;
const done = new Promise(r => pending.set(id2, r));
ws.send(JSON.stringify({ id: id2, sessionId, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
console.log(JSON.stringify((await done).result?.result));
ws.close();
JS
node /tmp/bu-attach.mjs "$CDP_URL" /tmp/receipt.jpg "$SELECTOR"
```

Then run the task telling the agent the file is already attached. Keep files small
(this inlines the bytes); a site that reads the file only through a native picker dialog
won't see it.

## Routing a sign-in wall

The person signs in THEMSELVES through the live view; the profile keeps them signed in
afterwards. Reuse the task browser — it already holds the profile — and steer it to the
wall:

```bash
cat > /tmp/bu-nav.py <<'PY'
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(os.environ["CDP_URL"])
    ctx = b.contexts[0]
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(open("/tmp/wall-url.txt").read().strip(), timeout=60000)
PY
CDP_URL="$CDP_URL" /opt/browser-engine/venv/bin/python /tmp/bu-nav.py
printf '%s\n' "$LIVE_VIEW"
```

Hand them `$LIVE_VIEW`: they sign in, finish any 2FA, and say done. Confirm the page now
shows them signed in, then STOP the browser (that is what writes the profile), wait
~10 seconds, create a fresh browser on the same profile, and re-run the task. The profile
replays cookies; it cannot answer a challenge, so a site that re-verifies on every visit
needs the person again next time.

A mid-session verification check on a live task browser needs no stop — hand over
`$LIVE_VIEW`, wait for done, re-run on the same browser.

## Clean up

Always stop the browser — it keeps billing until its timeout otherwise, and stopping is
what saves the profile:

```bash
curl -fsS -X PATCH "https://api.browser-use.com/api/v4/browsers/$BU_SID" \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" -H 'content-type: application/json' \
  -d '{"action":"stop"}'
```

## API reference

Read these instead of guessing when a call surprises you (the full bundle is
https://docs.browser-use.com/.well-known/llms-full.txt):

- Browsers (create, stop, timeout, proxy): https://docs.browser-use.com/cloud/api-v4/browsers/create-browser-session.md
- Profiles: https://docs.browser-use.com/cloud/guides/authentication.md
- CDP control: https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium.md
- Live view: https://docs.browser-use.com/cloud/browser/live-preview.md
- Stealth, proxies, CAPTCHAs: https://docs.browser-use.com/cloud/browser/stealth.md
