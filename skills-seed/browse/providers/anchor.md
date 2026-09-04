# Browse provider: Anchor (anchorbrowser.io)

Provider names for the shared flow in SKILL.md: API key `ANCHOR_API_KEY`, keychain service
`anchor`. Run this before the shared profile snippets:

```bash
export PROFILE_ENV=ANCHOR_PROFILE PROFILE_SERVICE=anchor-profile
```

All calls authenticate with the `anchor-api-key` header (not a Bearer token). Anchor embeds
the API key in `cdp_url`, so the CDP URL is itself a secret — it rides only as the runner's
argument.

## Profiles

No pre-creation step: the first session that names a profile registers it, and a task
session naming a not-yet-persisted profile starts blank rather than erroring (verified
live), so SKILL.md's bootstrap needs only the keychain registration. A profile only
CAPTURES browser state when a session is created with `persist: true` and then deleted — so
keep two session shapes apart:

- **Task sessions** load the profile by name WITHOUT `persist` — they start signed in to
  whatever the profile holds but never write back (concurrent runs would race their writes).
- **Sign-in sessions** (below) are the one place `persist: true` is used, and they must be
  DELETED — not left to time out — for the sign-in to land in the profile.

Profiles have no built-in re-auth: when a site expires the session, the person signs in
again (or use an identity, below). `GET /v1/profiles` lists them;
`DELETE /v1/profiles/<name>` removes one (only ever the name from the keychain, and only if
the person asks to reset their state).

## Create the browser

In a DM, with the person's profile:

```bash
CREATE=$(curl -fsS -X POST https://api.anchorbrowser.io/v1/sessions \
  -H "anchor-api-key: $ANCHOR_API_KEY" -H 'content-type: application/json' \
  -d "{\"session\":{\"timeout\":{\"max_duration\":30,\"idle_timeout\":10}},\"browser\":{\"profile\":{\"name\":\"$ANCHOR_PROFILE\"}}}")
CDP_URL=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('cdp_url',''))")
ANCHOR_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('id',''))")
LIVE_VIEW=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('live_view_url',''))")
```

In a channel or group, OMIT the profile entirely (per the DM-only rule):

```bash
CREATE=$(curl -fsS -X POST https://api.anchorbrowser.io/v1/sessions \
  -H "anchor-api-key: $ANCHOR_API_KEY" -H 'content-type: application/json' \
  -d '{"session":{"timeout":{"max_duration":30,"idle_timeout":10}}}')
```

then extract `CDP_URL` / `ANCHOR_SID` / `LIVE_VIEW` from `$CREATE` exactly as above.

Timeouts are minutes (`max_duration` caps the session, `idle_timeout` reaps an unused one).
For a site behind serious bot protection, add a proxy and Anchor's hardened build — both
are billed extras, so reach for them on a block, not by default:
`"session":{"proxy":{"type":"anchor_proxy","active":true},...}` plus
`"browser":{"extra_stealth":{"active":true},"captcha_solver":{"active":true}}`
(`extra_stealth` and `captcha_solver` both require the proxy).

## Giving the browser a file

Upload lands in `/uploads`:

```bash
curl -fsS -X POST "https://api.anchorbrowser.io/v1/sessions/$ANCHOR_SID/uploads" \
  -H "anchor-api-key: $ANCHOR_API_KEY" -F "file=@/tmp/receipt.jpg"
```

Then run the task with `BROWSE_FILES="/uploads/receipt.jpg"` per SKILL.md.

## Routing a sign-in wall

The durable path is a **sign-in session**: a fresh browser on the person's profile with
`persist: true`, opened at the wall, that THEY drive through the live view. Deleting it
writes the signed-in state into their profile, so every future task session starts signed
in. Delete the stopped task browser FIRST so two sessions never hold the profile at once:

