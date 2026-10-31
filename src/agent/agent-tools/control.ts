import { adminOperations } from "../../tools/admin.ts";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { splitToScope } from "../../api/artifact-share.ts";
import { errMessage } from "../../util/errors.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { BOT_MODES } from "../../surface-cache/channel-policy-store.ts";
import { WEBHOOK_SCHEMES } from "../../webhooks/verifiers.ts";
import { text, type ToolKit } from "./kit.ts";
import { listOrder, pageOf, previewText } from "./listing.ts";

const SENDER_WEBHOOK_SCHEMES = WEBHOOK_SCHEMES.filter((scheme) => scheme !== "hmac-sha256");
const WEBHOOK_ACTION_PREVIEW_CHARS = 2000;

export function controlPlaneTools(kit: ToolKit) {
  const { ref, recordCall, recordResult, unavailable, isUnavailable, resourceTool } = kit;
  const webhook = defineTool({
    name: "webhook",
    label: "webhook",
    description:
      "Inbound webhooks: a turn runs whenever an external system POSTs to the URL. Confirm with the user before creating one.\n" +
      "create: `task` (what to do per event; the payload is appended), `verification`, optional `filters` and `destinationKey` (same delivery menu as crons). " +
      `For ${SENDER_WEBHOOK_SCHEMES.join("/")} the user supplies the signing secret from the sender's settings; for hmac-sha256 generate a strong random one. ` +
      "The result shows the public `url` and `secret` once; relay both verbatim to the user, who must configure the sender before it fires.\n" +
      "list: 25 per page, secrets elided. update: replace one's task (same URL and secret). disable: pause one.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("list"),
        Type.Literal("update"),
        Type.Literal("disable"),
      ]),
      id: Type.Optional(Type.String({ description: "update/disable: the webhook id." })),
      task: Type.Optional(Type.String({ description: "create/update: what to do on each event." })),
      verification: Type.Optional(
        Type.Object(
          {
            scheme: Type.Union(WEBHOOK_SCHEMES.map((scheme) => Type.Literal(scheme))),
            secret: Type.String({ description: "The signing secret." }),
          },
          { description: "create: request authentication." },
        ),
      ),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: "Dotted path into the payload." }),
            in: Type.Array(Type.String(), { description: "Values that pass." }),
          }),
          { description: 'create: skip the turn unless the payload matches, e.g. [{path:"action",in:["opened"]}].' },
        ),
      ),
      destinationKey: Type.Optional(
        Type.String({ description: 'create: a key from the "Where scheduled tasks post" menu.' }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "list: page size (default 25, max 100)." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "list: page offset from the previous footer." })),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, { tool: "webhook", action: params.action, ...(params.id ? { id: params.id } : {}) });
      switch (params.action) {
        case "create": {
          if (!params.verification || typeof params.task !== "string") {
            return recordResult(
              callId,
              { tool: "webhook", error: "verification and task required" },
              text(
                "[error] webhook create requires `task` (what to do per event) and `verification` ({scheme, secret?}).",
              ),
              true,
            );
          }
          const r = await tc.webhookCreate({
            action: params.task,
            verification: params.verification,
            ...(params.filters?.length ? { filters: params.filters } : {}),
            ...(params.destinationKey !== undefined ? { destinationKey: params.destinationKey } : {}),
          });
          if (isUnavailable(r)) return unavailable(callId, "webhook");
          if (!r.ok)
            return recordResult(callId, { tool: "webhook", error: r.code }, text(`[error] ${r.message}`), true);

          const secretLine = `\nSecret (shown once — store it): ${r.secret}`;
          return recordResult(
            callId,
            { tool: "webhook", id: r.webhook.id, url: r.url, secretShown: !!r.secret },
            text(
              `Registered webhook ${r.webhook.id}.\nInbound URL (give to the sender verbatim): ${r.url}${secretLine}\nIt won't fire until the sender is pointed at this URL.`,
            ),
          );
        }
        case "list": {
          const r = await tc.webhookList();
          if (isUnavailable(r)) return unavailable(callId, "webhook");
          if (!r.length)
            return recordResult(callId, { tool: "webhook", count: 0 }, text("(no webhooks registered here)"));
          const { page, offset, note } = pageOf([...r].sort(listOrder), params);
          const lines = page.map(
            (w) =>
              `- ${w.id} (${w.verification.scheme}${w.enabled ? "" : ", paused"}): ${previewText(w.action, WEBHOOK_ACTION_PREVIEW_CHARS)}`,
          );
          return recordResult(
            callId,
            { tool: "webhook", count: r.length, shown: page.length, ...(offset > 0 ? { offset } : {}) },
            text([...lines, ...(note ? [`(${note})`] : [])].join("\n")),
          );
        }
        case "disable": {
          const id = typeof params.id === "string" && params.id ? params.id : null;
          if (!id)
            return recordResult(
              callId,
              { tool: "webhook", error: "id required" },
              text("[error] webhook disable requires `id`."),
              true,
            );
          const r = await tc.webhookDisable(id);
          if (isUnavailable(r)) return unavailable(callId, "webhook");
          if (!r.ok)
            return recordResult(callId, { tool: "webhook", error: r.code }, text(`[error] ${r.message}`), true);
          return recordResult(callId, { tool: "webhook", id, enabled: false }, text(`Disabled webhook ${id}.`));
        }
        case "update": {
          const id = typeof params.id === "string" && params.id ? params.id : null;
          const task = typeof params.task === "string" ? params.task : "";
          if (!id)
            return recordResult(
              callId,
              { tool: "webhook", error: "id required" },
              text("[error] webhook update requires `id` and the new `task`."),
              true,
            );
          const r = await tc.webhookUpdate(id, task);
          if (isUnavailable(r)) return unavailable(callId, "webhook");
          if (!r.ok)
            return recordResult(callId, { tool: "webhook", error: r.code }, text(`[error] ${r.message}`), true);
          return recordResult(
            callId,
            { tool: "webhook", id, updated: true },
            text(`Updated webhook ${id}. The next delivery uses the new task; URL and secret are unchanged.`),
          );
        }
      }
    },
  });

  const guidance = defineTool({
    name: "guidance",
    label: "guidance",
    description:
      "Read or change your durable guidance: standing instructions for future turns. " +
      "Scope `channel`: how you behave in this channel (when to chime in unprompted, where replies land, 'whenever X, do Y' orders — evaluated on every message, so never build a poll or timer for them). " +
      "`conversation`: tone, defaults and preferences, shared by all of a person's sessions in a personal context. Default: channel if in one, else conversation. " +
      "Not for session pins (POST /v1/pins) or one-off facts (memory). " +
      "edit swaps one exact passage `old` for `new`; replace overwrites the scope's whole guidance with `content`. Org-wide policy sits above and cannot be overridden.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("replace"), Type.Literal("edit")]),
      scope: Type.Optional(Type.Union([Type.Literal("channel"), Type.Literal("conversation")])),
      content: Type.Optional(Type.String({ description: "replace: the full guidance." })),
      old: Type.Optional(Type.String({ description: "edit: exact passage appearing once." })),
      new: Type.Optional(Type.String({ description: "edit: replacement for `old`." })),
      ambientEnabled: Type.Optional(
        Type.Union([Type.Boolean(), Type.Null()], {
          description:
            "Channel only. true: judge every message for a reply; false: only when addressed; null: default.",
        }),
      ),
      bots: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            mode: Type.Union(BOT_MODES.map((m) => Type.Literal(m))),
            rollupHours: Type.Optional(Type.Number()),
          }),
          {
            description:
              "Channel only, per bot author name: ignore, rollup (judge at most every rollupHours), action (posts are triggers), user (treat like a person).",
          },
        ),
      ),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, {
        tool: "guidance",
        action: params.action,
        ...(params.scope ? { scope: params.scope } : {}),
      });

      const editError = (message: string) =>
        recordResult(
          callId,
          { tool: "guidance", scope, error: message },
          text(`[error] guidance edit ${message}.`),
          true,
        );
      const applyEdit = (current: string): { ok: true; next: string } | { ok: false; message: string } => {
        if (typeof params.old !== "string" || !params.old || typeof params.new !== "string")
          return { ok: false, message: "requires `old` (an exact passage of the current guidance) and `new`" };
        const at = current.indexOf(params.old);
        if (at < 0)
          return {
            ok: false,
            message:
              "found no exact match for `old` in this scope's own guidance; org policy layered above it cannot be edited",
          };
        if (current.indexOf(params.old, at + 1) >= 0)
          return { ok: false, message: "found `old` more than once; include more surrounding text so it is unique" };
        return { ok: true, next: current.slice(0, at) + params.new + current.slice(at + params.old.length) };
      };

      let scope = params.scope;
      let channel: Awaited<ReturnType<typeof tc.getStandingOrder>> | undefined;
      if (scope !== "conversation") {
        channel = await tc.getStandingOrder();
        if (!scope) scope = channel.ok ? "channel" : "conversation";
      }

      if (scope === "channel") {
        if (!channel!.ok) {
          return recordResult(
            callId,
            { tool: "guidance", scope, ok: false },
            text("[no channel scope here; use scope=conversation]"),
            true,
          );
        }
        if (params.action === "read") {
          const soul = await tc.soulRead();
          const convoExists = !isUnavailable(soul) && !!soul.soul && soul.soul.trim().length > 0;
          const ledger =
            channel!.bots && Object.keys(channel!.bots).length
              ? "\n\nBot ledger:\n" +
                Object.entries(channel!.bots)
                  .map(([n, b]) => `- ${n}: ${b.mode}${b.rollupHours ? ` (every ${b.rollupHours}h)` : ""}`)
                  .join("\n")
              : "";
          const note = convoExists
            ? "\n\n(conversation-scope guidance also exists — read with scope=conversation)"
            : "";
          let ambientState = "default";
          if (channel!.ambientEnabled !== undefined) ambientState = channel!.ambientEnabled ? "on" : "off";
          const ambient = `\n\nAmbient replies: ${ambientState}`;
          const body =
            (channel!.orders.trim() ? channel!.orders : "[no channel guidance set]") + ambient + ledger + note;
          return recordResult(callId, { tool: "guidance", scope, ok: true }, text(body));
        }
        let orders = typeof params.content === "string" ? params.content : undefined;
        if (params.action === "edit") {
          const edited = applyEdit(channel!.orders);
          if (!edited.ok) return editError(edited.message);
          orders = edited.next;
        } else if (typeof orders !== "string" && params.bots === undefined && params.ambientEnabled === undefined) {
          return recordResult(
            callId,
            { tool: "guidance", scope, error: "content, bots, or ambientEnabled required" },
            text(
              "[error] guidance replace needs `content` (the full new channel guidance), `bots`, and/or `ambientEnabled`.",
            ),
            true,
          );
        }
        const r = await tc.setStandingOrder(
          orders,
          params.bots,
          params.ambientEnabled,
          params.action === "edit" ? channel!.orders : undefined,
        );
        if (!r.ok)
          return recordResult(callId, { tool: "guidance", scope, ok: false }, text(`[error] ${r.message}`), true);
        return recordResult(callId, { tool: "guidance", scope, ok: true }, text("[channel guidance updated]"));
      }

      if (params.ambientEnabled !== undefined) {
        return recordResult(
          callId,
          { tool: "guidance", scope, error: "ambientEnabled is channel scope only" },
          text("[error] `ambientEnabled` applies only to channel scope."),
          true,
        );
      }

      if (params.action === "read") {
        const r = await tc.soulRead();
        if (isUnavailable(r)) return unavailable(callId, "guidance");
        return recordResult(
          callId,
          { tool: "guidance", scope, soulVersion: r.soulVersion },
          text(r.soul ? r.soul : "(no standing instructions set)"),
        );
      }
      let content = params.content;
      let expectedVersion: number | undefined;
      if (params.action === "edit") {
        const current = await tc.soulRead();
        if (isUnavailable(current)) return unavailable(callId, "guidance");
        const edited = applyEdit(current.soul ?? "");
        if (!edited.ok) return editError(edited.message);
        content = edited.next;
        expectedVersion = current.soulVersion;
      } else if (typeof content !== "string") {
        return recordResult(
          callId,
          { tool: "guidance", scope, error: "content required" },
          text("[error] guidance replace requires `content` (the full new standing instructions)."),
          true,
        );
      }
      const r = await tc.soulWrite(content, expectedVersion);
      if (isUnavailable(r)) return unavailable(callId, "guidance");
      if (!r.ok)
        return recordResult(callId, { tool: "guidance", scope, error: r.code }, text(`[error] ${r.message}`), true);
      return recordResult(
        callId,
        { tool: "guidance", scope, version: r.version },
        text(`Updated your standing instructions (now version ${r.version}).`),
      );
    },
  });

  const ARTIFACT_ID_DESCRIPTIONS = {
    file: "Artifact ID.",
    skill: "Skill id from skills list or search.",
    deploy: "App ID or handle.",
    cron: "Artifact ID.",
  };
  function sharingTool(type: "file" | "skill" | "deploy" | "cron", move = false): ToolDefinition {
    const tool = { file: "files", skill: "skills", deploy: "apps", cron: "cron" }[type];
    const action = move ? "move" : "share";
    let description = "Grant access to an artifact you own; grantees cannot reshare.";
    if (type === "file")
      description = "Share a Files record by ID (upload a sandbox path with POST /v1/files/uploads first).";
    if (move)
      description =
        "Move to another context; moving an app transfers ownership; shares survive. Moving a skill to the org needs an org admin on a user-started turn.";
    else if (type === "deploy")
      description =
        "Change access to an app you own: `public`, or toScope/email for signed-in access (external emails view-only).";
    return defineTool({
      name: action,
      label: action,
      description,
      parameters: Type.Object({
        id: Type.String({ description: ARTIFACT_ID_DESCRIPTIONS[type] }),
        toScope:
          type === "deploy" && !move
            ? Type.Optional(
                Type.String({
                  description: '"org", channel:<id>, team:<id>, personal:<id>, or a teammate name.',
                }),
              )
            : Type.String({
                description: '"org", channel:<id>, team:<id>, personal:<id>, or a teammate name.',
              }),
        ...(type === "deploy" && !move
          ? {
              email: Type.Optional(
                Type.String({
                  description: "Email granted view access; alternative to toScope.",
                }),
              ),
              public: Type.Optional(
                Type.Boolean({
                  description: "true: anyone with the link; false: restricted.",
                }),
              ),
              notify: Type.Optional(
                Type.Boolean({
                  description: "false: skip the access DM and invite email.",
                }),
              ),
            }
          : {}),
        ...(!move
          ? {
              permission: Type.Optional(
                Type.Union([Type.Literal("read"), Type.Literal("write")], {
                  description: "read (default) or write (manage).",
                }),
              ),
            }
          : {}),
      }),
      async execute(callId, args) {
        const params = args as {
          id: string;
          toScope?: string;
          email?: string;
          public?: boolean;
          permission?: "read" | "write";
          notify?: boolean;
        };
        const tc = ref.current;
        if (!tc) return text("[error] no active tool context");
        const id = params.id;
        await recordCall(callId, { tool, action, type, id });
        if (type === "deploy" && !move && params.public !== undefined) {
          if (params.toScope !== undefined || params.email !== undefined)
            return recordResult(
              callId,
              { tool, action, error: "bad_request" },
              text("[error] set public, email, or toScope, not more than one"),
              true,
            );
          const d = await tc.setDeploymentPublic(id, params.public);
          return recordResult(
            callId,
            { tool, action, type, id: d.id, public: d.public },
            text(`${d.name ?? d.id} is now ${d.public ? "public — anyone with the link can open it" : "restricted"}.`),
          );
        }
        if (!params.toScope && !params.email)
          return recordResult(
            callId,
            { tool, action, error: "bad_request" },
            text("[error] toScope or email is required unless public is set"),
            true,
          );
        const r = await tc.shareArtifact({
          type,
          id,
          ...(params.toScope ? splitToScope(params.toScope) : {}),
          ...(params.email !== undefined ? { email: params.email } : {}),
          ...(params.permission !== undefined ? { permission: params.permission } : {}),
          ...(move ? { move: true } : {}),
          ...(params.notify !== undefined ? { notify: params.notify } : {}),
        });
        if (isUnavailable(r)) return unavailable(callId, tool);
        if (!r.ok) {
          const candidates = r.candidates?.length
            ? `\nCandidates: ${r.candidates.map((c) => `${c.label} (${c.id})`).join(", ")}`
            : "";
          return recordResult(callId, { tool, action, error: r.code }, text(`[error] ${r.message}${candidates}`), true);
        }
        let invitationNote = "";
        if (params.notify === false) invitationNote = " No DM or invitation email sent.";
        else if (r.invitation?.emailSent) invitationNote = " App invitation email sent.";
        else if (r.invitation?.alreadyShared) invitationNote = " Already shared; no duplicate email sent.";
        else if (r.invitation)
          invitationNote = ` Access granted, but invitation email was not sent: ${r.invitation.emailProblem ?? "delivery unavailable"}`;
        if (r.invitation?.appUrl) invitationNote += ` App link: ${r.invitation.appUrl}`;
        return recordResult(
          callId,
          { tool, action, verb: r.verb, type: r.type, id: r.id, target: r.target.scope },
          text(
            `${r.verb === "move" ? "Moved" : "Shared"} ${r.type} ${r.id} → ${r.target.label}${r.verb === "share" ? ` (${r.permission})` : ""}.${invitationNote}`,
          ),
        );
      },
    });
  }

  const admin = resourceTool(
    "admin",
    Object.fromEntries(
      Object.entries(
        ref.current === null || ref.current.admin?.operationsAvailable
          ? adminOperations
          : { whoami: adminOperations.whoami },
      ).map(([action, operation]) => [
        action,
        defineTool({
          name: action,
          label: action,
          description: operation.description,
          parameters: operation.parameters,
          async execute(callId, params) {
            await recordCall(callId, { tool: "admin", action });
            try {
              const result = await ref.current?.admin?.call({ ...params, action }, ref.abortSignal);
              if (!result) throw new Error("Admin API is not available on this turn");
              return recordResult(
                callId,
                { tool: "admin", action, status: result.status },
                {
                  ...text(result.status >= 400 ? redactSecrets(JSON.stringify(result)) : JSON.stringify(result)),
                  isError: result.status >= 400,
                },
                result.status >= 400,
              );
            } catch (error) {
              return recordResult(
                callId,
                { tool: "admin", action, error: redactSecrets(errMessage(error)) },
                { ...text(redactSecrets(errMessage(error))), isError: true },
                true,
              );
            }
          },
        }),
      ]),
    ),
  );

  if (ref.current === null || ref.current.admin?.operationsAvailable)
    admin.description =
      "Admin API; authority is rechecked on every call and audited. Private content needs a live admin in a DM or Open conversation; unattended reads need explicit grants. Admin-role changes, impersonation, identity links and teammate invitations are portal-only. Confirm every mutation, report exactly what changed, and disclose only what this conversation needs. Never put secrets in arguments.\n\n" +
      admin.description;

  return { webhook, guidance, sharingTool, admin };
}
