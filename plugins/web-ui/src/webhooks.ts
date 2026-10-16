import { createAutomationPage, type AutomationView } from "./automation-page";
import { webhookRunSummary } from "./webhook-format.ts";
import { html, nothing, render } from "lit";
import { Check, ChevronDown } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { closeFormMenus, copyText, setFormMenuValue, toggleFormMenu } from "./ui";
import { icon } from "./icons";
import { listBackLink } from "./list-page";
import { appState } from "./shell";

export interface WebhookView extends AutomationView {
  action: string;
  verification: { scheme: string; secret?: string };
  filters?: Array<{ path: string; in: string[] }>;
  lastReceivedAt?: number;
  lastDeliveryId?: string;
  lastError?: string;
  lastRun?: { status?: string; firedAt: number; endedAt?: number };
  url: string;
}

type WebhookScheme = "hmac-sha256" | "github" | "slack" | "stripe" | "linear";

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
  {
    value: "linear",
    label: "Linear",
    guidance: "Use the webhook signing secret shown by Linear. Payloads older than one minute are rejected.",
  },
];

const page = createAutomationPage<WebhookView>({
  kind: "webhooks",
  singular: "webhook",
  title: "Webhooks",
  searchText: (w) => w.verification.scheme,
  runSummary: webhookRunSummary,
  runSummaryTitle: webhookRunSummary,
  triggerFields: (w) => html`
    <div class="field">
      <label>Verification</label>
      <div class="value">${w.verification.scheme}</div>
    </div>
    <div class="field"><label>Inbound URL</label>${copyRow(w.url)}</div>
    ${
      w.lastDeliveryId
        ? html`<div class="field">
            <label>Last delivery ID</label>
            <div class="value">${w.lastDeliveryId}</div>
          </div>`
        : nothing
    }
    ${
      w.lastError
        ? html`<div class="field">
            <label>Last error</label>
            <div class="value pre">${w.lastError}</div>
          </div>`
        : nothing
    }
    ${
      w.filters?.length
        ? html`<div class="field">
            <label>Filters</label>
            <div class="value pre">${w.filters.map((f) => `${f.path} ∈ [${f.in.join(", ")}]`).join("\n")}</div>
          </div>`
        : nothing
    }
  `,
  editHint: "Changes apply to future events. The inbound URL, signing secret, and filters stay the same.",
  create: showNewWebhook,
});

export const resetActiveWebhook = page.reset;
export const openWebhookById = page.openById;
export const routeWebhooksHistory = page.routeHistory;
export const renderWebhooksPage = page.render;
const drawWebhooksPage = page.list;

function copyRow(text: string) {
  return html`
    <div class="copyrow">
      <code class="mono">${text}</code>
      <button class="btn" @click=${(e: Event) => void copyText(text, e.currentTarget as HTMLButtonElement)}>
        <span>Copy</span>
      </button>
    </div>
  `;
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
    await page.refresh();
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
        <div class="warn">Copy the secret now. It won't be shown again.</div>
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
          <button class="btn" @click=${() => page.open(w)}>Done</button>
        </div>
      </div>
    `,
    host,
  );
  appState.mainEl.replaceChildren(host);
}
