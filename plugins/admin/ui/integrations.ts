import { choiceGroup, settingStatus, saveFooter } from "./setting-controls.ts";
import { html, render, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { states, connectors, installation, emoji, context, type SlackSetting } from "./integrations-state.ts";
export {
  configure,
  owns,
  collect,
  capture,
  commit,
  status,
  statusKey,
  states,
  connectors,
  installation,
} from "./integrations-state.ts";
import { loadScope as loadSettings } from "./integrations-state.ts";
export function loadScope(data: any, scope: string) {
  loadSettings(data, scope);
  if (states.get("ack-emoji")!.available) void emoji.load();
}
export const loadConnectors = () => connectors.load();
export const loadSlackInstallation = () => installation.load();
const cards: Record<string, () => ReturnType<typeof html>> = {};
cards["card-external-slack"] = () => {
  const s = states.get("external-slack-participants")!;
  return html`<section
    class=${classMap({ card: true, "sv-slack-settings": true, "setting-row": true, hidden: !s.available, dirty: s.dirty })}
    id="card-external-slack"
  >
    <div class="head">
      <h2>External Slack audience</h2>
      <p>
        Org-wide, default off. When on, internal members may chat with the agent in Slack rooms whose audience includes
        an external user (Connect member or guest). Its replies, and anything it reads there, are visible to those
        externals. Externals themselves still can't interact.
      </p>
    </div>
    <div class="body">
      <input
        type="checkbox"
        id="external-slack-participants"
        .checked=${!!s.draft.on}
        @change=${(e: Event) => s.change({ on: (e.target as HTMLInputElement).checked })}
        hidden
      />
      ${choiceGroup(
        {
          name: "external-slack-choice",
          value: ({ true: "on", false: "off" } as Record<string, string>)[String(s.draft.on)] || "",
          checkboxFor: "external-slack-participants",
          onChange: (event: Event) => s.change({ on: (event.target as HTMLInputElement).value === "on" }),
        },
        [
          ["off", "Internal only", "Default. The agent stays silent in Slack rooms that include an external user."],
          [
            "on",
            "Allow mixed rooms",
            "Internal members can use the agent where externals are present. Externals still cannot interact.",
          ],
        ],
      )}
    </div>
    ${saveFooter(s, "Apply", !s.available)}
  </section>`;
};
cards["card-internal-member-overrides"] = () => {
  const s = states.get("internal-member-overrides")!;
  return html`<section
    class=${classMap({ card: true, "sv-slack-settings": true, "setting-row": true, hidden: !s.available, dirty: s.dirty })}
    id="card-internal-member-overrides"
  >
    <div class="head">
      <h2 id="internal-member-overrides-title">Internal member overrides</h2>
      <p id="internal-member-overrides-help">
        Treat listed Slack users as internal members, including guests and people missing from the directory. This
        grants internal-member access, not just permission to mention the agent. Rooms containing only internal members
        may use organization credentials. Add only trusted colleagues. Enter one Slack user ID or Slack-profile email
        per line (commas also accepted).
      </p>
    </div>
    <div class="body">
      <textarea
        id="internal-member-overrides"
        .value=${s.draft.text || ""}
        @input=${(e: Event) => s.change({ text: (e.target as HTMLTextAreaElement).value })}
        rows="4"
        aria-labelledby="internal-member-overrides-title"
        aria-describedby="internal-member-overrides-help internal-member-overrides-count"
        spellcheck="false"
        placeholder="contractor@example.com&#10;U0123ABCDE"
        style="width: 100%; max-width: 560px; font-family: var(--mono, monospace)"
      ></textarea>
      <small class="muted" id="internal-member-overrides-count">${overrideCount(s)}</small>
    </div>
    ${saveFooter(s, "Apply", !s.available)}
  </section>`;
};
cards["card-channel-header-pin-default"] = () => {
  const s = states.get("channel-header-pin-default")!;
  return html`<section
    class=${classMap({ card: true, "sv-slack-settings": true, "setting-row": true, hidden: !s.available, dirty: s.dirty })}
    id="card-channel-header-pin-default"
  >
    <div class="head">
      <h2>Pinned channel message</h2>
      <p>
        When QM joins an internal Slack channel, it can post and pin a message showing the active model and a link to
        that channel’s settings. Turn this off to remove QM’s pinned message from channels using this default.
        Individual channels can override it on their settings page.
      </p>
    </div>
    <div class="body">
      <label class="setting-toggle">
        <input
          type="checkbox"
          id="channel-header-pin-default"
          .checked=${!!s.draft.on}
          @change=${(e: Event) => s.change({ on: (e.target as HTMLInputElement).checked })}
        />
        <span class="setting-switch" aria-hidden="true"></span>
        <span class="setting-copy"
          ><strong>Post and pin this message by default</strong
          ><small
            >Applies to channels without an explicit choice; flipping this updates existing channels within a
            moment.</small
          ></span
        >
      </label>
      <figure class="slack-message-example">
        <figcaption>Example · pinned in #product</figcaption>
        <div class="slack-example-message">
          <span class="slack-example-avatar" aria-hidden="true">Q</span>
          <div>
            <strong>QM</strong> <span class="muted">APP</span>
            <p>Using Sonnet here. <span class="slack-example-link">More settings</span></p>
          </div>
        </div>
        <p class="hint">
          “More settings” opens this channel’s settings page. The model name follows the channel’s selected model.
        </p>
      </figure>
    </div>
    ${saveFooter(s, "Apply", !s.available)}
  </section>`;
};
cards["card-ack-emoji"] = () => {
  const s = states.get("ack-emoji")!;
  return html`<section
    class=${classMap({ card: true, "sv-slack-settings": true, hidden: !s.available, dirty: s.dirty })}
    id="card-ack-emoji"
  >
    <div class="head">
      <h2>Acknowledgment emoji</h2>
      <p>
        The emoji the bot may react with to acknowledge a Slack message, org-wide. Add names from the workspace's emoji
        (custom and standard). Remove every chip to restore the built-in rotation.
      </p>
    </div>
    <div class="body">
      <div id="ack-emoji-chips" style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center">
        ${emojiChips(s)}<span style="position: relative; display: inline-block">
          <button type="button" id="ack-emoji-open" @click=${() => toggleEmoji(s)} class="ghost" aria-haspopup="true">
            + Add emoji
          </button>
          <div class=${classMap({ "emoji-picker": true, hidden: !emoji.open })} id="ack-emoji-picker">
            <input
              type="text"
              id="ack-emoji-search"
              .value=${emoji.query}
              @input=${(e: Event) => {
                emoji.query = (e.target as HTMLInputElement).value;
                s.render();
              }}
              @keydown=${(e: KeyboardEvent) => emojiKey(e, s)}
              placeholder="Search emoji"
              autocomplete="off"
            />
            <div class="emoji-picker-scroll" id="ack-emoji-results">${emojiResults(s)}</div>
          </div>
        </span>
      </div>
    </div>
    ${saveFooter(s, "Save", !s.available)}
  </section>`;
};
cards["card-connectors"] = () => {
  const s = connectors;
  return html`<section class="card" id="card-connectors">
    <div class="head">
      <h2>OAuth apps</h2>
      <p>
        Each connector needs its own OAuth app's client ID and secret before anyone can link it. A connector stays
        hidden in everyone's web UI until you set its client here. The secret is write-only and never displayed. Applies
        org-wide.
      </p>
    </div>
    <div class="body">
      <div id="conn-list" class=${connectors.displayed.length ? "" : "hint"}>${connectorRows()}</div>
    </div>
    <div
      class=${classMap({ body: true, hidden: !s.editor })}
      id="conn-editor"
      style="border-top: 1px solid var(--border, #2a2a2a); padding-top: 12px"
    >
      <div class="sc-form-head">
        <p class="hint" id="conn-form-title">
          ${s.editing ? "Editing " + context.connectorName(s.editing) : "Add a connector"}
        </p>
        <span class=${"badge " + (s.editing ? "info" : "muted")} id="conn-form-mode"
          >${s.editing ? "Editing" : "New"}</span
        >
      </div>
      <label style="display: block; margin-bottom: 8px"
        >Connector
        <select id="conn-provider" style="width: 100%"></select
      ></label>
      <div id="conn-guide" class="hint" style="margin: 0 0 12px">${connectorGuide()}</div>
      <label style="display: block; margin-bottom: 8px"
        >Client ID
        <input
          type="text"
          id="conn-client-id"
          .value=${s.draft.clientId}
          @input=${(e: Event) => s.change("clientId", (e.target as HTMLInputElement).value)}
          autocomplete="off"
          placeholder="OAuth client ID"
          style="width: 100%"
      /></label>
      <label style="display: block; margin-bottom: 8px"
        >Client secret
        <input
          type="password"
          id="conn-client-secret"
          .value=${s.draft.clientSecret}
          @input=${(e: Event) => s.change("clientSecret", (e.target as HTMLInputElement).value)}
          autocomplete="off"
          placeholder=${s.editing && s.list.find((c) => c.provider === s.editing)?.hasSecret ? "•••• set (re-enter to replace)" : "(write-only)"}
          style="width: 100%"
      /></label>
      <p class="field-hint" id="conn-secret-hint">
        ${s.editing ? "Saving requires the client secret. Re-enter it to keep this connector working." : "Secret values are write-only and will not be displayed after saving."}
      </p>
      <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; margin-bottom: 10px"
        ><input
          type="checkbox"
          id="conn-enabled"
          style="width: auto"
          .checked=${s.draft.enabled}
          @change=${(e: Event) => s.change("enabled", (e.target as HTMLInputElement).checked)}
        />
        Enabled</label
      >
    </div>
    <div class="foot">
      <button type="button" id="add-oauth-app" class=${s.editor ? "hidden" : ""} @click=${() => openConnector()}>
        + Add OAuth app</button
      ><button
        class=${classMap({ primary: true, hidden: !s.editor })}
        id="conn-save"
        ?disabled=${s.saving}
        @click=${() => s.save()}
      >
        ${s.editing ? "Save changes" : "Save connector"}</button
      ><button class=${s.editor ? "" : "hidden"} id="conn-reset" @click=${() => s.reset()}>Cancel</button
      >${settingStatus(s, "st-connectors")}
    </div>
  </section>`;
};
cards["card-slack-installation"] = () => {
  const s = installation,
    d = s.data;
  return html`<section class="card sv-slack-settings" id="card-slack-installation">
    <div class="head">
      <h2>Slack</h2>
    </div>
    <div class="body">
      <div class="slack-connection">
        <div class="slack-connection-info">
          <h3 id="slack-installation-state">${installationTitle(d)}</h3>
          <p class="hint" id="slack-installation-description">${installationDescription(d)}</p>
        </div>
        <div class="slack-connection-actions">
          <button
            class=${d.installAvailable ? "" : "hidden"}
            id="slack-installation-start"
            ?disabled=${!!s.busy || (d.configured && d.source === "admin")}
            title=${d.configured && d.source === "admin" ? "Remove your current connection before switching to the hosted app." : ""}
            @click=${() => s.start()}
          >
            <svg width="20" height="20" viewBox="0 0 127 127" aria-hidden="true" focusable="false">
              <path
                d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z"
                fill="#E01E5A"
              />
              <path
                d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z"
                fill="#36C5F0"
              />
              <path
                d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z"
                fill="#2EB67D"
              />
              <path
                d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z"
                fill="#ECB22E"
              />
            </svg>
            <span id="slack-installation-start-label">${d.configured ? "Re-add to Slack" : "Add to Slack"}</span>
          </button>
          <button
            class=${classMap({ danger: true, hidden: !d.configured })}
            id="slack-installation-delete"
            ?disabled=${!d.configured || !!s.busy}
            @click=${() => s.remove()}
          >
            Disconnect
          </button>
        </div>
      </div>
      <details
        id="slack-own-app-guide"
        .open=${s.guide}
        @toggle=${(e: Event) => {
          s.guide = (e.target as HTMLDetailsElement).open;
        }}
      >
        <summary>
          <span id="slack-own-app-label">${d.installAvailable ? "Use your own Slack app" : "Set up Slack"}</span>
          <span class="slack-guide-arrow" aria-hidden="true">›</span>
        </summary>
        <p>
          Give your bot its own name and identity. Start with our preconfigured manifest, then connect your app below.
        </p>
        <ol>
          <li>
            <a
              id="slack-installation-create"
              href=${d.createUrl || "https://api.slack.com/apps?new_app=1"}
              target="_blank"
              rel="noopener noreferrer"
              >Create your preconfigured Slack app ↗</a
            >. Choose your company workspace, review the permissions, and click <strong>Create</strong>. The manifest
            sets up the bot, message events, buttons, and Socket Mode for you.
          </li>
          <li>
            In <strong>OAuth &amp; Permissions</strong>, click <strong>Install to Workspace</strong> and approve access.
            Copy the <strong>Bot User OAuth Token</strong> starting with <code>xoxb-</code>.
          </li>
          <li>
            In <strong>Basic Information → App-Level Tokens</strong>, click <strong>Generate Token and Scopes</strong>.
            Name it <strong>QM connection</strong>, add <code>connections:write</code>, and generate it. Copy the token
            starting with <code>xapp-</code>.
          </li>
          <li>
            Paste both tokens below and click <strong>Validate and connect</strong>. Keep this page open while you work
            in Slack. Tokens must come from the same app.
          </li>
          <li>
            Invite your new bot to a channel, mention it, then send it a DM to check both surfaces. It only sees
            conversations it can access; older history may be incomplete.
          </li>
        </ol>
        <p class="hint">
          Replacing a connected app changes the bot identity. Invite the new bot to your channels and start a new DM
          with it. The old app stays installed until a workspace admin removes it.
          <span id="slack-hosted-switch" class=${d.installAvailable ? "" : "hidden"}
            >To switch back to the QM app, disconnect here first, then choose Add to Slack.</span
          >
        </p>
        <button
          type="button"
          id="slack-enter-tokens"
          @click=${() => {
            s.editor = true;
            s.render();
            document.getElementById("slack-bot-token")?.focus();
            document.getElementById("card-slack-installation")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          I have both tokens
        </button>
        <div class=${s.editor ? "" : "hidden"} id="slack-token-editor">
          <label style="display: block; margin-bottom: 8px"
            >Bot User OAuth Token
            <input
              type="password"
              id="slack-bot-token"
              .value=${s.botToken}
              @input=${(e: Event) => {
                s.botToken = (e.target as HTMLInputElement).value;
                s.revision++;
              }}
              autocomplete="off"
              placeholder="xoxb-…"
              style="width: 100%"
          /></label>
          <label style="display: block; margin-bottom: 8px"
            >App-Level Token
            <input
              type="password"
              id="slack-app-token"
              .value=${s.appToken}
              @input=${(e: Event) => {
                s.appToken = (e.target as HTMLInputElement).value;
                s.revision++;
              }}
              autocomplete="off"
              placeholder="xapp-…"
              style="width: 100%"
          /></label>
          <p class="field-hint">
            Use an app-level token with <code>connections:write</code>. Saving activates or reloads the Slack surface
            within a few seconds.
          </p>
          <button
            class=${classMap({ primary: true, hidden: !s.editor })}
            id="slack-installation-save"
            ?disabled=${!!s.busy}
            @click=${() => s.save()}
          >
            Validate and connect
          </button>
        </div>
      </details>
      <span class=${"status " + s.tone} role="status" id="st-slack-installation">${s.message}</span>
    </div>
  </section>`;
};
function overrideCount(s: SlackSetting) {
  const n = s.collect().members!.length;
  return n ? n + " override" + (n === 1 ? "" : "s") : "No overrides configured.";
}
function openConnector(connector?: Parameters<typeof connectors.edit>[0]) {
  connectors.edit(connector);
  document.getElementById("conn-client-id")?.focus();
  document
    .getElementById("card-connectors")
    ?.scrollIntoView({ behavior: "smooth", block: connector ? "nearest" : "start" });
}
function badge(text: string, tone: string) {
  return html`<span class=${"badge " + tone}>${text}</span>`;
}
function connectorRows() {
  if (!connectors.displayed.length) return "No connectors configured. Add one below to make it linkable in the web UI.";
  return repeat(
    connectors.displayed,
    (c) => c.provider,
    (c) =>
      html`<div class=${classMap({ "credential-row": true, "is-editing": c.provider === connectors.editing })}>
        <div class="credential-main">
          <div class="credential-title">
            <strong>${context.connectorName(c.provider)}</strong><span class="credential-slug">${c.provider}</span>
          </div>
          <div class="hint">
            ${c.inherited ? "Configured by deployment secrets" : "client " + (c.clientId || "None") + (c.updatedBy ? " · by " + c.updatedBy : "") + (c.updatedAt ? " · " + context.fmtTime(c.updatedAt) : "")}
          </div>
          <div class="credential-badges">
            ${badge(c.enabled === false ? "Disabled" : "Enabled", c.enabled === false ? "warn" : "ok")}${badge(c.inherited || c.hasSecret ? "Secret set" : "Secret missing", c.inherited || c.hasSecret ? "ok" : "err")}
          </div>
        </div>
        <div class="credential-actions">
          ${c.inherited ? html`<button type="button" @click=${() => openConnector(c)}>Override here</button>` : html`<button type="button" @click=${() => openConnector(c)}>Edit</button><button type="button" class="rowbtn danger" title="Delete connector" aria-label=${"Delete " + context.connectorName(c.provider)} @click=${() => connectors.remove(c.provider)}>Delete</button>`}
        </div>
      </div>`,
  );
}
function connectorGuide() {
  const c = connectors.catalog.find((c) => c.provider === connectors.draft.provider);
  if (!c?.setupGuide) return nothing;
  return html`<a href=${c.setupGuide.url} target="_blank" rel="noopener noreferrer"
      >${"Open " + c.setupGuide.console + " ↗"}</a
    >
    <div>${"Callback URL: " + location.origin + "/v1/connectors/oauth/" + c.redirectPath}</div>
    <div>${c.scopes?.length ? "Scopes: " + c.scopes.join(", ") : "Scopes are selected in the provider."}</div>
    <ol>
      ${c.setupGuide.steps.map((step) => html`<li>${step}</li>`)}
    </ol>`;
}
function builtIns() {
  return html`<section class="card" id="card-built-in-connectors">
    <div class="head"><h2>Built-in connectors</h2></div>
    <div class=${connectors.catalog.length ? "" : "hint"} id="built-in-connectors">
      ${
        connectors.catalog.length
          ? repeat(
              connectors.catalog,
              (c) => c.provider,
              (c) =>
                html`<div class="credential-row">
                  <div class="credential-main">
                    <strong>${context.connectorName(c.provider)}</strong>
                    <div class="hint">${c.configured ? "Available to users" : "Requires an OAuth app"}</div>
                  </div>
                  ${badge(c.configured ? "Configured" : "Not configured", c.configured ? "ok" : "muted")}
                </div>`,
            )
          : "No built-in connectors are available."
      }
    </div>
  </section>`;
}
function emojiChanged(s: SlackSetting, names: string[]) {
  s.change({ names });
  (document.querySelector('[data-save="ack-emoji"]') as HTMLButtonElement | null)?.click();
}
function emojiChips(s: SlackSetting) {
  return repeat(
    s.draft.names || [],
    (name: string) => name,
    (name: string) =>
      html`<span
        data-chip=${name}
        style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--border, #d4d4d4);border-radius:999px;font-size:13px"
        ><span
          >${emoji.catalog[name] ? html`<img src=${emoji.catalog[name]} alt=${name} class="ack-emoji-img" style="margin-right:4px" />` : (emoji.standard.find((e) => e[0] === name)?.[1] || "") + " "}${":" + name + ":"}</span
        ><button
          type="button"
          aria-label=${"Remove " + name}
          style="border:0;background:none;cursor:pointer;padding:0;font-size:14px;line-height:1"
          @click=${() =>
            emojiChanged(
              s,
              s.draft.names.filter((v: string) => v !== name),
            )}
        >
          ×
        </button></span
      >`,
  );
}
function emojiResults(s: SlackSetting) {
  if (emoji.error) return html`<div class="emoji-picker-empty">${emoji.error}</div>`;
  const q = emoji.query.trim().toLowerCase().replace(/:/g, ""),
    taken = new Set(s.draft.names || []),
    sections = new Map<string, string[][]>();
  const custom = Object.keys(emoji.catalog)
    .filter((n) => !taken.has(n) && (!q || n.includes(q)))
    .sort();
  if (custom.length)
    sections.set(
      "Custom",
      custom.map((n) => [n, ""]),
    );
  for (const entry of emoji.standard) {
    if (taken.has(entry[0]) || emoji.catalog[entry[0]] || (q && !entry[0].includes(q))) continue;
    if (!sections.has(entry[2])) sections.set(entry[2], []);
    sections.get(entry[2])!.push(entry);
  }
  if (!sections.size)
    return html`<div class="emoji-picker-empty">${"No emoji match “" + emoji.query.trim() + "”"}</div>`;
  return [...sections].map(
    ([title, entries]) =>
      html`<div class="emoji-picker-section">${title}</div>
        <div class="emoji-picker-grid">
          ${entries.map(
            ([name, glyph]) =>
              html`<button
                type="button"
                title=${":" + name + ":"}
                aria-label=${name}
                @click=${() => {
                  emoji.open = false;
                  emojiChanged(s, [...s.draft.names, name]);
                }}
              >
                ${emoji.catalog[name] ? html`<img src=${emoji.catalog[name]} alt=${name} loading="lazy" />` : glyph}
              </button>`,
          )}
        </div>`,
  );
}
function toggleEmoji(s: SlackSetting) {
  emoji.open = !emoji.open;
  emoji.query = "";
  s.render();
  if (emoji.open) document.getElementById("ack-emoji-search")?.focus();
}
function emojiKey(event: KeyboardEvent, s: SlackSetting) {
  if (event.key === "Escape") {
    event.preventDefault();
    emoji.open = false;
    s.render();
  }
  if (event.key === "Enter") {
    event.preventDefault();
    (document.querySelector("#ack-emoji-results button") as HTMLButtonElement | null)?.click();
  }
}
export function mountCards() {
  for (const [id, template] of Object.entries(cards)) {
    const placeholder = document.querySelector('[data-integrations-card="' + id + '"]');
    if (!placeholder) continue;
    const fragment = document.createDocumentFragment();
    const draw = () => render(template(), fragment);
    if (id === "card-connectors") connectors.render = draw;
    else if (id === "card-slack-installation") installation.render = draw;
    else {
      const key = (
        {
          "card-external-slack": "external-slack-participants",
          "card-internal-member-overrides": "internal-member-overrides",
          "card-channel-header-pin-default": "channel-header-pin-default",
          "card-ack-emoji": "ack-emoji",
        } as Record<string, string>
      )[id];
      states.get(key)!.render = draw;
    }
    draw();
    placeholder.replaceWith(fragment);
  }
  document.addEventListener("mousedown", (event) => {
    if (emoji.open && !(event.target as Element).closest("#ack-emoji-picker, #ack-emoji-open")) {
      emoji.open = false;
      states.get("ack-emoji")!.render();
    }
  });
}
export function mountBuiltIns() {
  const target = document.getElementById("card-built-in-connectors");
  if (!target) return;
  const fragment = document.createDocumentFragment(),
    previous = connectors.render;
  const draw = () => render(builtIns(), fragment);
  draw();
  target.replaceWith(fragment);
  connectors.render = () => {
    previous();
    draw();
  };
}

function installationTitle(data: Record<string, any>) {
  if (data.configured) return data.teamName || data.teamId || "Slack workspace";
  return data.source === "invalid_environment" ? "Finish connecting your app" : "Connect your workspace";
}
function installationDescription(data: Record<string, any>) {
  if (data.configured) return data.source === "service" ? "QM app" : "Custom app";
  return data.installAvailable
    ? "Add the QM app or connect your own below."
    : "Create a Slack app from our manifest, then connect it here.";
}
