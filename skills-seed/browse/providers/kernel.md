# Browse provider: Kernel (onkernel.com)

Provider names for the shared flow in SKILL.md: API key `KERNEL_API_KEY`, keychain service
`kernel`. Run this before the shared profile snippets:

```bash
export PROFILE_ENV=KERNEL_PROFILE PROFILE_SERVICE=kernel-profile
```

## Profiles

Kernel profiles must be pre-created at the API — a browser create naming a profile that
doesn't exist 400s (that's the usual cause of a 400 here, not a Kernel outage). During
first-time setup, and whenever the create below 400s, create the profile under the EXISTING
name from the keychain — never a fresh random one, which would orphan the credential:

```bash
curl -fsS -X POST https://api.onkernel.com/profiles \
  -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
  -d "{\"name\":\"$KERNEL_PROFILE\"}" > /dev/null
```

## Create the browser

In a DM, with the person's profile:

```bash
CREATE=$(curl -fsS -X POST https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
  -d "{\"stealth\":true,\"headless\":false,\"timeout_seconds\":1800,\"profile\":{\"name\":\"$KERNEL_PROFILE\"}}")
CDP_URL=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('cdp_ws_url',''))")
KERNEL_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))")
LIVE_VIEW=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('browser_live_view_url',''))")
```

In a channel or group, OMIT the profile field entirely (per the DM-only rule) — never send
an empty or personal profile name there:

```bash
CREATE=$(curl -fsS -X POST https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
  -d '{"stealth":true,"headless":false,"timeout_seconds":1800}')
```

then extract `CDP_URL` / `KERNEL_SID` / `LIVE_VIEW` from `$CREATE` exactly as above.

The profile is the person's own browsing state — their sign-ins persist in it across runs,
so every browser you launch this way starts already signed in to whatever they've connected.
It loads read-only: state gets INTO it via the Managed Auth hosted flow (below), never from
your browsing. (Kernel also supports `profile.save_changes: true` to write a session's
cookies back on browser DELETE — don't use it; concurrent runs would race their writes.)

## Giving the browser a file

Files land in `/home/kernel`:

```bash
curl -fsS -X POST "https://api.onkernel.com/browsers/$KERNEL_SID/fs/upload" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -F "files[]=@/tmp/receipt.jpg;filename=receipt.jpg" -F "dest_dir=/home/kernel"
```

Then run the task with `BROWSE_FILES="/home/kernel/receipt.jpg"` per SKILL.md.

## Routing a sign-in wall

The FULL Managed Auth flow is available against the person's profile — prefer it (the
session persists for all their future runs; a live-view login lives only as long as this
browser).

**Pre-store the person's login at Kernel whenever they'll let you** — this is the reliable
path, per Kernel's own guidance. Without a linked credential the hosted page discovers the
login form live and on some sites stalls at "Discovering login requirements…" until the
link times out (seen on doordash.com); with one, Kernel skips discovery, auto-fills, and
can re-auth automatically when the session lapses (only an OTP still needs the person).

1. **Get the login into their keychain** (skip to step 3's plain hosted link only if they
   decline). Check `GET /v1/keychain/credentials` first — a credential whose service/name
   matches the walled domain may already exist (use it via a grant; NEVER bind a login
   registered for a different site). Otherwise mint a one-time secret-drop so the password
   never transits chat, and ask which way they sign in — a Google-SSO site needs the
   Google login, not a site password:
   ```bash
   curl -fsS -X POST "$AGENT_API_URL/v1/keychain/drops" -H "x-agent-capability: $AGENT_API_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"service":"<domain>","fields":[{"key":"EMAIL","secret":false},{"key":"PASSWORD"}],"purpose":"sign in to <domain> in the managed browser"}'
   ```
   Hand over the returned `url` with the consent stated plainly: _filling it stores this
   login with Kernel (our managed-browser provider) so it can sign in and re-sign-in for
   you_ — that storage is the point, and it needs their explicit OK. Redemption fires a
   wake back into this conversation, and since sign-ins are DM-only the person's own
   credential injects straight into your env on that next turn (`EMAIL`/`PASSWORD` set —
   no grant dance needed).