```bash
curl -fsS -X DELETE "https://api.anchorbrowser.io/v1/sessions/$ANCHOR_SID" -H "anchor-api-key: $ANCHOR_API_KEY"
SIGNIN=$(python3 -c 'import json,sys
url=open("/tmp/wall-url.txt").read().strip()
print(json.dumps({"session":{"initial_url":url,"timeout":{"max_duration":30,"idle_timeout":15}},
                  "browser":{"profile":{"name":sys.argv[1],"persist":True}}}))' "$ANCHOR_PROFILE" \
  | curl -fsS -X POST https://api.anchorbrowser.io/v1/sessions \
      -H "anchor-api-key: $ANCHOR_API_KEY" -H 'content-type: application/json' --data-binary @-)
SIGNIN_SID=$(printf '%s' "$SIGNIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('id',''))")
printf '%s' "$SIGNIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('live_view_url',''))"
```

Hand the person the printed live-view URL — it's their browser for the next few minutes:
they sign in, complete any 2FA, and say done. Then DELETE the sign-in session (this is what
persists the profile), create a fresh task browser (it launches signed in), and re-run the
task:

```bash
curl -fsS -X DELETE "https://api.anchorbrowser.io/v1/sessions/$SIGNIN_SID" -H "anchor-api-key: $ANCHOR_API_KEY"
```

**Hands-free re-auth (optional, with the person's explicit OK).** Profiles alone go stale
when the site expires the session. If the person wants re-auth without being pinged each
time, Anchor's Identities store their login and re-run the auth flow automatically before
each session. Check `GET /v1/keychain/credentials` for an existing login for the domain
first (use it via a grant; NEVER bind a login registered for a different site); otherwise
mint a one-time secret-drop so the password never transits chat:

```bash
curl -fsS -X POST "$AGENT_API_URL/v1/keychain/drops" -H "x-agent-capability: $AGENT_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"service":"<domain>","fields":[{"key":"EMAIL","secret":false},{"key":"PASSWORD"}],"purpose":"sign in to <domain> in the managed browser"}'
```

Hand over the returned `url` with the consent stated plainly: _filling it stores this login
with Anchor (our managed-browser provider) so it can sign in and re-sign-in for you_ — that
storage is the point, and it needs their explicit OK. Redemption fires a wake back into
this conversation with `EMAIL`/`PASSWORD` in your env (sign-ins are DM-only, so no grant
dance). Then create the identity with Python building the body from env
(`POST /v1/identities` with `{"source":"https://<domain>","name":...,"credentials":
[{"type":"username_password","username":...,"password":...}]}`), and register the returned
identity id in their keychain (service `anchor-identity`, envKey
`ANCHOR_IDENTITY_<DOMAIN_SLUG>`) with a standing grant, like the profile bootstrap. Task
sessions then attach it alongside the profile: `"identities":[{"id":"<identity-id>"}]` in
the create body. An identity whose `status` is `failed` / `agent_failed` needs the person
again — mint a re-auth link with `POST /v1/identities/<id>/re-authenticate-token` and hand
it over like any sign-in link. Read
https://docs.anchorbrowser.io/essentials/authenticated-applications before your first
identity — the auth-flow fields (OTP, TOTP, SSO) live there, and guessing them stores a
broken login.

## Clean up

```bash
curl -fsS -X DELETE "https://api.anchorbrowser.io/v1/sessions/$ANCHOR_SID" -H "anchor-api-key: $ANCHOR_API_KEY"
```

## API reference

Read these instead of guessing when a call surprises you:

- Sessions (create/delete, profiles, proxy/stealth, live view, uploads):
  https://docs.anchorbrowser.io/api-reference/browser-sessions/start-browser-session
- Profiles vs identities (which auth model when):
  https://docs.anchorbrowser.io/essentials/managed-authentication
- Identities and applications (stored logins, auto re-auth, re-auth links):
  https://docs.anchorbrowser.io/essentials/authenticated-applications
- Full doc index: https://docs.anchorbrowser.io/llms.txt
