import { html, render, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { brandMark, brandName } from "./ui";

type ProviderKey = "claude" | "chatgpt" | "grok";
type ConnKind = "apikey" | "oauth";

interface ProviderMeta {
  key: ProviderKey;
  name: string;
  apiName: "anthropic" | "openai" | "xai";
  subscriptionFlow: "paste" | "device";
  approvalHost: string;
  mark: TemplateResult;
  markClass: string;
  keyPlaceholder: string;
  subscription: string;
  keyConsole: string;
  keyConsoleUrl: string;
}

const ANTHROPIC_MARK = html`<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
  <path
    d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5527h3.7442L10.5363 3.541Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"
  />
</svg>`;

const OPENAI_MARK = html`<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
  <path
    d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.073zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558-5.8334-3.3874L15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
  />
</svg>`;

const XAI_MARK = html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
  <path d="M4 4 20 20M20 4 4 20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
</svg>`;

const PROVIDERS: ProviderMeta[] = [
  {
    key: "claude",
    name: "Claude",
    apiName: "anthropic",
    subscriptionFlow: "paste",
    approvalHost: "claude.ai",
    mark: ANTHROPIC_MARK,
    markClass: "mc-mark-claude",
    keyPlaceholder: "sk-ant-…",
    subscription: "Claude Pro or Max",
    keyConsole: "platform.claude.com",
    keyConsoleUrl: "https://platform.claude.com",
  },
  {
    key: "chatgpt",
    name: "ChatGPT",
    apiName: "openai",
    subscriptionFlow: "device",
    approvalHost: "chatgpt.com",
    mark: OPENAI_MARK,
    markClass: "mc-mark-chatgpt",
    keyPlaceholder: "sk-…",
    subscription: "ChatGPT Plus or Pro",
    keyConsole: "platform.openai.com",
    keyConsoleUrl: "https://platform.openai.com",
  },
  {
    key: "grok",
    name: "Grok",
    apiName: "xai",
    subscriptionFlow: "device",
    approvalHost: "x.ai",
    mark: XAI_MARK,
    markClass: "mc-mark-grok",
    keyPlaceholder: "xai-…",
    subscription: "Grok account with Build access",
    keyConsole: "console.x.ai",
    keyConsoleUrl: "https://console.x.ai",
  },
];

interface DevicePrompt {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
}

interface StatusResponse {
  individualModelAuth: boolean;
  connections: { provider: "anthropic" | "openai" | "xai"; kind: ConnKind }[];
}

type Mode = "gate" | "manager";
type Method = "subscription" | "apikey";
type Flow =
  | { kind: "pick" }
  | { kind: "claude"; authorizeUrl: string; verifier: string; code: string }
  | { kind: "device"; provider: ProviderKey; device: DevicePrompt }
  | { kind: "apikey"; value: string };

interface State {
  mode: Mode;
  required: boolean;
  loading: boolean;
  error: string;
  busy: boolean;
  connections: Partial<Record<ProviderKey, ConnKind>>;
  open: ProviderKey | null;
  method: Method | null;
  flow: Flow;
  copied: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
}

let s: State;
let overlay: HTMLElement | null = null;
const deviceCache: Partial<Record<ProviderKey, DevicePrompt>> = {};

function fresh(mode: Mode): State {
  return {
    mode,
    required: false,
    loading: true,
    error: "",
    busy: false,
    connections: {},
    open: null,
    method: null,
    flow: { kind: "pick" },
    copied: false,
    pollTimer: null,
  };
}

function target(): HTMLElement | null {
  return s.mode === "gate" ? document.getElementById("app") : overlay;
}

function stopPolling(): void {
  if (s.pollTimer) clearTimeout(s.pollTimer);
  s.pollTimer = null;
}

function resetFlow(): void {
  stopPolling();
  s.flow = { kind: "pick" };
  s.method = null;
  s.busy = false;
  s.error = "";
}

async function load(): Promise<void> {
  s.loading = true;
  paint();
  try {
    const status = await api<StatusResponse>("/api/user-model-auth/status");
    s.required = status.individualModelAuth === true;
    s.connections = {};
    for (const c of status.connections ?? []) {
      const provider = PROVIDERS.find((candidate) => candidate.apiName === c.provider);
      if (provider) s.connections[provider.key] = c.kind;
    }
    s.error = "";
  } catch (e) {
    s.error = friendly(e);
  }
  s.loading = false;
  paint();
}

function friendly(e: unknown): string {
  const raw = errMessage(e);
  if (/invalid_api_key|rejected this API key/i.test(raw)) return "That API key was rejected — check it and try again.";
  if (/oauth_start_failed|oauth_poll_failed|oauth_complete_failed/i.test(raw))
    return "Sign-in didn't complete. Try again — the code may have expired.";
  if (/network|fetch failed|timeout/i.test(raw))
    return "Couldn't reach the sign-in service. Check your connection and try again.";
  return raw;
}

function afterConnect(): void {
  stopPolling();
  if (s.open) delete deviceCache[s.open];
  if (s.mode === "gate") {
    location.reload();
    return;
  }
  const mode = s.mode;
  s = fresh(mode);
  void load();
}

async function pickSubscription(p: ProviderMeta): Promise<void> {
  s.method = "subscription";
  s.error = "";
  s.busy = true;
  paint();
  try {
    if (p.subscriptionFlow === "paste") {
      const start = await api<{ authorizeUrl: string; verifier: string }>(`/api/user-model-auth/${p.key}/start`, {
        method: "POST",
      });
      s.flow = { kind: "claude", ...start, code: "" };
    } else {
      let device = deviceCache[p.key];
      if (!device || device.expiresAt - 30_000 <= Date.now()) {
        device = await api<DevicePrompt>(`/api/user-model-auth/${p.key}/start`, { method: "POST" });
        deviceCache[p.key] = device;
      }
      stopPolling();
      s.flow = { kind: "device", provider: p.key, device };
      s.busy = false;
      paint();
      s.pollTimer = setTimeout(() => void pollDevice(p), device.intervalMs || 5000);
      return;
    }
  } catch (e) {
    s.error = friendly(e);
    s.method = null;
  }
  s.busy = false;
  paint();
}

function pickApiKey(): void {
  stopPolling();
  s.method = "apikey";
  s.flow = { kind: "apikey", value: "" };
  s.error = "";
  paint();
}

async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    s.copied = true;
    paint();
    setTimeout(() => {
      s.copied = false;
      paint();
    }, 1600);
  } catch {
    s.copied = false;
  }
}

async function finishClaude(): Promise<void> {
  if (s.flow.kind !== "claude" || !s.flow.code.trim() || s.busy) return;
  s.error = "";
  s.busy = true;
  paint();
  try {
    await api("/api/user-model-auth/claude/complete", {
      method: "POST",
      body: JSON.stringify({ code: s.flow.code.trim(), verifier: s.flow.verifier }),
    });
    return afterConnect();
  } catch (e) {
    s.busy = false;
    s.error = friendly(e);
    paint();
  }
}

async function pollDevice(p: ProviderMeta): Promise<void> {
  if (s.flow.kind !== "device" || s.flow.provider !== p.key) return;
  const device = s.flow.device;
  if (Date.now() > device.expiresAt) {
    delete deviceCache[p.key];
    resetFlow();
    s.error = "That code expired — start the sign-in again.";
    paint();
    return;
  }
  try {
    const r = await api<{ status: string; intervalMs?: number }>(`/api/user-model-auth/${p.key}/poll`, {
      method: "POST",
      body: JSON.stringify({ deviceAuthId: device.deviceAuthId }),
    });
    if (r.status === "connected") return afterConnect();
    if (r.status === "denied") {
      delete deviceCache[p.key];
      resetFlow();
      s.error = "Sign-in was denied. Start again when you're ready.";
      paint();
      return;
    }
    if (r.status === "expired") {
      delete deviceCache[p.key];
      resetFlow();
      s.error = "That code expired — start the sign-in again.";
      paint();
      return;
    }
    if (r.intervalMs) device.intervalMs = r.intervalMs;
  } catch (e) {
    s.error = friendly(e);
    delete deviceCache[p.key];
    resetFlow();
    paint();
    return;
  }
  if (s.flow.kind === "device") s.pollTimer = setTimeout(() => void pollDevice(p), device.intervalMs || 5000);
}

async function saveKey(p: ProviderMeta): Promise<void> {
  if (s.flow.kind !== "apikey" || !s.flow.value.trim() || s.busy) return;
  s.error = "";
  s.busy = true;
  paint();
  try {
    await api("/api/user-model-auth/api-key", {
      method: "POST",
      body: JSON.stringify({ provider: p.key, apiKey: s.flow.value.trim() }),
    });
    return afterConnect();
  } catch (e) {
    s.busy = false;
    s.error = friendly(e);
    paint();
  }
}

async function disconnect(p: ProviderMeta): Promise<void> {
  if (s.busy) return;
  s.error = "";
  s.busy = true;
  paint();
  try {
    await api("/api/user-model-auth/disconnect", { method: "POST", body: JSON.stringify({ provider: p.key }) });
    resetFlow();
    await load();
  } catch (e) {
    s.busy = false;
    s.error = friendly(e);
    paint();
  }
}

function methodRow(title: string, detail: string, selected: boolean, onPick: () => void): TemplateResult {
  return html`
    <button type="button" class="mc-method ${selected ? "selected" : ""}" ?disabled=${s.busy} @click=${onPick}>
      <span class="mc-method-radio" aria-hidden="true"></span>
      <span class="mc-method-text">
        <span class="mc-method-title">${title}</span>
        <span class="mc-method-detail">${detail}</span>
      </span>
    </button>
  `;
}

function claudeSteps(): TemplateResult {
  if (s.flow.kind !== "claude") return html``;
  const flow = s.flow;
  return html`
    <ol class="mc-steps">
      <li>
        <a class="btn" href=${flow.authorizeUrl} target="_blank" rel="noopener">Open claude.ai and approve ↗</a>
      </li>
      <li>
        <label class="mc-field">
          <span>Paste the code Claude shows you</span>
          <input
            .value=${flow.code}
            placeholder="Code from claude.ai"
            autocomplete="off"
            spellcheck="false"
            @input=${(e: Event) => {
              flow.code = (e.target as HTMLInputElement).value;
              paint();
            }}
            @keydown=${(e: KeyboardEvent) => e.key === "Enter" && finishClaude()}
          />
        </label>
      </li>
      <li>
        <button class="btn primary" ?disabled=${!flow.code.trim() || s.busy} @click=${finishClaude}>
          ${s.busy ? "Connecting…" : "Finish"}
        </button>
      </li>
    </ol>
  `;
}

function deviceSteps(p: ProviderMeta): TemplateResult {
  if (s.flow.kind !== "device" || s.flow.provider !== p.key) return html``;
  const device = s.flow.device;
  return html`
    <ol class="mc-steps">
      <li>
        <button
          type="button"
          class="mc-code-btn ${s.copied ? "copied" : ""}"
          title="Copy code to clipboard"
          @click=${() => copyCode(device.userCode)}
        >
          <span class="mc-code">${device.userCode}</span>
          <span class="mc-copy-hint">${s.copied ? "Copied ✓" : "Click to copy"}</span>
        </button>
      </li>
      <li>
        <a class="btn" href=${device.verificationUrl} target="_blank" rel="noopener"
          >Open ${p.approvalHost} and paste it ↗</a
        >
      </li>
      <li>
        <span class="mc-waiting"><span class="mc-spinner" aria-hidden="true"></span>Waiting for your approval…</span>
      </li>
    </ol>
  `;
}

function apikeySteps(p: ProviderMeta): TemplateResult {
  if (s.flow.kind !== "apikey") return html``;
  const flow = s.flow;
  return html`
    <div class="mc-keyform">
      <label class="mc-field">
        <span>API key · from <a href=${p.keyConsoleUrl} target="_blank" rel="noopener">${p.keyConsole}</a></span>
        <input
          type="password"
          .value=${flow.value}
          placeholder=${p.keyPlaceholder}
          autocomplete="off"
          @input=${(e: Event) => {
            flow.value = (e.target as HTMLInputElement).value;
            paint();
          }}
          @keydown=${(e: KeyboardEvent) => e.key === "Enter" && saveKey(p)}
        />
      </label>
      <button class="btn primary" ?disabled=${!flow.value.trim() || s.busy} @click=${() => saveKey(p)}>
        ${s.busy ? "Checking…" : "Connect"}
      </button>
    </div>
  `;
}

function connectBody(p: ProviderMeta): TemplateResult {
  let subscriptionSteps: TemplateResult | typeof nothing = nothing;
  if (s.method === "subscription") subscriptionSteps = p.subscriptionFlow === "paste" ? claudeSteps() : deviceSteps(p);
  return html`
    <div class="mc-connect">
      ${methodRow(
        `Sign in with ${p.name}`,
        `Uses your ${p.subscription} subscription — nothing extra to pay.`,
        s.method === "subscription",
        () => void pickSubscription(p),
      )}
      ${subscriptionSteps}
      ${methodRow(
        "Use an API key",
        `Paste a key from ${p.keyConsole} — usage is billed to the key.`,
        s.method === "apikey",
        pickApiKey,
      )}
      ${s.method === "apikey" ? apikeySteps(p) : nothing}
    </div>
  `;
}

function providerRow(p: ProviderMeta): TemplateResult {
  const kind = s.connections[p.key];
  const open = s.open === p.key;
  let statusLine = `Chat with ${p.name} on your own account`;
  if (kind === "oauth") statusLine = `Connected with your ${p.name} subscription`;
  else if (kind === "apikey") statusLine = "Connected with your API key";
  let action: TemplateResult | typeof nothing = nothing;
  if (kind) {
    action = html`<button class="btn mc-quiet-danger" ?disabled=${s.busy} @click=${() => disconnect(p)}>
      ${s.busy ? "…" : "Disconnect"}
    </button>`;
  } else if (!open) {
    action = html`<button
      class="btn"
      ?disabled=${s.busy}
      @click=${() => {
        resetFlow();
        s.open = p.key;
        paint();
      }}
    >
      Connect
    </button>`;
  }
  return html`
    <section class="mc-provider ${kind ? "connected" : ""} ${open ? "open" : ""}">
      <div class="mc-provider-row">
        <span class="mc-mark ${p.markClass}" aria-hidden="true">${p.mark}</span>
        <div class="mc-provider-text">
          <strong>${p.name}</strong>
          <small>${statusLine}</small>
        </div>
        ${action}
      </div>
      ${open && !kind ? connectBody(p) : nothing}
    </section>
  `;
}

function view(): TemplateResult {
  const anyConnected = Object.keys(s.connections).length > 0;
  let cta: TemplateResult | typeof nothing = nothing;
  if (anyConnected) {
    cta =
      s.mode === "gate"
        ? html`<button class="btn primary mc-cta" @click=${() => location.reload()}>Start chatting</button>`
        : html`<button class="btn primary mc-cta" @click=${closeManager}>Done</button>`;
  }
  const body = s.loading
    ? html`<div class="mc-waiting"><span class="mc-spinner" aria-hidden="true"></span>Loading…</div>`
    : html`
        ${s.error ? html`<div class="mc-error" role="alert">${s.error}</div>` : nothing}
        <div class="mc-providers">${PROVIDERS.map((p) => providerRow(p))}</div>
        ${cta}
      `;
  let subCopy = "Chats run on the account you connect here, billed to you — not the organization.";
  if (s.mode === "gate") {
    subCopy =
      "Your organization has each person chat on their own AI account. Connect one to get started — you can switch any time.";
  } else if (s.required && !s.loading && !anyConnected) {
    subCopy =
      "Chats run on the account you connect here, billed to you — not the organization. Connect at least one to keep using the assistant.";
  }
  return html`
    <div class="signin">
      <div class="signin-panel mc-panel">
        ${
          s.mode === "manager" && !anyConnected && !s.loading
            ? html`<button type="button" class="mc-close" aria-label="Close" title="Close" @click=${closeManager}>
                ×
              </button>`
            : nothing
        }
        ${s.mode === "gate" ? html`<div class="signin-brand">${brandMark()}<span>${brandName()}</span></div>` : nothing}
        <h1>${s.mode === "gate" ? "Connect your AI account" : "Your AI account"}</h1>
        <p class="signin-body">${subCopy}</p>
        ${body}
      </div>
    </div>
  `;
}

function paint(): void {
  const el = target();
  if (el) render(view(), el);
}

function closeManager(): void {
  stopPolling();
  overlay?.remove();
  overlay = null;
  if (s.required && Object.keys(s.connections).length === 0) location.reload();
}

export function renderModelConnectGate(): void {
  s = fresh("gate");
  paint();
  void load();
}

export function openModelConnectManager(): void {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "mc-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeManager();
  });
  document.body.appendChild(overlay);
  s = fresh("manager");
  paint();
  void load();
}
