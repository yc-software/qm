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
[ -n "$PROFILE" ] || { echo "profile create returned no id" >&2; exit 1; }
export "$PROFILE_ENV"="$PROFILE"
```

A profile stores cookies and local storage. Rules that keep sign-ins alive:

- **State is written when the browser stops**, either by the stop call in Clean up or by
  hitting its `timeout`. Nothing is saved while it runs, and closing CDP (or the runner
  exiting) does not stop it. Stop explicitly rather than waiting out the timeout.
- **One browser per profile at a time.** Stop the running browser before starting another
  on the same profile; parallel sessions on one login invite forced logouts.
- **Give the write-back a beat.** Wait ~10 seconds after a stop before launching the next
  browser on that profile.
- **Use the default browser context.** A fresh incognito context (`new_context()`) does
  not inherit the profile's cookies.

`GET /profiles/$BROWSER_USE_PROFILE` returns `cookieDomains` — the quickest check of which
sites the profile holds state for.

## Create the browser

In a DM, with the person's profile. First make sure no browser is still running on the
person's profile — state is written only when a browser stops, so one left running holds
it. The v4 list doesn't say which profile a session is on, so every browser this doc
creates is tagged with its profile id in `metadata`, and the check stops only what it can
attribute: a browser on the person's own key (you named the key's handle from their
keychain, so every active browser on it is theirs — set `SCOPE=mine`) is always theirs,
while on a shared key a browser you can't attribute is someone else's task — leave it
and say so. Stopping a holder is also what saves it, so nothing is lost:

```bash
SCOPE=profile   # "mine" only when $BROWSER_USE_API_KEY is the person's own key
ACTIVE=$(curl -fsS "https://api.browser-use.com/api/v4/browsers?filterBy=active" \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" \
  | SCOPE="$SCOPE" python3 -c "import sys,json,os;p=os.environ['BROWSER_USE_PROFILE'];m=os.environ.get('SCOPE')=='mine';print(' '.join(b['id'] for b in json.load(sys.stdin)['items'] if b.get('status')=='active' and (m or (b.get('metadata') or {}).get('profileId')==p)))")
if [ -n "$ACTIVE" ]; then
  for B in $ACTIVE; do
    curl -fsS -X PATCH "https://api.browser-use.com/api/v4/browsers/$B" \
      -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" -H 'content-type: application/json' \
      -d '{"action":"stop"}' > /dev/null
  done
  sleep 10
fi
```

Then create (the `metadata` tag is what the check above matches):

```bash
CREATE=$(curl -fsS -X POST https://api.browser-use.com/api/v4/browsers \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" -H 'content-type: application/json' \
  -d "{\"profileId\":\"$BROWSER_USE_PROFILE\",\"timeout\":30,\"metadata\":{\"profileId\":\"$BROWSER_USE_PROFILE\"}}")
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
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, m => (m.error ? reject(new Error(m.error.message)) : resolve(m))); ws.send(JSON.stringify({ id: i, ...(sessionId ? { sessionId } : {}), method, params })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
ws.onclose = () => { for (const r of pending.values()) r({ error: { message: "cdp socket closed" } }); pending.clear(); };
await new Promise(r => ws.onopen = r);
const { targetInfos } = (await send("Target.getTargets")).result;
const page = targetInfos.find(t => t.type === "page");
if (!page) throw new Error("no page target on the browser");
const { sessionId } = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).result;
const b64 = fs.readFileSync(filePath).toString("base64");
const name = filePath.split("/").pop();
const expression = `(()=>{const s=atob(${JSON.stringify(b64)});const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);
const dt=new DataTransfer();dt.items.add(new File([u],${JSON.stringify(name)}));const el=document.querySelector(${JSON.stringify(selector)});
if(!el)throw new Error("no element matches the selector");el.files=dt.files;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return el.files[0].size})()`;
const { result } = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
if (result.exceptionDetails) throw new Error(`page rejected the injection: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
console.log(JSON.stringify(result.result));
ws.close();
JS
node /tmp/bu-attach.mjs "$CDP_URL" /tmp/receipt.jpg "$SELECTOR"
```

The script exits non-zero when a protocol call fails or the page throws (a selector that
matches nothing, a blocked page) — treat that as the attach having failed: read the error
and fix it, don't re-run the task assuming the file is attached. Then run the task telling
the agent the file is already attached. Keep files small (this inlines the bytes); a site
that reads the file only through a native picker dialog won't see it.

## Routing a sign-in wall

The person signs in THEMSELVES through the live view; the profile keeps them signed in
afterwards. Reuse the task browser — it already holds the profile — and steer it to the wall with SKILL.md's shared `browse-nav.py`:

```bash
CDP_URL="$CDP_URL" /opt/browser-engine/venv/bin/python /tmp/browse-nav.py
printf '%s\n' "$LIVE_VIEW"
```

Hand them `$LIVE_VIEW`: they sign in, finish any 2FA, and say done. Confirm the page now
shows them signed in, then STOP the browser (that is what writes the profile), wait
~10 seconds, create a fresh browser on the same profile, and re-run the task. The profile
replays cookies; it cannot answer a challenge, so a site that re-verifies on every visit
needs the person again next time.

A mid-session verification check needs no stop — SKILL.md's live-view rule covers it.

## Clean up

Always stop the browser. The runner leaves it running, so it otherwise bills until its
timeout, and the stop is what saves the profile:

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
