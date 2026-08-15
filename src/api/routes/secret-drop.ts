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
import { audit, resolveCapabilityDestination } from "./shared.ts";
import { swallow } from "../../util/errors.ts";

const TRIGGERED = "secret-drop links can only be minted on a turn a person sent — this turn was fired by a trigger";

const PAGE_STYLE = 'style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"';

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
  return `<!doctype html><meta charset=utf-8><title>Not your link</title><body ${PAGE_STYLE}>
<h2>This link is for someone else</h2><p>This credential request was created for a different teammate. If it was meant for you, sign in as yourself and open it again.</p></body>`;
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
    return `<!doctype html><meta charset=utf-8><title>Secret drop</title><body ${PAGE_STYLE}>
<h2>This link has expired</h2><p>Secret-drop links are single-use. Ask the agent for a fresh one.</p></body>`;
  }
  const service_ = escapeHtml(rec.service);
  const purpose_ = escapeHtml(rec.purpose);
  const requested_ = rec.createdAt ? escapeHtml(new Date(rec.createdAt).toISOString().slice(0, 10)) : "";
  const id_ = JSON.stringify(dropId);
  const fields = formFields(rec.fields);
  const multi = fields.length > 1 || fields[0]!.key !== null;
  const inputs = fields
    .map(
      (f) =>
        `<input type=${f.secret ? "password" : "text"} autocomplete=off autocapitalize=off spellcheck=false placeholder="${escapeHtml(f.label)}" style="width:100%;font-size:1rem;padding:.5rem;box-sizing:border-box;margin-bottom:.6rem">`,
    )
    .join("\n");
  const keys = JSON.stringify(fields.map((f) => f.key));
  return `<!doctype html><meta charset=utf-8><title>Provide a credential</title><body ${PAGE_STYLE}>
<h2>Provide your ${service_} ${multi ? "login" : "credential"}</h2>
<p style="color:#555">The agent asked for this so it can: <b>${purpose_}</b>${requested_ ? ` <span style="color:#999">(requested ${requested_})</span>` : ""}</p>
<form id=f>
${inputs}
<button id=go style="font-size:1rem;padding:.6rem 1.2rem;margin-top:.2rem">Submit securely</button>
</form>
<p id=done></p>
<p style="color:#888;font-size:.85rem">What you enter goes straight to the keychain over TLS and is encrypted at rest. It is never shown in chat. This link works once.</p>
<script>const f=document.getElementById('f'),keys=${keys};f.onsubmit=async(e)=>{e.preventDefault();const inputs=[...f.querySelectorAll('input')];const go=document.getElementById('go');go.disabled=true;let body;if(keys.length===1&&keys[0]===null){body={secret:inputs[0].value};}else{const values={};inputs.forEach((el,i)=>{values[keys[i]]=el.value;});body={values};}const r=await fetch('/drop/'+encodeURIComponent(${id_})+location.search,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});inputs.forEach(el=>el.value='');if(r.ok){f.remove();document.getElementById('done').textContent='Received — you can close this tab and return to the conversation.';}else{document.getElementById('done').textContent='Could not save (the link may have expired, been used, or was missing a field).';go.disabled=false;}};</script>
</body>`;
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
  const scope = parseScopeId(capability.scopeId);
  const wantsGrant = scope.kind === "channel" || scope.kind === "group";
  const dest = resolveCapabilityDestination(capability, undefined);
  const { dropId } = await deps.secretDrops.mint({
    ownerId: capability.actorId,
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
    resource: `${b.service.trim()}:${dropId}`,
    scopeLabel: capability.scopeId,
  });
  const linkToken = await mintCapabilityToken(
    {
      actorId: capability.actorId,
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
