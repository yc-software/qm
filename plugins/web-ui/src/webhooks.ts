import { html, nothing, render, type TemplateResult } from "lit";
import { Check, ChevronDown, Plus } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { actionSnippet, closeFormMenus, copyText, relTime, setFormMenuValue, toggleFormMenu } from "./ui";
import { icon } from "./icons";
import { artifactPage, detailTpl, fieldTpl, listBackLink, listPageTpl, showPane, textBtn } from "./list-page";
import { scopeChip } from "./contexts";
import { deepLinkPath, UI_BASE } from "./deep-link";

interface WebhookView {
  id: string;
  ownerScopeId: string;
  action: string;
  verification: { scheme: string; secret?: string };
  filters?: Array<{ path: string; in: string[] }>;
  destination?: { type: string; target: string } | null;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
  lastDeliveryId?: string;
  lastError?: string;
  url: string;
}

type WebhookScheme = "hmac-sha256" | "github" | "slack" | "stripe" | "linear";

const WEBHOOK_SCHEMES: Array<{ value: WebhookScheme; label: string; guidance: string }> = [
  ["hmac-sha256", "Generic HMAC-SHA256", "Send the digest in X-Signature as hex or sha256=<hex>."],
  ["github", "GitHub", "Use this URL as the payload URL and the signing secret as GitHub's webhook secret."],
  ["slack", "Slack", "Use the Slack app signing secret. Requests older than five minutes are rejected."],
  ["stripe", "Stripe", "Use the endpoint signing secret shown by Stripe for this destination."],
  ["linear", "Linear", "Use the webhook signing secret shown by Linear. Payloads older than one minute are rejected."],
].map(([value, label, guidance]) => ({ value: value as WebhookScheme, label: label!, guidance: guidance! }));

let webhookList: WebhookView[] = [];
const page = artifactPage("webhooks", "webhooks-page");

export function openWebhookById(id: string): void {
  page.pending = id;
}

export function routeWebhooksHistory(webhookId: string | null): void {
  page.route(webhookId, findWebhook, openWebhook, drawWebhooksPage);
}

function findWebhook(id: string): WebhookView | undefined {
  return webhookList.find((w) => w.id === id);
}

function refreshWebhooks(showLoading = false): Promise<boolean> {
  return page.refresh(
    async () => {
      webhookList = (await api<{ webhooks: WebhookView[] }>("/api/webhooks")).webhooks ?? [];
    },
    "Failed to load webhooks.",
    showLoading,
  );
}

export async function renderWebhooksPage(): Promise<void> {
  await page.show({
    load: () => refreshWebhooks(webhookList.length === 0),
    find: findWebhook,
    open: openWebhook,
    draw: drawWebhooksPage,
    missing: "That webhook wasn't found, or you don't have access to it.",
  });
}

function drawWebhooksPage(): void {
  page.syncUrl(null);
  const rows = webhookList
    .filter((w) => page.inScope(w.ownerScopeId) && page.matches(`${w.action} ${w.verification.scheme}`))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(webhookPageRow);
  page.paint(
    listPageTpl({
      title: "Webhooks",
      scope: page.scope,
      onScope: (s) => {
        page.scope = s;
        drawWebhooksPage();
      },
      action: { label: "New webhook", onClick: showNewWebhook },
      search: page.search("Search webhooks", drawWebhooksPage),
      rows: [...page.flashRows(), ...rows],
      empty: page.emptyText("webhooks", webhookList.length === 0),
    }),
    drawWebhooksPage,
  );
}

function webhookPageRow(w: WebhookView): TemplateResult {
  let lastRun = "never fired";
  if (w.lastError) lastRun = "error";
  else if (w.lastFiredAt) lastRun = relTime(w.lastFiredAt);
  return page.link(
    w.id,
    "list-row",
    () => openWebhook(w, { push: true }),
    html`<span class="list-row-title" dir="auto">${actionSnippet(w.action)}</span>
      <span class="list-row-meta">
        ${scopeChip(w.ownerScopeId)}
        <span class="badge">${w.verification.scheme}</span>
        <span class="badge">${w.enabled ? "enabled" : "disabled"}</span>
        <span class="list-row-date">${lastRun}</span>
      </span>`,
  );
}

function copyField(label: string, text: string, hint: string | TemplateResult): TemplateResult {
  return html`<div class="field">
    <label>${label}</label>
    <div class="copyrow">
      <code class="mono">${text}</code>
      <button class="btn" @click=${(e: Event) => void copyText(text, e.currentTarget as HTMLButtonElement)}>
        <span>Copy</span>
      </button>
    </div>
    <div class="hint">${hint}</div>
  </div>`;
}

