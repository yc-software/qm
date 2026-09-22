import { orgId as configOrgId } from "../../config.ts";
import {
  mintCapabilityToken,
  verifyCapabilityToken,
  SECRET_DROP_AUD,
  type CapabilityClaims,
} from "../../auth/capability-token.ts";
import { KeychainError, type GrantMode } from "../../credentials/keychain.ts";
import { SECRET_DROP_TTL_MS, type SecretDropField, type SecretDropRecord } from "../../credentials/secret-drop.ts";
import { isSharedScope, parseScopeId } from "../../types.ts";
import { samePerson } from "../../directory/person.ts";
import { escapeHtml, sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { audit, resolveCapabilityDestination, verifiedConversationSpeaker } from "./shared.ts";
import { swallow } from "../../util/errors.ts";

const TRIGGERED = "secret-drop links can only be minted on a turn a person sent — this turn was fired by a trigger";

function dropPage(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light dark;--bg:#fff;--surface:#fff;--text:#0a0a0a;--muted:#737373;--border:#e5e5e5;--secondary:#f5f5f5;--input:#e5e5e5;--cta:oklch(0.27 0.062 250);--cta-hover:oklch(0.33 0.07 250);--cta-foreground:oklch(0.99 0 0)}
  @media(prefers-color-scheme:dark){:root{--bg:oklch(0.165 0.022 250);--surface:oklch(0.205 0.024 250);--text:oklch(0.975 0.005 250);--muted:oklch(0.72 0.021 250);--border:oklch(0.275 0.024 250);--secondary:oklch(0.245 0.024 250);--input:oklch(0.325 0.026 250);--cta:oklch(0.42 0.085 250);--cta-hover:oklch(0.48 0.09 250)}}
  *{box-sizing:border-box}
  html,body{min-height:100%}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  main{min-height:100svh;padding:32px 20px;display:grid;place-items:center}
  .card{width:100%;max-width:460px;min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px;text-align:left;overflow-wrap:anywhere}
  .icon{width:40px;height:40px;margin:0 0 20px;border-radius:10px;background:var(--secondary);display:grid;place-items:center}
  .icon svg{width:22px;height:22px;stroke:var(--text);fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  h1{font-size:20px;font-weight:600;letter-spacing:-.02em;line-height:1.35;margin:0 0 8px}
  p{color:var(--muted);margin:0}
  .request{margin:22px 0;text-align:left;background:var(--secondary);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
  .request strong{display:block;color:var(--text);font-weight:500;margin-top:4px}
  .requested{display:block;color:var(--muted);font-size:12px;margin-top:8px}
  form{display:grid;gap:16px;text-align:left}
  .field{display:grid;gap:6px;min-width:0}
  label{font-size:12.5px;font-weight:600;color:var(--muted)}
  input{width:100%;min-width:0;min-height:44px;padding:0 14px;font:inherit;font-size:16px;color:var(--text);background:var(--bg);border:1px solid var(--input);border-radius:8px}
  input:focus-visible,button:focus-visible{outline:2px solid var(--muted);outline-offset:2px}
  button{min-height:44px;padding:10px 18px;width:100%;font:inherit;font-size:13px;font-weight:500;border-radius:8px;cursor:pointer;background:var(--cta);color:var(--cta-foreground);border:1px solid var(--cta)}
  button:hover{background:var(--cta-hover);border-color:var(--cta-hover)}
  button:disabled{opacity:.5;cursor:wait}
  #done:not(:empty){margin-top:20px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--secondary);color:var(--text)}
  .help{font-size:12.5px;margin-top:22px;padding-top:20px;border-top:1px solid var(--border)}
  @media(max-width:380px){.card{padding:28px 20px}}
</style>
</head>
<body><main><section class="card" aria-labelledby="title">
<div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></div>
${content}
</section></main></body>
</html>`;
}

const MAX_DROP_FIELDS = 8;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseDropFields(raw: unknown): SecretDropField[] | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DROP_FIELDS) return "invalid";
  const out: SecretDropField[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    const key = (f as { key?: unknown })?.key;
    if (typeof key !== "string" || !ENV_KEY_RE.test(key) || seen.has(key)) return "invalid";
    seen.add(key);
    const labelRaw = (f as { label?: unknown })?.label;
    const label = typeof labelRaw === "string" && labelRaw.trim() ? labelRaw.trim().slice(0, 80) : undefined;
    const secret = (f as { secret?: unknown })?.secret === false ? false : true;
    out.push({ key, ...(label ? { label } : {}), secret });
  }
  return out;
}

function formFields(fields?: SecretDropField[]): Array<{ key: string | null; label: string; secret: boolean }> {
  if (fields?.length) return fields.map((f) => ({ key: f.key, label: f.label ?? f.key, secret: f.secret !== false }));
  return [{ key: null, label: "Paste the secret here", secret: true }];
}

function dropNotYoursHtml(): string {
  return dropPage(
    "Not your link",
    `<h1 id="title">This link is for someone else</h1><p>This credential request was created for a different teammate. If it was meant for you, sign in as yourself and open it again.</p>`,
  );
}

function dropScopeAuthorized(ctx: ApiCtx, rec: SecretDropRecord, claims?: CapabilityClaims): Promise<boolean> {
  const audienceScopeId = rec.audienceScopeId;
  if (!audienceScopeId || !isSharedScope(audienceScopeId)) return Promise.resolve(true);
  return ctx.app
    .authorizesCapabilityScope({
      actorId: rec.ownerId,
      scopeId: audienceScopeId,
      ...(rec.scopeVersion ? { scopeVersion: rec.scopeVersion } : {}),
      ...(claims?.botActor ? { botActor: true } : {}),
      ...(claims?.liveActor ? { liveActor: true } : {}),
      ...(claims?.members ? { members: claims.members } : {}),
    })
    .catch(() => false);
}

async function dropLinkClaims(
  ctx: ApiCtx,
  dropId: string,
  rec: SecretDropRecord,
): Promise<CapabilityClaims | true | null> {
  if (!rec.requiresToken) return true;
  const capSecret = ctx.deps.capabilitySecret ?? ctx.secret;
  const token = ctx.url.searchParams.get("t");
  if (!capSecret || !token) return null;
  const claims = await verifyCapabilityToken(token, capSecret);
  if (
    !claims ||
    claims.aud !== SECRET_DROP_AUD ||
    claims.drop !== dropId ||
    !samePerson(claims.actorId, rec.ownerId) ||
    (rec.audienceScopeId && claims.scopeId !== rec.audienceScopeId)
  )
    return null;
  return claims;
}

function dropFormHtml(
  dropId: string,
  rec: { service: string; purpose: string; fields?: SecretDropField[]; createdAt?: number } | null,
): string {
  if (!rec) {
    return dropPage(
      "Secret drop",
      `<h1 id="title">This link has expired</h1><p>Secret-drop links are single-use. Ask the agent for a fresh one.</p>`,
    );
  }
  const service_ = escapeHtml(rec.service);
  const purpose_ = escapeHtml(rec.purpose);
  const requested_ = rec.createdAt ? escapeHtml(new Date(rec.createdAt).toISOString().slice(0, 10)) : "";
  const id_ = JSON.stringify(dropId);
  const fields = formFields(rec.fields);
  const multi = fields.length > 1 || fields[0]!.key !== null;
  const inputs = fields
    .map(
      (f, i) =>
        `<div class="field"><label for="field-${i}">${escapeHtml(f.key === null ? "Credential" : f.label)}</label><input id="field-${i}" type=${f.secret ? "password" : "text"} autocomplete=off autocapitalize=off spellcheck=false placeholder="${escapeHtml(f.label)}"></div>`,
    )
    .join("\n");
  const keys = JSON.stringify(fields.map((f) => f.key));
  return dropPage(
    "Provide a credential",
    `<h1 id="title">Provide your ${service_} ${multi ? "login" : "credential"}</h1>
<div class="request"><p>The agent asked for this so it can:</p><strong>${purpose_}</strong>${requested_ ? `<span class="requested">Requested ${requested_}</span>` : ""}</div>
<form id=f>
${inputs}
<button id=go type="submit">Submit securely</button>
</form>
<p id=done role="status" aria-live="polite"></p>
<p class="help">What you enter goes straight to the keychain over TLS and is encrypted at rest. It is never shown in chat. This link works once.</p>
<script>const f=document.getElementById('f'),keys=${keys};f.onsubmit=async(e)=>{e.preventDefault();const inputs=[...f.querySelectorAll('input')];const go=document.getElementById('go');go.disabled=true;let body;if(keys.length===1&&keys[0]===null){body={secret:inputs[0].value};}else{const values={};inputs.forEach((el,i)=>{values[keys[i]]=el.value;});body={values};}const r=await fetch('/drop/'+encodeURIComponent(${id_})+location.search,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});inputs.forEach(el=>el.value='');if(r.ok){f.remove();document.getElementById('done').textContent='Received — you can close this tab and return to the conversation.';}else{document.getElementById('done').textContent='Could not save (the link may have expired, been used, or was missing a field).';go.disabled=false;}};</script>
`,
  );
}

async function mintDrop(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability, secret } = ctx;
  if (!deps.keychain || !deps.secretDrops) return sendJson(res, 404, { error: "not_found" });
  if (!capability)
    return sendJson(res, 401, {
      error: "unauthorized",
      message: "secret-drop mint requires an agent capability token",
    });
  const capSecret = deps.capabilitySecret ?? secret;
  if (!capSecret)
    return sendJson(res, 500, { error: "misconfigured", message: "no capability secret to bind the drop link with" });
  if (capability.triggered) return sendJson(res, 403, { error: "forbidden", message: TRIGGERED });
  const b = body as {
    service?: unknown;
    envKey?: unknown;
    host?: unknown;
    purpose?: unknown;
    grantMode?: unknown;
    fields?: unknown;
    onBehalfOf?: unknown;
  };
  if (typeof b.service !== "string" || !b.service.trim() || typeof b.purpose !== "string" || !b.purpose.trim()) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "expected { service, purpose, envKey?, host?, grantMode?, fields? }",
    });
  }
  if (b.grantMode !== undefined && b.grantMode !== "once" && b.grantMode !== "standing") {
    return sendJson(res, 400, { error: "bad_request", message: 'grantMode must be "once" or "standing"' });
  }
  const fields = parseDropFields(b.fields);
  if (fields === "invalid") {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `fields must be 1–${MAX_DROP_FIELDS} items of { key: ENV_VAR_NAME, label?, secret? } with unique keys`,
    });
  }
  let ownerId = capability.actorId;
  if (typeof b.onBehalfOf === "string" && b.onBehalfOf.trim() && !samePerson(b.onBehalfOf, capability.actorId)) {
    const speaker = await verifiedConversationSpeaker(ctx, b.onBehalfOf.trim());
    if ("error" in speaker) return sendJson(res, 403, { error: "forbidden", message: speaker.error });
    ownerId = speaker.principalId;
  }
  const scope = parseScopeId(capability.scopeId);
  const wantsGrant = scope.kind === "channel" || scope.kind === "group";
  const dest = resolveCapabilityDestination(capability, undefined);
  const { dropId } = await deps.secretDrops.mint({
    ownerId,
    orgId: configOrgId(),
    service: b.service.trim(),
    ...(typeof b.envKey === "string" && b.envKey.trim() ? { envKey: b.envKey.trim() } : {}),
    ...(typeof b.host === "string" && b.host.trim() ? { host: b.host.trim() } : {}),
    ...(fields ? { fields } : {}),
    purpose: b.purpose.trim(),
    requestedBy: capability.actorId,
    audienceScopeId: capability.scopeId,
    ...(wantsGrant ? { grantMode: (b.grantMode as GrantMode | undefined) ?? "standing" } : {}),
    ...(wantsGrant && capability.scopeVersion ? { scopeVersion: capability.scopeVersion } : {}),
    ...(dest.ok && dest.destination ? { destination: dest.destination } : {}),
    ...(capability.threadRef ? { threadRef: capability.threadRef } : {}),
    requiresToken: true,
  });
  audit(deps, {
    principalId: capability.actorId,
    action: "keychain.drop.mint",
    resource: `${b.service.trim()}:${dropId}${samePerson(ownerId, capability.actorId) ? "" : ` (onBehalfOf ${ownerId})`}`,
    scopeLabel: capability.scopeId,
  });
  const linkToken = await mintCapabilityToken(
    {
      actorId: ownerId,
      scopeId: capability.scopeId,
      ...(capability.botActor ? { botActor: true } : {}),
      ...(capability.liveActor ? { liveActor: true } : {}),
      ...(capability.members ? { members: capability.members } : {}),
      aud: SECRET_DROP_AUD,
      drop: dropId,
      exp: Date.now() + SECRET_DROP_TTL_MS,
    },
    capSecret,
  );
  const formPath = `/drop/${dropId}/form?t=${encodeURIComponent(linkToken)}`;
  const base = (deps.portalUrl ?? deps.publicUrl)?.replace(/\/$/, "");
  return sendJson(res, 200, { dropId, formPath, url: base ? `${base}${formPath}` : formPath });
}

async function dropForm(ctx: ApiCtx): Promise<void> {
  const { res, deps, params, req } = ctx;
  const peeked = deps.secretDrops ? await deps.secretDrops.peek(params.id!) : ({ ok: false } as const);
  if (!peeked.ok) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    return void res.end(dropFormHtml(params.id!, null));
  }
  if (!(await dropLinkClaims(ctx, params.id!, peeked.rec))) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    return void res.end(dropFormHtml(params.id!, null));
  }
  if (!samePerson(req.headers["x-drop-owner"] as string | undefined, peeked.rec.ownerId)) {
    res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
    return void res.end(dropNotYoursHtml());
  }
  const rec = {
    service: peeked.rec.service,
    purpose: peeked.rec.purpose,
    fields: peeked.rec.fields,
    createdAt: peeked.rec.createdAt,
  };
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(dropFormHtml(params.id!, rec));
}

async function redeemDrop(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params, req } = ctx;
  if (!deps.keychain || !deps.secretDrops) return sendJson(res, 404, { error: "not_found" });
  const { secret, values } = body as { secret?: unknown; values?: unknown };
  const peeked = await deps.secretDrops.peek(params.id!);
  if (!peeked.ok) {
    const message =
      peeked.reason === "expired"
        ? "this drop link has expired — ask the agent for a fresh one"
        : "this drop link is invalid or was already used — ask the agent for a fresh one";
    return sendJson(res, 404, { error: "not_found", message });
  }
  const linkClaims = await dropLinkClaims(ctx, params.id!, peeked.rec);
  if (!linkClaims) {
    return sendJson(res, 404, {
      error: "not_found",
      message: "this drop link is invalid or was already used — ask the agent for a fresh one",
    });
  }
  if (!samePerson(req.headers["x-drop-owner"] as string | undefined, peeked.rec.ownerId)) {
    return sendJson(res, 403, {
      error: "forbidden",
      message: "sign in as the account owner to complete this credential drop",
    });
  }
  const attestation = linkClaims === true ? undefined : linkClaims;
  if (!(await dropScopeAuthorized(ctx, peeked.rec, attestation))) {
    await deps.secretDrops.redeem(params.id!).catch(() => null);
    return sendJson(res, 409, {
      error: "scope_changed",
      message: "conversation membership changed — ask the agent for a fresh link",
    });
  }
  const dropFieldDefs = peeked.rec.fields;
  let saveFields: Array<{ envKey: string; value: string; secret: boolean }> | undefined;
  if (dropFieldDefs?.length) {
    const vmap = (typeof values === "object" && values ? values : {}) as Record<string, unknown>;
    saveFields = [];
    for (const f of dropFieldDefs) {
      const v = vmap[f.key];
      if (typeof v !== "string" || !v.trim())
        return sendJson(res, 400, { error: "bad_request", message: `missing value for ${f.key}` });
      saveFields.push({ envKey: f.key, value: v.trim(), secret: f.secret !== false });
    }
  } else if (typeof secret !== "string" || !secret.trim()) {
    return sendJson(res, 400, { error: "bad_request", message: "expected { secret }" });
  }
  const redeemed = await deps.secretDrops.redeem(params.id!);
  if (!redeemed.ok) {
    const message =
      redeemed.reason === "expired"
        ? "this drop link has expired — ask the agent for a fresh one"
        : "this drop link is invalid or was already used — ask the agent for a fresh one";
    return sendJson(res, 404, { error: "not_found", message });
  }
  const drop = redeemed.rec;
  if (drop.orgId !== undefined && drop.orgId !== configOrgId())
    return sendJson(res, 404, { error: "not_found", message: "this drop link is for a different org" });
  try {
    const meta = await deps.keychain.save({
      ownerId: drop.ownerId,
      service: drop.service,
      ...(saveFields ? { fields: saveFields } : { secret: secret as string }),
      ...(!saveFields && drop.envKey ? { envKey: drop.envKey } : {}),
      ...(drop.host ? { host: drop.host } : {}),
      origin: "secret-drop",
    });
    const mayShare = await dropScopeAuthorized(ctx, drop, attestation);
    let grantId: string | undefined;
    if (mayShare && drop.grantMode && drop.audienceScopeId) {
      const grant = await deps.keychain.createGrant({
        credentialId: meta.id,
        ownerId: drop.ownerId,
        audienceScopeId: drop.audienceScopeId,
        mode: drop.grantMode,
        purpose: drop.purpose,
      });
      grantId = grant.id;
    }
    audit(deps, {
      principalId: drop.ownerId,
      action: "keychain.drop.redeem",
      resource: `${meta.service}:${meta.id}`,
      scopeLabel: drop.audienceScopeId ?? drop.ownerId,
    });
    if (mayShare && drop.audienceScopeId) {
      void (async () => {
        const pending = (await deps.secretDrops!.siblings(drop).catch(() => [])).map((s) => s.service);
        await deps.fireDropResolution?.({
          id: params.id!,
          ownerId: drop.ownerId,
          service: meta.service,
          purpose: drop.purpose,
          audienceScopeId: drop.audienceScopeId!,
          ...(drop.destination ? { destination: drop.destination } : {}),
          ...(drop.threadRef ? { threadRef: drop.threadRef } : {}),
          ...(grantId ? { grantId } : {}),
          granted: !!grantId,
          ...(pending.length ? { pendingSiblings: pending } : {}),
        });
      })().catch((e) => swallow("secret-drop: resolution fire failed", e));
    }
    return sendJson(res, 200, { ok: true, credential: meta });
  } catch (e) {
    if (e instanceof KeychainError) return sendJson(res, e.status, { error: "keychain", message: e.message });
    throw e;
  }
}

export const secretDropRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/keychain/drops", auth: "either", handle: mintDrop },
  { method: "GET", path: "/v1/keychain/drops/:id/form", auth: "source", handle: dropForm },
  { method: "POST", path: "/v1/keychain/drops/:id", auth: "source", handle: redeemDrop },
];