2. **Store the credential at Kernel, then create the connection WITH it linked.** Linking
   only works at connection create — if an unlinked connection for the domain already
   exists (the create 409s with `existing_id`), DELETE it first and re-create. Names must
   be fresh per store (Kernel 409s on reuse — never a silent overwrite). Build bodies with
   Python from env; the secret never rides shell source, and the temp file is removed:
   ```bash
   export CRED_NAME="<domain>-$(python3 -c 'import secrets;print(secrets.token_hex(4))')"
   python3 -c 'import json,os,sys
   domain, name, sso = sys.argv[1], sys.argv[2], os.environ.get("SSO_PROVIDER","")
   body={"name":name,"domain":("accounts.google.com" if sso=="google" else domain),
         **({"sso_provider":sso} if sso else {}),
         "values":{"email":os.environ["EMAIL"],"password":os.environ["PASSWORD"]}}
   print(json.dumps(body))' "<the walled domain>" "$CRED_NAME" > /tmp/cred-body.json
   curl -fsS -X POST https://api.onkernel.com/credentials \
     -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
     --data-binary @/tmp/cred-body.json > /dev/null && rm -f /tmp/cred-body.json
   ```
   (`SSO_PROVIDER=google` when they sign in with Google — the credential's domain is then
   `accounts.google.com`, exactly as Kernel's docs prescribe.) Then the connection — read
   the wall URL from `/tmp/wall-url.txt` (extracted in SKILL.md; it never transits shell
   source) and let Python build the JSON. Pass the wall URL as `login_url` too (skips
   discovery even without a credential):
   ```bash
   python3 -c 'import json,os,sys,urllib.parse
   url=open("/tmp/wall-url.txt").read().strip()
   cred=os.environ.get("CRED_NAME","")
   print(json.dumps({"domain": urllib.parse.urlsplit(url).hostname or "", "profile_name": sys.argv[1],
                     "login_url": url, **({"credential":{"name":cred}} if cred else {})}))' \
     "$KERNEL_PROFILE" > /tmp/conn-body.json
   CONN=$(curl -sS -X POST https://api.onkernel.com/auth/connections \
     -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' --data-binary @/tmp/conn-body.json)


   CONN_ID=$(printf '%s' "$CONN" | python3 -c "import sys,json;j=json.load(sys.stdin);print(j.get('id') or j.get('existing_id',''))")
   ```
3. **Start the login flow** (`record_session: true` so a stuck flow is reviewable) and hand
   the person the hosted URL — single-use, expires in ~30 min, never open it yourself, and
   mint a fresh one if they lose it:
   ```bash
   curl -sS -X POST "https://api.onkernel.com/auth/connections/$CONN_ID/login" \
     -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
     -d '{"record_session":true}' \
     | python3 -c "import sys,json;print(json.load(sys.stdin).get('hosted_url',''))"
   ```
   With a linked credential the hosted page auto-fills and usually only surfaces the OTP
   step; without one the person types their login there. Expectation-setting: an SMS/email
   OTP step always needs the person — including again on re-auth after the session lapses —
   so 2FA-heavy sites are better, not hands-free. Avoid Kernel's programmatic login flow
   (poll `/auth/connections/:id` and submit fields): it can loop forever on sites that
   re-ask the same field (seen live on DoorDash's email step) — if you try it anyway, give
   up after ~3 resubmits of the same fieldset and fall back to the hosted link.
4. When they say they're done, confirm `status` is `AUTHENTICATED` via
   `GET /auth/connections/$CONN_ID`, then DELETE the old browser, create a fresh one
   (it launches with the now-signed-in profile), and re-run the task. If the flow instead
   gets stuck at "Discovering login requirements…", delete the connection, get a credential
   stored (step 1 — this is exactly the failure it prevents), and re-create linked.

The profile is theirs alone, so signing in real accounts is fine — that's the point.

## Clean up

```bash
curl -fsS -X DELETE "https://api.onkernel.com/browsers/$KERNEL_SID" -H "Authorization: Bearer $KERNEL_API_KEY"
```

## API reference

Read these instead of guessing when a call surprises you:

- Managed Auth: https://www.kernel.sh/docs/api-reference/managed-auth/create-auth-connection
  and https://www.kernel.sh/docs/api-reference/managed-auth/start-login-flow
- Credentials (pre-store for auto-fill): https://www.kernel.sh/docs/auth/credentials
- Programmatic login flows (SSO buttons, MFA options, flow states):
  https://www.kernel.sh/docs/auth/programmatic
- Browsers (create/delete, profiles, live view, fs upload): https://www.kernel.sh/docs/api-reference/browsers