function openWebhook(w: WebhookView, opts: { push?: boolean } = {}): void {
  page.syncUrl(w.id, opts.push);
  const eventsHost = document.createElement("section");
  const notice = page.notice || page.takeFlash();
  page.notice = "";
  showPane(
    "",
    detailTpl({
      back: "Webhooks",
      onBack: drawWebhooksPage,
      title: "Webhook",
      heading: textBtn("New webhook", Plus, showNewWebhook),
      notice,
      body: html`
        ${fieldTpl("Context", scopeChip(w.ownerScopeId))} ${fieldTpl("Action", w.action, "pre")}
        ${fieldTpl("Verification", w.verification.scheme)} ${fieldTpl("Status", w.enabled ? "Enabled" : "Disabled")}
        ${copyField("Inbound URL", w.url, "Configure your sender (GitHub / Stripe / Slack / …) to POST events here.")}
        ${w.filters?.length ? fieldTpl("Filters", w.filters.map((f) => `${f.path} ∈ [${f.in.join(", ")}]`).join("\n"), "pre") : nothing}
        ${w.destination ? fieldTpl("Destination", `${w.destination.type} → ${w.destination.target}`) : nothing}
        ${fieldTpl("Last fired", w.lastFiredAt ? new Date(w.lastFiredAt).toLocaleString() : "Never")}
        ${w.lastDeliveryId ? fieldTpl("Last delivery ID", w.lastDeliveryId, "mono") : nothing}
        ${w.lastError ? fieldTpl("Last error", w.lastError, "error") : nothing} ${eventsHost}
        <div class="actions">
          ${
            w.enabled
              ? html`<button class="btn danger" @click=${() => void setWebhookEnabled(w.id, false)}>Disable</button>`
              : html`<button class="btn" @click=${() => void setWebhookEnabled(w.id, true)}>Re-enable</button>`
          }
        </div>
      `,
    }),
  );
  void loadWebhookEvents(w.id, eventsHost);
}

interface WebhookEventView {
  receivedAt: number;
  payload: string;
  sessionId?: string;
}

async function loadWebhookEvents(id: string, host: HTMLElement): Promise<void> {
  const show = (body: TemplateResult) =>
    render(
      html`<h3>Message history</h3>
        ${body}`,
      host,
    );
  show(html`<p class="hint" role="status">Loading messages…</p>`);
  try {
    const { events } = await api<{ events: WebhookEventView[] }>(`/api/webhooks/${encodeURIComponent(id)}/events`);
    if (!host.isConnected) return;
    show(html`
      <p class="hint">
        Latest 50 accepted events. Payloads show what was passed to the agent, capped at 16,000 characters. Earlier
        events are not backfilled.
      </p>
      ${
        events.length
          ? events.map(
              (event) => html`
                <details class="code-card">
                  <summary class="tool-payload-label">
                    <time datetime=${new Date(event.receivedAt).toISOString()}
                      >${new Date(event.receivedAt).toLocaleString()}</time
                    >
                  </summary>
                  <pre class="tool-payload-body">${event.payload}</pre>
                  <div class="code-card-foot">
                    ${event.sessionId ? html`<a class="btn" href=${deepLinkPath(UI_BASE, "chats", event.sessionId)}>Open session</a>` : html`<span class="hint">No session available.</span>`}
                  </div>
                </details>
              `,
            )
          : html`<p class="hint">No messages recorded yet.</p>`
      }
    `);
  } catch (error) {
    if (!host.isConnected) return;
    show(
      html`<p role="alert">${errMessage(error, "Couldn't load messages.")}</p>
        <button class="btn" @click=${() => void loadWebhookEvents(id, host)}>Retry</button>`,
    );
  }
}

