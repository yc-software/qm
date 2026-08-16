import { html, nothing, render, type TemplateResult } from "lit";
import { Check, ChevronDown, Plus } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { actionSnippet, closeFormMenus, copyText, icon, relTime, setFormMenuValue, toggleFormMenu } from "./ui";
import { listBackLink, listPageTpl } from "./list-page";
import { ensureContexts, scopeChip } from "./contexts";
import { appState } from "./shell";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";

export interface WebhookView {
  id: string;
  ownerScopeId: string;
  owner: string;
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

type WebhookScheme = "hmac-sha256" | "github" | "slack" | "stripe";

const WEBHOOK_SCHEMES: Array<{ value: WebhookScheme; label: string; guidance: string }> = [
  {
    value: "hmac-sha256",
    label: "Generic HMAC-SHA256",
    guidance: "Send the digest in X-Signature as hex or sha256=<hex>.",
  },
  {
    value: "github",
    label: "GitHub",
    guidance: "Use this URL as the payload URL and the signing secret as GitHub's webhook secret.",
  },
  {
    value: "slack",
    label: "Slack",
    guidance: "Use the Slack app signing secret. Requests older than five minutes are rejected.",
  },
  {
    value: "stripe",
    label: "Stripe",
    guidance: "Use the endpoint signing secret shown by Stripe for this destination.",
  },
];

let webhookList: WebhookView[] = [];
let webhooksScope: string | null = null;
let webhooksPageHost: HTMLElement | null = null;
let webhooksLoading = false;
let webhooksNotice = "";
let webhooksSearch = "";
let webhookRefreshSeq = 0;
let pendingWebhookId: string | null = null;
let webhooksNoticeSticky = "";

export function resetActiveWebhook(): void {
  webhooksScope = null;
}

export function openWebhookById(id: string): void {
  pendingWebhookId = id;
}

function syncWebhookUrl(webhookId: string | null, push = false): void {
  if (appState.currentView !== "webhooks") return;
  const next = deepLinkPath(UI_BASE, "webhooks", null, null, webhookId);
  if (`${location.pathname}${location.search}` === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

export function routeWebhooksHistory(webhookId: string | null): void {
  if (appState.currentView !== "webhooks") return;
  const webhook = webhookId ? webhookList.find((w) => w.id === webhookId) : undefined;
  if (webhook) openWebhook(webhook);
  else drawWebhooksPage();
}

async function refreshWebhooks(opts: { showLoading?: boolean } = {}): Promise<boolean> {
  const seq = ++webhookRefreshSeq;
  if (opts.showLoading) {
    webhooksLoading = true;
    webhooksNotice = "";
  }
  try {
    const r = await api<{ webhooks: WebhookView[] }>("/api/webhooks");
    if (seq !== webhookRefreshSeq) return false;
    webhookList = r.webhooks ?? [];
    webhooksNotice = "";
    return true;
  } catch (e) {
    if (seq !== webhookRefreshSeq) return false;
    webhooksNotice = errMessage(e, "Failed to load webhooks.");
    return false;
  } finally {
    if (seq === webhookRefreshSeq) webhooksLoading = false;
  }
}

export async function renderWebhooksPage(): Promise<void> {
  if (appState.currentView !== "webhooks") return;
  await ensureContexts();
  drawWebhooksPage();
  const loaded = await refreshWebhooks({ showLoading: webhookList.length === 0 });
  const wanted = pendingWebhookId;
  pendingWebhookId = null;
  if (appState.currentView !== "webhooks") return;
  if (!loaded) return drawWebhooksPage();
  const webhook = wanted ? webhookList.find((w) => w.id === wanted) : undefined;
  if (wanted && !webhook) {
    webhooksNoticeSticky = "That webhook wasn't found, or you don't have access to it.";
  }
  if (webhook) openWebhook(webhook);
  else drawWebhooksPage();
}

function drawWebhooksPage(): void {
  if (appState.currentView !== "webhooks" || !appState.mainEl) return;
  syncWebhookUrl(null);
  if (!webhooksPageHost || webhooksPageHost.parentElement !== appState.mainEl) {
    webhooksPageHost = document.createElement("div");
    webhooksPageHost.className = "pane webhooks-page";
    appState.mainEl.replaceChildren(webhooksPageHost);
  }
  const rows = [...webhookList]
    .filter((w) => (webhooksScope ? w.ownerScopeId === webhooksScope : true))
    .filter(
      (w) =>
        !webhooksSearch.trim() ||
        `${w.action} ${w.verification.scheme}`.toLowerCase().includes(webhooksSearch.trim().toLowerCase()),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((w) => webhookPageRow(w));
  let empty = "No webhooks yet.";
  if (webhooksNotice) empty = webhooksNotice;
  else if (webhooksLoading && webhookList.length === 0) empty = "Loading webhooks…";
  else if (webhooksScope) empty = "No webhooks in this context.";
  const noticeRow = webhooksNoticeSticky ? [html`<div class="action-notice">${webhooksNoticeSticky}</div>`] : [];
  webhooksNoticeSticky = "";
  render(
    listPageTpl({
      title: "Webhooks",
      scope: webhooksScope,
      onScope: (s) => {
        webhooksScope = s;
        drawWebhooksPage();
      },
      onRefresh: () => void renderWebhooksPage(),
      action: { label: "New webhook", onClick: showNewWebhook },
      search: {
        value: webhooksSearch,
        placeholder: "Search webhooks",
        onInput: (value) => {
          webhooksSearch = value;
          drawWebhooksPage();
        },
      },
      rows: [...noticeRow, ...rows],
      empty,
    }),
    webhooksPageHost,
  );
}

function webhookPageRow(w: WebhookView): TemplateResult {
  let lastRun = "never fired";
  if (w.lastError) lastRun = "error";
  else if (w.lastFiredAt) lastRun = relTime(w.lastFiredAt);
  return html`
    <a
      class="list-row"
      href=${deepLinkPath(UI_BASE, "webhooks", null, null, w.id)}
      @click=${(event: MouseEvent) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        openWebhook(w, { push: true });
      }}
    >
      <span class="list-row-title" dir="auto">${actionSnippet(w.action)}</span>
      <span class="list-row-meta">
        ${scopeChip(w.ownerScopeId)}
        <span class="badge">${w.verification.scheme}</span>
        <span class="badge">${w.enabled ? "enabled" : "disabled"}</span>
        <span class="list-row-date">${lastRun}</span>
      </span>
    </a>
  `;
}

function copyRow(text: string) {
  return html`
    <div class="copyrow">
      <code class="mono">${text}</code>
      <button class="btn" @click=${(e: Event) => void copyText(text, e.currentTarget as HTMLButtonElement)}>
        Copy
      </button>
    </div>
  `;
}

function openWebhook(w: WebhookView, opts: { push?: boolean } = {}): void {
  if (!appState.mainEl) return;
  syncWebhookUrl(w.id, opts.push);
  const notice = webhooksNotice || webhooksNoticeSticky;
  webhooksNotice = "";
  webhooksNoticeSticky = "";
  const host = document.createElement("div");
  host.className = "resource-pane";
  render(
    html`
      <div class="resource-detail">
        ${listBackLink("Webhooks", drawWebhooksPage)}
        <div class="resource-heading">
          <h2>Webhook</h2>
          <button class="btn" @click=${showNewWebhook}>${icon(Plus, 15)}<span>New webhook</span></button>
        </div>
        ${notice ? html`<div class="action-notice">${notice}</div>` : nothing}
        <div class="field">
          <label>Context</label>
          <div class="value">${scopeChip(w.ownerScopeId)}</div>
        </div>
        <div class="field">
          <label>Action</label>
          <div class="value pre">${w.action}</div>
        </div>
        <div class="field">
          <label>Verification</label>
          <div class="value">${w.verification.scheme}</div>
        </div>
        <div class="field">
          <label>Status</label>
          <div class="value">${w.enabled ? "Enabled" : "Disabled"}</div>
        </div>
        <div class="field">
          <label>Inbound URL</label>
          ${copyRow(w.url)}
          <div class="hint">Configure your sender (GitHub / Stripe / Slack / …) to POST events here.</div>
        </div>
        ${
          w.filters?.length
            ? html`<div class="field">
                <label>Filters</label>
                <div class="value pre">${w.filters.map((f) => `${f.path} ∈ [${f.in.join(", ")}]`).join("\n")}</div>
              </div>`
            : ""
        }
        ${
          w.destination
            ? html`<div class="field">
                <label>Destination</label>
                <div class="value">${w.destination.type} → ${w.destination.target}</div>
              </div>`
            : ""
        }
        <div class="field">
          <label>Last fired</label>
          <div class="value">${w.lastFiredAt ? new Date(w.lastFiredAt).toLocaleString() : "Never"}</div>
        </div>
        ${
          w.lastDeliveryId
            ? html`<div class="field">
                <label>Last delivery ID</label>
                <div class="value mono">${w.lastDeliveryId}</div>
              </div>`
            : nothing
        }
        ${
          w.lastError
            ? html`<div class="field">
                <label>Last error</label>
                <div class="value" style="color:var(--destructive,#c00)">${w.lastError}</div>
              </div>`
            : ""
        }
        <div class="actions">
          ${
            w.enabled
              ? html`<button class="btn danger" @click=${() => void setWebhookEnabled(w.id, false)}>Disable</button>`
              : html`<button class="btn" @click=${() => void setWebhookEnabled(w.id, true)}>Re-enable</button>`
          }
        </div>
      </div>
    `,
    host,
  );
  appState.mainEl.replaceChildren(host);
}

async function setWebhookEnabled(id: string, enabled: boolean): Promise<void> {
  let notice: string;
  try {
    await api(`/api/webhooks/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, { method: "POST" });
    notice = enabled ? "Webhook re-enabled." : "Webhook disabled.";
  } catch (e) {
    notice = errMessage(e, enabled ? "Couldn't re-enable webhook." : "Couldn't disable webhook.");
  }
  await refreshWebhooks();
  webhooksNotice = notice;
  const w = webhookList.find((x) => x.id === id);
  if (w) openWebhook(w);
  else drawWebhooksPage();
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function webhookForm() {
  return html`
    <form class="resource-form" @submit=${onCreateWebhook}>
      ${listBackLink("Webhooks", drawWebhooksPage)}
      <h2>New webhook</h2>
      <label
        >Action <span class="hint">— what the agent should do for each event</span>
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
        >Signing secret <span class="hint">— leave blank to auto-generate</span>
        <div class="copyrow">
          <input type="text" name="secret" placeholder="auto-generated if blank" />
          <button type="button" class="btn" @click=${fillGeneratedSecret}>Generate</button>
        </div>
      </label>
      <label
        >Filters <span class="hint">— optional; one per line as <code>path: value1, value2</code></span>
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
  if (!appState.mainEl) return;
  const host = document.createElement("div");
  host.className = "resource-pane";
  render(webhookForm(), host);
  appState.mainEl.replaceChildren(host);
}

function selectWebhookScheme(e: Event, scheme: WebhookScheme): void {
  e.stopPropagation();
  const control = (e.currentTarget as HTMLElement).closest(".scheme-control") as HTMLElement | null;
  const form = control?.closest("form");
  setFormMenuValue(control, scheme, WEBHOOK_SCHEMES.find((s) => s.value === scheme)?.label ?? scheme);
  applyWebhookScheme(form, scheme);
  closeFormMenus();
}

function applyWebhookScheme(form: Element | null | undefined, scheme: string): void {
  const guidance = form?.querySelector(".webhook-scheme-guidance");
  if (guidance) guidance.textContent = WEBHOOK_SCHEMES.find((candidate) => candidate.value === scheme)?.guidance ?? "";
}

function fillGeneratedSecret(e: Event): void {
  const form = (e.currentTarget as HTMLElement).closest("form");
  const secret = form?.querySelector('input[name="secret"]') as HTMLInputElement | null;
  if (secret && !secret.disabled) secret.value = randomHex(32);
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
  const errSlot = form.querySelector(".form-error") as HTMLElement | null;
  const field = (n: string) =>
    (form.querySelector(`[name="${n}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ??
    "";
  const action = field("action").trim();
  const scheme = field("scheme") || "hmac-sha256";
  const secret = field("secret").trim();
  let filters: Array<{ path: string; in: string[] }>;
  if (errSlot) errSlot.textContent = "";
  if (!action) {
    if (errSlot) errSlot.textContent = "An action is required.";
    return;
  }
  try {
    filters = parseWebhookFilters(field("filters"));
  } catch (err) {
    if (errSlot) errSlot.textContent = errMessage(err, "Invalid filters.");
    return;
  }
  const payload: Record<string, unknown> = {
    action,
    verification: { scheme, ...(secret ? { secret } : {}) },
  };
  if (filters.length) payload.filters = filters;
  try {
    const r = await api<{ webhook: WebhookView; url: string }>("/api/webhooks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await refreshWebhooks();
    showWebhookCreated(r.webhook, r.url);
  } catch (err) {
    if (errSlot) errSlot.textContent = errMessage(err, "create failed");
  }
}

function showWebhookCreated(w: WebhookView, url: string): void {
  if (!appState.mainEl) return;
  const host = document.createElement("div");
  host.className = "resource-pane";
  const secret = w.verification.secret;
  render(
    html`
      <div class="resource-detail">
        ${listBackLink("Webhooks", drawWebhooksPage)}
        <h2>Webhook created ✓</h2>
        <div class="warn">Copy the secret now — it won't be shown again.</div>
        <div class="field">
          <label>Inbound URL</label>
          ${copyRow(url)}
          <div class="hint">Point your sender at this URL.</div>
        </div>
        ${
          secret && secret !== "***"
            ? html`<div class="field">
                <label>Signing secret</label>
                ${copyRow(secret)}
                <div class="hint">
                  Configure your sender to sign requests with this secret (scheme: ${w.verification.scheme}).
                </div>
              </div>`
            : html`<div class="field">
                <div class="hint">No signing secret for scheme <code>${w.verification.scheme}</code>.</div>
              </div>`
        }
        <div class="actions">
          <button class="btn" @click=${() => openWebhook(webhookList.find((x) => x.id === w.id) ?? w)}>Done</button>
        </div>
      </div>
    `,
    host,
  );
  appState.mainEl.replaceChildren(host);
}
