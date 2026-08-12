import type { CapabilityClaims } from "../auth/capability-token.ts";

interface AgentApiRoute {
  method: string;
  path: string;
  summary: string;
}

interface AgentApiView {
  claims: CapabilityClaims;
  isAdmin: boolean;
}

interface AgentApiFamily {
  match: (method: string, pathname: string) => boolean;
  when?: (view: AgentApiView) => boolean;
  guidance?: string;
  routes: AgentApiRoute[];
}

const onPath = (m: string, p: string) => (method: string, pathname: string) => method === m && pathname === p;

const FAMILIES: AgentApiFamily[] = [
  {
    match: onPath("GET", "/v1/apis"),
    routes: [
      {
        method: "GET",
        path: "/v1/apis",
        summary: "this list — every endpoint your token can call right now, plus whether the user is an org admin",
      },
    ],
  },
  {
    match: (m, p) => p === "/v1/runtime-config" && (m === "GET" || m === "PUT"),
    guidance:
      "Runtime choice is scoped: changing it affects this personal or shared context, not the whole org. Confirm before changing a shared scope. An inherit reset follows future org defaults automatically.",
    routes: [
      {
        method: "GET",
        path: "/v1/runtime-config",
        summary:
          "read this scope's effective harness/model, approved choices, override, and whether the org recommends an upgrade",
      },
      {
        method: "PUT",
        path: "/v1/runtime-config",
        summary:
          "set this scope's default with {harnessId,modelId}, follow the org with {inherit:true}, or keep the current override while acknowledging the recommendation with {keep:true}",
      },
    ],
  },
  {
    match: (m, p) => p === "/v1/channel-header-pin" && (m === "GET" || m === "PUT"),
    guidance:
      "The pinned Slack header (a small pinned message naming the model in use) follows an org-wide default (off unless an admin turned it on). Only override it for a channel scope when someone in that channel asks.",
    routes: [
      {
        method: "GET",
        path: "/v1/channel-header-pin",
        summary: "read whether this channel scope shows the pinned model header in Slack",
      },
      {
        method: "PUT",
        path: "/v1/channel-header-pin",
        summary:
          "override the pinned Slack header for this channel scope with {on: boolean}; {on: null} reverts to the org default",
      },
    ],
  },
  {
    match: (m, p) =>
      (p === "/v1/projects" && (m === "GET" || m === "POST")) ||
      (/^\/v1\/projects\/[^/]+$/.test(p) && m === "PATCH") ||
      (/^\/v1\/projects\/[^/]+\/members$/.test(p) && m === "POST") ||
      (/^\/v1\/projects\/[^/]+\/members\/[^/]+$/.test(p) && m === "DELETE") ||
      (/^\/v1\/projects\/[^/]+\/slack-channel$/.test(p) && (m === "PUT" || m === "DELETE")),
    guidance:
      "These act as the ASKING PERSON across every project they belong to, matching the web UI. Do not send principalId; the capability token always determines the person, and inaccessible projects return 404.",
    routes: [
      { method: "GET", path: "/v1/projects", summary: "list every project the asking person belongs to" },
      {
        method: "POST",
        path: "/v1/projects",
        summary: "create a project owned by the asking person — body {name}",
      },
      {
        method: "PATCH",
        path: "/v1/projects/:id",
        summary: "rename a project the asking person owns — body {name}",
      },
      {
        method: "POST",
        path: "/v1/projects/:id/members",
        summary: "add an internal directory member to a project the asking person belongs to — body {memberId}",
      },
      {
        method: "DELETE",
        path: "/v1/projects/:id/members/:memberId",
        summary: "remove a member from a project the asking person owns",
      },
      {
        method: "PUT",
        path: "/v1/projects/:id/slack-channel",
        summary:
          "link a project to its Slack home channel — body {channel} (name or id; the asking person must be in the project and able to see the channel — public, or a private one they belong to; a channel that already has its own agent workspace is rejected with 409). Everyone in the channel joins the project, and the roster follows the channel from then on; the channel becomes the project's default delivery audience for crons and report-outs.",
      },
      {
        method: "DELETE",
        path: "/v1/projects/:id/slack-channel",
        summary: "unlink a project's Slack home channel — members who joined via the channel leave the project",
      },
    ],
  },
  {
    match: (m, p) =>
      (p === "/v1/crons" && (m === "POST" || m === "GET")) ||
      (m === "POST" &&
        p.startsWith("/v1/crons/") &&
        (p.endsWith("/disable") || p.endsWith("/destination") || p.endsWith("/run"))) ||
      (m === "GET" && p.startsWith("/v1/crons/") && p.endsWith("/runs")) ||
      (p.startsWith("/v1/crons/") &&
        !p.slice("/v1/crons/".length).includes("/") &&
        (m === "GET" || m === "PATCH" || m === "DELETE")),
    when: () => false,
    routes: [
      {
        method: "POST",
        path: "/v1/crons",
        summary:
          'schedule future or recurring work — a 2-5 word `title` naming what the cron is for (distinctive in a list, not the command) plus `task` (re-run at fire time) or exact `text`, optionally addressed by name to a teammate (`recipient`), a channel (`channel`), or a group DM (`participants`: its other members, which must already exist as a group DM — reach it once first, which opens it; same venue rule as /v1/reach — narrowest audience, a channel only when explicitly requested or genuinely room-wide), or run privately for whoever asked at their own scope (`scope:"personal"`, even from a channel); pass `unfurlLinks:false` to suppress Slack previews (to send now instead, use /v1/reach)',
      },
      { method: "GET", path: "/v1/crons", summary: "list your crons" },
      {
        method: "GET|PATCH|DELETE",
        path: "/v1/crons/:id",
        summary: "inspect, rename, archive, edit, or delete a cron",
      },
      {
        method: "GET",
        path: "/v1/crons/:id/runs",
        summary: "read the retained fire log for a cron; use only when older run history is relevant",
      },
      { method: "POST", path: "/v1/crons/:id/disable", summary: "disable a cron" },
      { method: "POST", path: "/v1/crons/:id/destination", summary: "retarget where a cron delivers" },
      { method: "POST", path: "/v1/crons/:id/run", summary: "fire a cron now" },
    ],
  },
  {
    match: (m, p) => m === "POST" && /^\/v1\/triggers\/[^/]+\/consent$/.test(p),
    guidance:
      "If the person you're helping is told a teammate set up a recurring delivery (a cron that DMs them), THEY control whether it reaches them — not its behavior. When they say yes/no, call this with the ref id from the notice. Reversible anytime; only the recipient can decide.",
    routes: [
      {
        method: "POST",
        path: "/v1/triggers/:id/consent",
        summary:
          'accept or decline a standing trigger\'s deliveries to you (a teammate\'s cron that DMs you) — body {decision:"accept"|"decline"}; reversible; recipient-only',
      },
    ],
  },
  {
    match: onPath("POST", "/v1/share"),
    when: () => false,
    routes: [
      {
        method: "POST",
        path: "/v1/share",
        summary:
          'share or move one of YOUR artifacts to another context — body {type:"file"|"skill"|"deploy"|"cron", id, toScope:"org"|<scope id>|a teammate\'s name, permission?:"read"(default)|"write", move?:false}. Default (share) adds a grant — the artifact keeps its home and creator. move:true changes its home scope instead (skills only today). Frictionless into any context you belong to; allowed for anyone who manages the artifact\'s home (its owner, or a current member of its private-channel/group home), from any conversation; ceding a skill to the org is admin-gated (a live org admin only).',
      },
    ],
  },
  {
    match: (m, p) =>
      (m === "GET" && (p === "/v1/conversations" || /^\/v1\/conversations\/[^/]+$/.test(p))) ||
      (m === "POST" && (p === "/v1/conversations" || /^\/v1\/conversations\/[^/]+(?:\/fork)?$/.test(p))),
    guidance:
      "These act on the ASKING PERSON's own conversation list (the web UI sidebar) — archiving, pinning, or renaming is a per-person view change, never a deletion, and never touches anyone else's list. Confirm before bulk-archiving.",
    routes: [
      {
        method: "GET",
        path: "/v1/conversations",
        summary:
          "list the asking person's own conversations (id, title, archived, pinned, lastActivityAt) — the same list their web sidebar shows",
      },
      {
        method: "POST",
        path: "/v1/conversations/:id",
        summary:
          "update one of the asking person's conversations — body {archived?, pinned?, title?, color?}; archive/unarchive, pin/unpin, rename (null title clears), or set the sidebar color (#rrggbb; null clears). Per-person and reversible; 404 for a conversation not on their list",
      },
      {
        method: "GET",
        path: "/v1/conversations/:id?tailTurns=20",
        summary:
          "read the bounded transcript of one of the asking person's conversations; defaults to the last 20 turns and supports older paging with tailTurns and beforeSeq; returns 404 for a conversation they cannot see",
      },
      {
        method: "POST",
        path: "/v1/conversations",
        summary:
          "start a FRESH conversation in this scope (no inherited transcript) — body {text, title?}; text becomes its first message and a run begins there asynchronously. Unlike /fork, the new session starts with only what you put in text. Human-attended turns only — refused (403) from crons and other automations",
      },
      {
        method: "POST",
        path: "/v1/conversations/:id/fork",
        summary:
          "fork one of the asking person's conversations into a new conversation — body optionally {upToSeq}; returns 404 for a conversation they cannot see",
      },
    ],
  },
  {
    match: (m, p) => m === "GET" && (p === "/v1/files" || /^\/v1\/files\/[^/]+\/content$/.test(p)),
    guidance:
      "These show the ASKING PERSON's file library across every context they can reach. A file outside their visibility returns 404 without revealing whether it exists.",
    routes: [
      {
        method: "GET",
        path: "/v1/files",
        summary:
          "list files the asking person can reach across their contexts, split into owned and shared files; use limit and cursor query parameters to page owned files",
      },
      {
        method: "GET",
        path: "/v1/files/:id/content",
        summary: "download the bytes of a file from the asking person's file library",
      },
    ],
  },
  {
    match: onPath("POST", "/v1/reach"),
    routes: [
      {
        method: "POST",
        path: "/v1/reach",
        summary:
          "send a teammate a DM, post to a channel, or post to a group DM RIGHT NOW — `text` plus `recipient`, `channel`, or `participants` (the group DM's other members — the group is opened for you if it doesn't exist yet, so never ask someone to create one), optionally with `files` (workspace-relative paths, attached to the message all-or-nothing). EXTREMELY IMPORTANT: a `channel` post broadcasts to everyone there — pick the narrowest audience that can act; a question or errand for one person goes to their DM (`recipient`), NEVER a public channel, unless the person you're helping explicitly named that channel as the destination or the message genuinely concerns the whole room; pass `threadTs` (the parent message's ts) with a `channel`/`participants` post to reply inside that thread instead of top-level; or react to a message instead of posting with `react:{ts,emoji}` plus a `channel`/`participants`; or retract one of your own messages with `delete:{ts}` (no target = this conversation, or name a `channel`/`participants` to delete elsewhere) — find a message's `ts` via /v1/surface-context; pass `unfurlLinks:false` to suppress Slack previews (no schedule; for later/recurring use /v1/crons)",
      },
    ],
  },
  {
    match: (m, p) =>
      (m === "GET" && p === "/v1/deployments") ||
      (m === "GET" && /^\/v1\/deployments\/[^/]+$/.test(p)) ||
      (m === "GET" && /^\/v1\/deployments\/[^/]+\/fetch$/.test(p)) ||
      (m === "GET" && /^\/v1\/deployments\/[^/]+\/git-url$/.test(p)) ||
      (m === "POST" && /^\/v1\/deployments\/[^/]+\/(share|archive|restore|name|display-name)$/.test(p)),
    guidance:
      'To see the published apps you can reach across scopes, GET /v1/deployments (each row carries your permission and a clone/push gitUrl). Read what an app renders as the asking person with GET /v1/deployments/:id/fetch. A published app (`publish`) is reachable only by its owner plus whoever the owner shares it with. To widen or narrow that — "share it with everyone" or "share it with <teammate>" — POST /v1/deployments/:id/share with `scope:"org"` or `recipient:"<name>"`; no redeploy. To rename or take down an app, use name / display-name / archive. Anyone who manages the app can change these: its owner from any conversation, a current member of the channel/team it was published from, or someone granted "manage" access.',
    routes: [
      {
        method: "GET",
        path: "/v1/deployments",
        summary:
          "list the published apps you can reach across scopes — each row carries your effective permission (read|write) and a ready-to-clone/push gitUrl; find deployment ids here for share / name / display-name / archive / git-url",
      },
      {
        method: "GET",
        path: "/v1/deployments/:id",
        summary:
          "inspect one deployment you can reach — status, owner/home scope, effective permission, current and applied versions, version history with commit ids and timestamps, and gitUrl",
      },
      {
        method: "GET",
        path: "/v1/deployments/:id/fetch",
        summary:
          "read a deployment's rendered content as the asking person — query path defaults to / and maxBytes defaults to 256KB; returns upstream status, contentType, body, and truncation metadata",
      },
      {
        method: "GET",
        path: "/v1/deployments/:id/git-url",
        summary:
          "get an authed git remote URL for a deployment you can reach (clone its source; push a new version if you have write access) — returns {url, permission}",
      },
      {
        method: "POST",
        path: "/v1/deployments/:id/share",
        summary:
          'change who can reach a published app you own (:id is its name or id). Target ONE of: `scope` — "org" (everyone in the org) or a scope id like personal:<id>; or `recipient` — a teammate\'s name (resolved in the directory). `access`: view (reach, default), manage (reach + redeploy/rollback), or none (stop sharing). Owner-only (from any conversation), no redeploy',
      },
      {
        method: "POST",
        path: "/v1/deployments/:id/name",
        summary: "rename an app you manage — body {name} (its URL slug; must be unique)",
      },
      {
        method: "POST",
        path: "/v1/deployments/:id/display-name",
        summary: "set an app's human-friendly display name — body {displayName} (empty clears it)",
      },
      {
        method: "POST",
        path: "/v1/deployments/:id/archive",
        summary: "take down an app you manage (stops it and frees its endpoint; the source is kept)",
      },
      {
        method: "POST",
        path: "/v1/deployments/:id/restore",
        summary: "restore an archived app you manage by reapplying its current saved version",
      },
    ],
  },
  {
    match: (m, p) => p === "/v1/soul" && (m === "POST" || m === "GET"),
    when: () => false,
    routes: [
      { method: "GET", path: "/v1/soul", summary: "read this scope's standing instructions (SOUL)" },
      { method: "POST", path: "/v1/soul", summary: "update this scope's standing instructions (versioned, audited)" },
    ],
  },
  {
    match: (m, p) =>
      (p === "/v1/memory/self" && (m === "GET" || m === "PUT")) ||
      (p === "/v1/memory/history" && m === "GET") ||
      (p === "/v1/memory/restore" && m === "POST") ||
      (m === "POST" && (p === "/v1/memory/search" || p === "/v1/memory/facts")),
    when: (v) => !!v.claims.memory,
    guidance: "Memory bodies and curation rules are documented in the memory skill.",
    routes: [
      { method: "POST", path: "/v1/memory/search", summary: "search every notebook this conversation may read" },
      { method: "POST", path: "/v1/memory/facts", summary: "append durable facts to this conversation's notebook now" },
      {
        method: "GET|PUT",
        path: "/v1/memory/self",
        summary: "read or rewrite (curate) this conversation's whole notebook; rewriting is destructive",
      },
      { method: "GET", path: "/v1/memory/history", summary: "list notebook versions available to undo a rewrite" },
      {
        method: "POST",
        path: "/v1/memory/restore",
        summary: "restore a prior notebook version using revision and expectedRevision; use scope: org for org memory",
      },
    ],
  },
  {
    match: () => false,
    when: (v) => !!v.claims.memory?.orgWrite,
    routes: [
      {
        method: "POST|PUT",
        path: "/v1/memory/facts | /v1/memory/self",
        summary:
          'add "scope":"org" (?scope=org on GET) to target the org-wide notebook every conversation recalls — admin only, confirm wording first',
      },
    ],
  },
  {
    match: (m, p) =>
      (p === "/v1/keychain/credentials" && (m === "POST" || m === "GET")) ||
      (p === "/v1/keychain/overview" && m === "GET") ||
      (m === "DELETE" && p.startsWith("/v1/keychain/credentials/")) ||
      (p === "/v1/keychain/grants" && (m === "POST" || m === "GET")) ||
      (m === "POST" && p.startsWith("/v1/keychain/grants/") && p.endsWith("/revoke")) ||
      (p === "/v1/keychain/asks" && (m === "POST" || m === "GET")) ||
      (m === "POST" && p.startsWith("/v1/keychain/asks/") && p.endsWith("/decline")) ||
      (m === "POST" && p === "/v1/keychain/drops") ||
      (m === "POST" && p === "/v1/keychain/use"),
    guidance: "The keychain ask→approve→use protocol is documented in your keychain manifest when one renders.",
    routes: [
      {
        method: "POST|GET",
        path: "/v1/keychain/credentials",
        summary:
          "register a login to the user's keychain (secret, files[], or a multi-input fields[] of [{envKey,value,secret?}]) / list participants' registered logins (metadata)",
      },
      {
        method: "GET",
        path: "/v1/keychain/overview",
        summary:
          "list this user's credential metadata, grants, pending asks, and recent audited use (never secret values)",
      },
      { method: "DELETE", path: "/v1/keychain/credentials/:id", summary: "remove a registered login" },
      {
        method: "POST|GET",
        path: "/v1/keychain/grants",
        summary: "request a purpose-bound grant to use someone's login here / list grants",
      },
      { method: "POST", path: "/v1/keychain/grants/:id/revoke", summary: "revoke a grant" },
      {
        method: "POST|GET",
        path: "/v1/keychain/asks",
        summary: "ask a credential's owner for access (purpose-bound; refused on trigger-fired turns) / list asks",
      },
      { method: "POST", path: "/v1/keychain/asks/:id/decline", summary: "decline an ask" },
      {
        method: "POST",
        path: "/v1/keychain/drops",
        summary:
          'mint a single-use, expiring link for someone to drop a credential into the keychain via a browser (no secret in chat; hand the returned url over VERBATIM — it carries a link-bound token, so a reconstructed url will not work; declare the form inputs with fields[], e.g. [{key:"X_EMAIL",label:"Email",secret:false},{key:"X_PASSWORD",label:"Password"}] for a login, or omit for a single token; refused on trigger-fired turns)',
      },
      {
        method: "POST",
        path: "/v1/keychain/use",
        summary:
          "materialize an approved grant ({grant}) — or, in the owner's personal conversation, their own credential ({credential}) — into env vars for this turn",
      },
    ],
  },
  {
    match: (m, p) => m === "POST" && (p === "/v1/surface-context" || p === "/v1/surface-file"),
    routes: [
      {
        method: "POST",
        path: "/v1/surface-context",
        summary:
          "fetch recent messages from a channel/DM YOU can see (count/before/match) — a private channel only if you're a member; directory-resolved, never a raw address",
      },
      {
        method: "POST",
        path: "/v1/surface-file",
        summary:
          "fetch a file someone posted in a channel/DM the asking person can see — body {ts, channel?, threadTs?, name?} (ts from /v1/surface-context; threadTs for a thread reply; name when the message carries several files) → file metadata plus a short-lived download: curl it with the returned header+token to save the bytes into your workspace, then use or deliver them (e.g. cp into $AGENT_OUTBOX)",
      },
    ],
  },
  {
    match: onPath("GET", "/v1/directory/resolve"),
    when: () => false,
    routes: [
      {
        method: "GET",
        path: "/v1/directory/resolve",
        summary:
          "resolve a teammate's name/handle to directory matches incl. their Slack mention id — ?q=<name> → {matches:[{principalId,displayName,type,slackId?}]}; write slackId as <@slackId> to @-mention them so Slack notifies them",
      },
    ],
  },
  {
    match: (m, p) =>
      (p === "/v1/environments" && (m === "POST" || m === "GET")) || (m === "POST" && p === "/v1/environments/attach"),
    routes: [
      {
        method: "GET",
        path: "/v1/environments",
        summary: "list the org's named environments (computers) and which scopes are attached",
      },
      {
        method: "POST",
        path: "/v1/environments",
        summary: "promote this conversation's computer to a NAMED environment owned by this user",
      },
      {
        method: "POST",
        path: "/v1/environments/attach",
        summary: "point this conversation at a named environment (owner attaches freely; others go through the owner)",
      },
    ],
  },
  {
    match: (m, p) =>
      (m === "POST" && p === "/v1/skills") ||
      (m === "GET" && p.startsWith("/v1/skills/")) ||
      ((m === "PUT" || m === "DELETE") && p.startsWith("/v1/skills/")) ||
      (m === "POST" && /^\/v1\/skills\/[^/]+\/restore$/.test(p)),
    guidance:
      "Save a skill when you've worked out a repeatable procedure worth keeping (a checklist, a multi-step flow, a house style) — it auto-loads (skills/<name>/SKILL.md) on every future turn. The skill homes in THIS conversation's scope: in a 1:1 DM it's yours alone; in a private channel or group DM it's owned by that room and every member can edit or delete it (the audit trail records who changed what); a public channel stays owner-only. Write the `body` as a plain-step recipe addressed to your future self; edit or delete it as it goes stale.",
    routes: [
      {
        method: "POST",
        path: "/v1/skills",
        summary:
          "save a NEW skill in this conversation's scope — {name, description, body} (the SKILL.md). Auto review+published; a name already taken in this scope is a 409 (edit it instead).",
      },
      {
        method: "GET",
        path: "/v1/skills/:id",
        summary: "read a skill you can see, including an archived skill's body, files, status, and version",
      },
      {
        method: "PUT",
        path: "/v1/skills/:id",
        summary:
          "edit a skill you manage — {description?, body?} (the name is fixed; create a new skill to rename). 404 if it isn't yours to edit",
      },
      {
        method: "DELETE",
        path: "/v1/skills/:id",
        summary: "archive a skill you manage. 404 if missing, 403 if it isn't yours to archive",
      },
      {
        method: "POST",
        path: "/v1/skills/:id/restore",
        summary: "restore an archived skill you manage by re-reviewing and publishing its preserved version",
      },
    ],
  },
  {
    match: (m, p) => m === "POST" && p === "/v1/emoji",
    guidance:
      "Pick or produce a square image under ~128KB, base64 it, then call this once. An upload error is a real result to relay, not a reason to ask the user to do it by hand.",
    routes: [
      {
        method: "POST",
        path: "/v1/emoji",
        summary:
          "add one Slack custom emoji — {name, image:<base64 PNG/GIF>} (optional workspace); runs under your own Slack session or a configured fallback. An error here is a real result to relay, not a reason to ask the user to upload manually",
      },
    ],
  },
  {
    match: onPath("POST", "/v1/connectors/oauth/revoke"),
    guidance:
      "Disconnect a user's OAuth connector (the reverse of connecting one). Defaults to you; to disconnect a teammate's, name them with principalId — they must share this conversation. Confirm before revoking someone else's.",
    routes: [
      {
        method: "POST",
        path: "/v1/connectors/oauth/revoke",
        summary:
          'disconnect an OAuth connector — body {provider} (e.g. "google") or {host}, optional principalId (a conversation member; default you). Deletes the stored token across account slots; reversible by reconnecting',
      },
    ],
  },
  {
    match: () => false,
    routes: [
      {
        method: "POST",
        path: "/v1/connectors/oauth/consent/mint",
        summary:
          "mint a chat-first connect link for an OAuth provider, for YOURSELF (the current actor) only — use $AGENT_OAUTH_CONSENT_TOKEN. To get anyone else connected, don't mint anything: point them at the durable /connect/<provider>/self-connect page on the org's web UI, where signing in as themselves is the identity (no token; a refused mint's error message carries the full URL). A new login stays private to its owner; using it in a shared conversation requires a separate explicit credential grant.",
      },
      {
        method: "POST",
        path: "/v1/credentials/broker",
        summary:
          "call a vended org credential's host BY PROXY — secret stays server-side (use $AGENT_CREDENTIAL_TOKEN)",
      },
    ],
  },
  {
    match: (_m, p) => p.startsWith("/v1/admin/"),
    when: (v) => v.isAdmin && v.claims.liveActor === true,
    guidance:
      "Admin plane: you act AS this org admin — live-authorized per call, audited under their name; confirm before any mutation (bodies/params in the admin skill). Enforced limits: content reads work only from a DM with the admin; bulk config imports also require a DM; other mutations work anywhere; admin grant changes are portal-only and refuse agent tokens.",
    routes: [
      { method: "GET", path: "/v1/admin/whoami", summary: "this user's admin status" },
      {
        method: "GET",
        path: "/v1/admin/scopes",
        summary: "every scope with labels and what lives there — find scope ids here, don't guess",
      },
      {
        method: "GET",
        path: "/v1/admin/scopes/:scopeId",
        summary:
          "a scope's resolved config: command policy, SOUL, egress, flags, connectors, service credentials (non-org scopes: DM only)",
      },
      {
        method: "PUT",
        path: "/v1/admin/scopes/:scopeId/:resource",
        summary:
          "govern a scope: soul | security-posture | command-policy | egress | connectors | service-credentials | runtime ({ harnessId, modelId }) | approved-harnesses ({ ids })",
      },
      {
        method: "GET|PUT",
        path: "/v1/admin/memory?scope=",
        summary: "read or rewrite any scope's memory notebook (e.g. fix poisoned memory; non-org reads: DM only)",
      },
      {
        method: "GET",
        path: "/v1/admin/sessions?scope=",
        summary:
          "conversation metadata; /v1/admin/sessions/:id for a transcript and /:id/llm for captured prompts (DM only)",
      },
      { method: "GET", path: "/v1/admin/runs?scope=", summary: "queued / in-flight / recent runs (DM only)" },
      {
        method: "GET",
        path: "/v1/admin/files?scope=",
        summary: "document store listing; files/read?id= and files/download?id= for content (DM only)",
      },
      {
        method: "GET",
        path: "/v1/admin/volumes?scope=",
        summary: "a scope's computer/backup contents (paths and sizes; DM only)",
      },
      {
        method: "GET",
        path: "/v1/admin/crons|deployments|skills?scope=",
        summary: "artifacts by owning scope (DM only)",
      },
      {
        method: "GET",
        path: "/v1/admin/audit|errors|metrics|egress?scope=",
        summary: "observability: audit log, error telemetry, turn metrics, outbound-destination log (logs: DM only)",
      },
      { method: "GET", path: "/v1/admin/retention", summary: "org-wide usage and retention report" },
      {
        method: "GET",
        path: "/v1/admin/users",
        summary:
          "org roster with admin status; /v1/admin/users/:id for one user's activity, conversations, and personal-scope artifacts (DM only)",
      },
      {
        method: "GET",
        path: "/v1/admin/directory?q=",
        summary: "resolve a name or principal id to org-directory candidates (incl. members who've never messaged)",
      },
      {
        method: "GET",
        path: "/v1/admin/keychain",
        summary: "person-owned keychain metadata, grants, and asks (DM only)",
      },
    ],
  },
  {
    match: () => false,
    when: (v) => v.claims.liveActor !== true && v.claims.grants?.includes("admin.sessions.read") === true,
    guidance:
      "This cron has a specific read-only admin grant. Use only these listed routes; flag any other admin action to a human.",
    routes: [
      { method: "GET", path: "/v1/admin/sessions", summary: "list conversation metadata" },
      { method: "GET", path: "/v1/admin/sessions/:id", summary: "read a conversation transcript" },
      { method: "GET", path: "/v1/admin/scopes", summary: "list the scope directory" },
      { method: "GET", path: "/v1/admin/errors", summary: "read error telemetry" },
      { method: "GET", path: "/v1/admin/runs", summary: "read queued, in-flight, and recent runs" },
    ],
  },
];

const WHOAMI_FOR_ALL: AgentApiFamily = {
  match: () => false,
  when: (v) => !(v.isAdmin && v.claims.liveActor === true),
  routes: [
    { method: "GET", path: "/v1/admin/whoami", summary: "this user's org capabilities: {permissions, isAdmin, role?}" },
  ],
};

export function agentApiMatches(method: string, pathname: string): boolean {
  return FAMILIES.some((f) => f.match(method, pathname));
}

export interface AgentApiListing {
  actorId: string;
  scopeId: string;
  admin: { isAdmin: boolean; role?: string };
  endpoints: AgentApiRoute[];
  guidance: string[];
}

export function renderAgentApis(claims: CapabilityClaims, admin: { isAdmin: boolean; role?: string }): AgentApiListing {
  const view: AgentApiView = {
    claims,
    isAdmin: admin.isAdmin,
  };
  const visible = [...FAMILIES, WHOAMI_FOR_ALL].filter((f) => f.when?.(view) ?? true);
  return {
    actorId: claims.actorId,
    scopeId: claims.scopeId,
    admin,
    endpoints: visible.flatMap((f) => f.routes),
    guidance: visible.flatMap((f) => (f.guidance ? [f.guidance] : [])),
  };
}