async function setWebhookEnabled(id: string, enabled: boolean): Promise<void> {
  await page.attempt(
    () => api(`/api/webhooks/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
    enabled ? "Couldn't re-enable webhook." : "Couldn't disable webhook.",
    enabled ? "Webhook re-enabled." : "Webhook disabled.",
  );
  await refreshWebhooks();
  page.notice = page.takeFlash();
  const w = findWebhook(id);
  if (w) openWebhook(w);
  else drawWebhooksPage();
}

function webhookForm() {
  return html`
    <form class="resource-form" @submit=${onCreateWebhook}>
      ${listBackLink("Webhooks", drawWebhooksPage)}
      <h2>New webhook</h2>
      <label
        >Action <span class="hint">(what the agent should do for each event)</span>
        <textarea
          name="action"
          rows="4"
          placeholder="When a GitHub issue is opened, triage it and post a one-paragraph summary."
          required
        ></textarea>
      </label>
      <label>
        Verification scheme
        <div class="menu-control form-menu-control scheme-control">
          <input type="hidden" name="scheme" value="hmac-sha256" />
          <button class="menu-button" type="button" aria-haspopup="menu" aria-expanded="false" @click=${toggleFormMenu}>
            <span class="menu-label">hmac-sha256</span>
            ${icon(ChevronDown, 14)}
          </button>
          <div class="menu-popover" role="menu" hidden>
            <div class="menu-title">Verification</div>
            ${WEBHOOK_SCHEMES.map(
              (scheme) => html`
                <button
                  class="menu-option ${scheme.value === "hmac-sha256" ? "active" : ""}"
                  type="button"
                  data-value=${scheme.value}
                  role="menuitemradio"
                  aria-checked=${scheme.value === "hmac-sha256" ? "true" : "false"}
                  @click=${(e: Event) => selectWebhookScheme(e, scheme.value)}
                >
                  <span>${scheme.label}</span>
                  ${scheme.value === "hmac-sha256" ? icon(Check, 15) : nothing}
                </button>
              `,
            )}
          </div>
        </div>
        <span class="hint webhook-scheme-guidance">${WEBHOOK_SCHEMES[0]!.guidance}</span>
      </label>
      <label
        >Signing secret <span class="hint">(leave blank to auto-generate)</span>
        <div class="copyrow">
          <input type="text" name="secret" placeholder="auto-generated if blank" />
          <button type="button" class="btn" @click=${fillGeneratedSecret}>Generate</button>
        </div>
      </label>
      <label
        >Filters <span class="hint">(optional; one per line as <code>path: value1, value2</code>)</span>
        <textarea name="filters" rows="2" placeholder="action: opened, reopened"></textarea>
      </label>
      <p class="hint">
        The event runs in your personal context. After creation, ask the agent to route notable results to a teammate or
        channel by name.
      </p>
      <div class="form-error"></div>
      <div class="actions"><button class="btn primary" type="submit">Create webhook</button></div>
    </form>
  `;
}

function showNewWebhook(): void {
  showPane("", webhookForm());
}

function selectWebhookScheme(e: Event, scheme: WebhookScheme): void {
  e.stopPropagation();
  const control = (e.currentTarget as HTMLElement).closest(".scheme-control") as HTMLElement | null;
  const found = WEBHOOK_SCHEMES.find((s) => s.value === scheme);
  setFormMenuValue(control, scheme, found?.label ?? scheme);
  const guidance = control?.closest("form")?.querySelector(".webhook-scheme-guidance");
  if (guidance) guidance.textContent = found?.guidance ?? "";
  closeFormMenus();
}

function fillGeneratedSecret(e: Event): void {
  const form = (e.currentTarget as HTMLElement).closest("form");
  const secret = form?.querySelector('input[name="secret"]') as HTMLInputElement | null;
  if (secret && !secret.disabled)
    secret.value = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
}

function parseWebhookFilters(text: string): Array<{ path: string; in: string[] }> {
  const out: Array<{ path: string; in: string[] }> = [];
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (!line.trim()) continue;
    if (idx < 1) throw new Error(`Invalid filter: "${line}". Use path: value1, value2.`);
    const path = line.slice(0, idx).trim();
    const values = line
      .slice(idx + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!path || values.length === 0) throw new Error(`Invalid filter: "${line}". Both path and value are required.`);
    out.push({ path, in: values });
  }
  return out;
}

async function onCreateWebhook(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const errSlot = form.querySelector(".form-error") as HTMLElement;
  const field = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | HTMLTextAreaElement).value;
  const action = field("action").trim();
  const secret = field("secret").trim();
  errSlot.textContent = action ? "" : "An action is required.";
  if (!action) return;
  let stage = "Invalid filters.";
  try {
    const filters = parseWebhookFilters(field("filters"));
    stage = "create failed";
    const r = await api<{ webhook: WebhookView; url: string }>("/api/webhooks", {
      method: "POST",
      body: JSON.stringify({
        action,
        verification: { scheme: field("scheme") || "hmac-sha256", ...(secret ? { secret } : {}) },
        ...(filters.length ? { filters } : {}),
      }),
    });
    await refreshWebhooks();
    showWebhookCreated(r.webhook, r.url);
  } catch (err) {
    errSlot.textContent = errMessage(err, stage);
  }
}

function showWebhookCreated(w: WebhookView, url: string): void {
  const secret = w.verification.secret;
  showPane(
    "",
    html`
      <div class="resource-detail">
        ${listBackLink("Webhooks", drawWebhooksPage)}
        <h2>Webhook created ✓</h2>
        <div class="warn">Copy the secret now. It won't be shown again.</div>
        ${copyField("Inbound URL", url, "Point your sender at this URL.")}
        ${
          secret && secret !== "***"
            ? copyField(
                "Signing secret",
                secret,
                html`Configure your sender to sign requests with this secret (scheme: ${w.verification.scheme}).`,
              )
            : html`<div class="field">
                <div class="hint">No signing secret for scheme <code>${w.verification.scheme}</code>.</div>
              </div>`
        }
        <div class="actions">
          <button class="btn" @click=${() => openWebhook(findWebhook(w.id) ?? w)}>Done</button>
        </div>
      </div>
    `,
  );
}
