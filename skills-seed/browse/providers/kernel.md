# Browse provider: Kernel (onkernel.com)

Provider names for the shared flow in SKILL.md: API key `KERNEL_API_KEY`, keychain service
`kernel`. Run this before the shared profile snippets:

```bash
export PROFILE_ENV=KERNEL_PROFILE PROFILE_SERVICE=kernel-profile
```

In a DM, name three handles in `credentials`: the Kernel key (see "Which key" below), the
person's `KERNEL_PROFILE`, and their `KERNEL_PROXY_ID` (see "The person's static IP").

## Which key

Use the first of these that exists:

1. **The person's own key**: a `KERNEL_API_KEY` handle of theirs in your keychain
   manifest. Name it in `credentials`.
2. **An org key delivered as env**: `KERNEL_API_KEY` already set in your shell.
3. **The org's shared Kernel credential**: a `service_kernel` row in the Credentials
   inventory (proxy, host `api.onkernel.com`). Name `service_kernel` in `credentials`.
   You never see this key. QM adds it to each request you send through its credential
   broker (see the use-shared-credential skill), so `KERNEL_API_KEY` stays unset.

Make every Kernel API call in this doc through `kapi`, which picks the right route.
Define it once per shell:

```bash
kapi() { # kapi METHOD PATH [JSON-BODY] -> response body on stdout; non-zero exit on error
  if [ -n "${KERNEL_API_KEY:-}" ]; then
    if [ -n "${3:-}" ]; then
      curl -fsS -X "$1" "https://api.onkernel.com$2" -H "Authorization: Bearer $KERNEL_API_KEY" \
        -H 'content-type: application/json' -d "$3"
    else
      curl -fsS -X "$1" "https://api.onkernel.com$2" -H "Authorization: Bearer $KERNEL_API_KEY"
    fi
  else
    python3 - "$1" "$2" "${3:-}" <<'PY'
import json, os, sys, urllib.error, urllib.request
method, path, body = sys.argv[1:4]
req = {"credential": "kernel", "method": method, "url": "https://api.onkernel.com" + path}
if body:
    req["headers"] = {"content-type": "application/json"}
    req["body"] = body
r = urllib.request.Request(os.environ["AGENT_API_URL"] + "/v1/credentials/broker",
    data=json.dumps(req).encode(), method="POST",
    headers={"x-agent-capability": os.environ["AGENT_CREDENTIAL_TOKEN"], "content-type": "application/json"})
try:
    env = json.load(urllib.request.urlopen(r))
except urllib.error.HTTPError as e:  # broker refusal, e.g. method_not_allowed
    sys.stderr.write(e.read().decode()[:300] + "\n"); sys.exit(1)
sys.stdout.write(env.get("body") or "")
sys.exit(0 if 200 <= env.get("status", 0) < 300 else 1)
PY
  fi
}
```

The shared credential only creates and deletes (see "Org setup"), so with it you can't
list or read anything back, and can't upload files (the broker carries JSON, not
multipart). The flow below needs neither.

## Org setup (admins: required before rollout)

This doc's isolation depends on two settings that the skill can't enforce itself:

1. **Shared credential: its own project, create and delete only.** Give QM's shared key
   a dedicated Kernel project and a key restricted to it (`browsers`, `profiles` and
   `proxies`, each with `use`, `create`, `write` and `delete` on `projects/<id>/*`, and no
   `read`). Kernel requires project-wide `browsers:use` to create a browser at all, and
   that also lets the key list and attach to every running browser in its project, so
   never put the shared key in a project that people's own keys or other tools use. Then
   configure the broker entry for `api.onkernel.com` with methods `POST` and `DELETE` only,
   on paths `/browsers`, `/profiles` and `/proxies`. Do NOT allow `GET`: the paths match
   by prefix, so any `GET` lets callers list every person's profiles and running browsers,
   and their names are all anyone needs to open someone else's signed-in browser.
   Nothing in this flow needs `GET`; the live view and CDP URL come back from the create.
2. **Personal keys scoped to the person.** A person's own `KERNEL_API_KEY` must not be an
   account-wide key; it would bypass rule 1. Give them their own Kernel project and a key
   restricted to it, for the same reason as above: within one project, any key that can
   create browsers can see every running browser.

If you're an agent and the `service_kernel` row in your inventory allows `GET`, tell the person
(and an org admin) that profiles aren't isolated yet. Don't work around it.

## Profiles

The person's profile is a Kernel browser profile whose name lives in their keychain
(`KERNEL_PROFILE`). It holds their sign-ins: a browser launched with it starts signed in,
and a browser launched with `save_changes: true` writes its cookies back when it is
DELETED or times out (closing CDP does not save). No Managed Auth: the person signs in
once on the live view and the profile keeps it.

