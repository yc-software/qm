# Browse provider: Kernel (onkernel.com)

Provider names for the shared flow in SKILL.md: API key `KERNEL_API_KEY`, keychain service
`kernel`. Run this before the shared profile snippets:

```bash
export PROFILE_ENV=KERNEL_PROFILE PROFILE_SERVICE=kernel-profile
```

In a DM, name three handles in `credentials`: the Kernel key (if it isn't org env), the
person's `KERNEL_PROFILE`, and their `KERNEL_PROXY_ID` (see "The person's static IP").

## Profiles

The person's profile is a Kernel browser profile whose name lives in their keychain
(`KERNEL_PROFILE`). It holds their sign-ins: a browser launched with it starts signed in,
and a browser launched with `save_changes: true` writes its cookies back when it is
DELETED or times out (closing CDP does not save). No Managed Auth: the person signs in
once on the live view and the profile keeps it.

Kernel profiles must be pre-created at the API — a browser create naming a profile that
doesn't exist 400s (that's the usual cause of a 400 here, not a Kernel outage). During
first-time setup, and whenever the create below 400s, create the profile under the EXISTING
name from the keychain — never a fresh random one, which would orphan the credential:

```bash
curl -fsS -X POST https://api.onkernel.com/profiles \
  -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
  -d "{\"name\":\"$KERNEL_PROFILE\"}" > /dev/null
```

## The person's static IP

Each person also gets their own Kernel ISP proxy: a static exit IP on a residential ISP,
the same on every session. Sites that remember devices (LinkedIn especially) see one
person on one connection instead of a new address every run, which is what keeps a
saved sign-in from tripping verification. Its id lives in their keychain as
`KERNEL_PROXY_ID` (service `kernel-proxy`); treat it like the profile name (it decides
whose address the browser wears), so it comes only from the keychain, in a DM.

If the manifest has no `KERNEL_PROXY_ID` handle, run the same existence check SKILL.md
gives for the profile (`envKey == "KERNEL_PROXY_ID"`). Only when none exists, create one
with the person's OK (it is a paid, per-person resource) and register it:

```bash
PX=$(curl -fsS -X POST https://api.onkernel.com/proxies \
  -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
  -d '{"type":"isp","name":"qm-<person>-isp","config":{"country":"US"}}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
[ -n "$PX" ] || { echo "proxy create returned no id; nothing registered" >&2; exit 1; }
curl -fsS -X POST "$AGENT_API_URL/v1/keychain/credentials" -H "x-agent-capability: $AGENT_API_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"service\":\"kernel-proxy\",\"envKey\":\"KERNEL_PROXY_ID\",\"secret\":\"$PX\"}" > /dev/null
```

ISP proxies exist in US, GB, FR, DE and SG; pick the person's country. Use the person's
own `KERNEL_API_KEY` for this when they have one (a shared brokered Kernel credential
may only allow `/browsers` and `/profiles`). The first session from the new IP may ask the
person to verify once on sites they were already signed in to elsewhere; after that it is
stable. If a create fails on the proxy (`proxy_id` not found), check it with
`POST /proxies/$KERNEL_PROXY_ID/check` and tell the person rather than silently launching
without it.

## Create the browser

In a DM, with the person's profile and proxy. Only ONE browser may write to a profile at a
time: Kernel allows concurrent browsers on a profile, and each save replaces the whole
profile, so a second writer silently clobbers the first. Check for a running browser on
the profile first, and launch read-only when one exists:

```bash
SAVE=$(curl -fsS https://api.onkernel.com/browsers -H "Authorization: Bearer $KERNEL_API_KEY" \
  | python3 -c "import sys,json,os;p=os.environ['KERNEL_PROFILE'];print('false' if any((b.get('profile') or {}).get('name')==p for b in json.load(sys.stdin)) else 'true')")
CREATE=$(curl -fsS -X POST https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
  -d "{\"stealth\":true,\"headless\":false,\"timeout_seconds\":1800,\"proxy_id\":\"$KERNEL_PROXY_ID\",\"profile\":{\"name\":\"$KERNEL_PROFILE\",\"save_changes\":$SAVE}}")
CDP_URL=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('cdp_ws_url',''))")
KERNEL_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))")
LIVE_VIEW=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('browser_live_view_url',''))")
```

`CDP_URL` is the websocket the runner drives directly. If `SAVE` came back `false`, say so
when you report: anything this run signs in to won't be kept. The check is not a lock —
two creates in the same moment can both see an empty list — so keep one browse run at a
time on a person's profile.

In a channel or group, OMIT the profile AND `proxy_id` entirely (per the DM-only rule) —
never send a personal profile name or proxy there:

```bash
CREATE=$(curl -fsS -X POST https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
  -d '{"stealth":true,"headless":false,"timeout_seconds":1800}')
```

then extract `CDP_URL` / `KERNEL_SID` / `LIVE_VIEW` from `$CREATE` exactly as above.

## Giving the browser a file

Files land in `/home/kernel`:

```bash
curl -fsS -X POST "https://api.onkernel.com/browsers/$KERNEL_SID/fs/upload" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -F "files[]=@/tmp/receipt.jpg;filename=receipt.jpg" -F "dest_dir=/home/kernel"
```

Then run the task with `BROWSE_FILES="/home/kernel/receipt.jpg"` per SKILL.md.

## Routing a sign-in wall

The person signs in once on the live browser; the profile keeps it.

1. Navigate the live browser to the wall URL (read from `/tmp/wall-url.txt`, never shell
   source) so the person lands on the login page, then hand them `$LIVE_VIEW` in the DM —
   bearer material, never open it yourself. SKILL.md's shared `browse-nav.py` (written in
   its wall step) does the steering:

   ```bash
   CDP_URL="$CDP_URL" /opt/browser-engine/venv/bin/python /tmp/browse-nav.py
   ```

2. They sign in, finish any 2FA, and say done. If the browser was launched with
   `SAVE=false` (another browser holds the profile), stop that one first and relaunch, or
   the sign-in is lost.
3. DELETE the browser (that is what writes the profile), wait ~10s, create a fresh one
   (it launches signed in) and re-run the task.

Expectation-setting: the profile keeps session cookies; it can't re-answer challenges. A
site that re-verifies on every visit (SMS/email OTP) will need the person again, and when
a site eventually expires the session, the next run hits the wall and you repeat this.
Don't use Kernel Managed Auth or stored Kernel credentials for this — the person's
password never leaves them.

## Clean up

```bash
curl -fsS -X DELETE "https://api.onkernel.com/browsers/$KERNEL_SID" -H "Authorization: Bearer $KERNEL_API_KEY"
```

## API reference

Read these instead of guessing when a call surprises you:

- Profiles (save_changes, concurrency): https://www.kernel.sh/docs/browsers/profiles
- ISP proxies (static exit IP): https://www.kernel.sh/docs/proxies/isp
- Browsers (create/delete, profiles, live view, fs upload): https://www.kernel.sh/docs/api-reference/browsers