Profile names are secrets, not labels. One Kernel account holds every person's profiles
and records no owner, so whoever knows a name can launch a browser signed in as that
person. The org's shared Kernel credential must therefore allow only creating and
deleting (see "Org setup" below); don't list profiles or browsers with any key,
and don't try to find a person's profile by name or recency. Their profile is the one in
their keychain, full stop. If it is missing, run first-time setup; don't go looking.

Kernel profiles must be pre-created at the API — a browser create naming a profile that
doesn't exist 400s (that's the usual cause of a 400 here, not a Kernel outage). During
first-time setup, and whenever the create below 400s, create the profile under the EXISTING
name from the keychain — never a fresh random one, which would orphan the credential:

```bash
kapi POST /profiles "{\"name\":\"$KERNEL_PROFILE\"}" > /dev/null
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
PX=$(kapi POST /proxies '{"type":"isp","name":"qm-<person>-isp","config":{"country":"US"}}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
[ -n "$PX" ] || { echo "proxy create returned no id; nothing registered" >&2; exit 1; }
curl -fsS -X POST "$AGENT_API_URL/v1/keychain/credentials" -H "x-agent-capability: $AGENT_API_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"service\":\"kernel-proxy\",\"envKey\":\"KERNEL_PROXY_ID\",\"secret\":\"$PX\"}" > /dev/null
```

ISP proxies exist in US, GB, FR, DE and SG; pick the person's country. If the shared
credential refuses `/proxies` (path_not_allowed), the org hasn't enabled it; launch
without a proxy and tell the person. The first session from the new IP may ask the
person to verify once on sites they were already signed in to elsewhere; after that it is
stable. If a create fails on the proxy (`proxy_id` not found), check it with
`kapi POST /proxies/$KERNEL_PROXY_ID/check` (own or env key only; the shared credential
has no read access, so the check is refused) and tell the person rather than silently
launching without it.

## Create the browser

In a DM, with the person's profile and proxy. Only ONE browser may write to a profile at a
time: Kernel allows concurrent browsers on a profile, and each save replaces the whole
profile, so a second writer silently clobbers the first. Since browsers can't be listed,
record your own writer in the person's keychain (`KERNEL_ACTIVE`, service
`kernel-active`, value `<session_id>:<epoch>`) and launch read-only while a record younger
than the browser timeout exists. Name its handle in `credentials` when it exists (absent =
no writer):

```bash
SAVE=true
case "${KERNEL_ACTIVE:-}" in *:*) [ $(( $(date +%s) - ${KERNEL_ACTIVE#*:} )) -lt 1800 ] && SAVE=false;; esac
CREATE=$(kapi POST /browsers "{\"stealth\":true,\"headless\":false,\"timeout_seconds\":1800,\"proxy_id\":\"$KERNEL_PROXY_ID\",\"profile\":{\"name\":\"$KERNEL_PROFILE\",\"save_changes\":$SAVE}}")
CDP_URL=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('cdp_ws_url',''))")
KERNEL_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))")
LIVE_VIEW=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('browser_live_view_url',''))")
```

When `SAVE=true`, claim the profile right away:

```bash
[ "$SAVE" = true ] && curl -fsS -X POST "$AGENT_API_URL/v1/keychain/credentials" \
  -H "x-agent-capability: $AGENT_API_TOKEN" -H 'content-type: application/json' \
  -d "{\"service\":\"kernel-active\",\"envKey\":\"KERNEL_ACTIVE\",\"secret\":\"$KERNEL_SID:$(date +%s)\"}" > /dev/null
```

`CDP_URL` is the websocket the runner drives directly. If `SAVE` came back `false`, say so
when you report: anything this run signs in to won't be kept. The record is not a lock —
two runs starting in the same moment can both see none — so keep one browse run at a
time on a person's profile.

In a channel or group, OMIT the profile AND `proxy_id` entirely (per the DM-only rule) —
never send a personal profile name or proxy there:

```bash
CREATE=$(kapi POST /browsers '{"stealth":true,"headless":false,"timeout_seconds":1800}')
```

then extract `CDP_URL` / `KERNEL_SID` / `LIVE_VIEW` from `$CREATE` exactly as above.

## Giving the browser a file

Files land in `/home/kernel`. This needs a real key (own or env); the shared credential
can't carry a file upload, so say so rather than improvising:

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
kapi DELETE "/browsers/$KERNEL_SID"
# release the profile if this run held it
[ "$SAVE" = true ] && curl -fsS -X POST "$AGENT_API_URL/v1/keychain/credentials" \
  -H "x-agent-capability: $AGENT_API_TOKEN" -H 'content-type: application/json' \
  -d '{"service":"kernel-active","envKey":"KERNEL_ACTIVE","secret":"none:0"}' > /dev/null
```

## API reference

Read these instead of guessing when a call surprises you:

- Profiles (save_changes, concurrency): https://www.kernel.sh/docs/browsers/profiles
- ISP proxies (static exit IP): https://www.kernel.sh/docs/proxies/isp
- Browsers (create/delete, profiles, live view, fs upload): https://www.kernel.sh/docs/api-reference/browsers
