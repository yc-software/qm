import { html, render, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { brandMark, brandName } from "./ui";
import { appState } from "./shell-state";
import { trapDialogFocus, restoreDialogFocus } from "./dialog-focus";

type ProviderKey = "claude" | "chatgpt";
type ConnKind = "apikey" | "oauth";

interface ProviderMeta {
  key: ProviderKey;
  name: string;
  apiName: "anthropic" | "openai";
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

const PROVIDERS: ProviderMeta[] = [
  {
    key: "claude",
    name: "Claude",
    apiName: "anthropic",
    mark: ANTHROPIC_MARK,
    markClass: "mc-mark-claude",
    keyPlaceholder: "sk-ant-…",
    subscription: "Claude Pro or Max",
    keyConsole: "platform.claude.com",
    keyConsoleUrl: "https://platform.claude.com",
  },
  {
    key: "chatgpt",
    name: "ChatGPT / Codex",
    apiName: "openai",
    mark: OPENAI_MARK,
    markClass: "mc-mark-chatgpt",
    keyPlaceholder: "sk-…",
    subscription: "ChatGPT Plus or Pro",
    keyConsole: "platform.openai.com",
    keyConsoleUrl: "https://platform.openai.com",
  },
];

interface DevicePrompt {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
}

export interface StatusResponse {
  account: "company" | "personal" | "anthropic" | "openai";
  individualModelAuth: boolean;
  required: boolean;
  connections: { provider: "anthropic" | "openai"; kind: ConnKind }[];
}

type Mode = "gate" | "manager";
type Method = "subscription" | "apikey";
type Flow =
  | { kind: "pick" }
  | { kind: "claude"; authorizeUrl: string; verifier: string; code: string }
  | { kind: "chatgpt"; device: DevicePrompt }
  | { kind: "apikey"; value: string };

interface State {
  mode: Mode;
  intent: ProviderMeta | null;
  active: boolean;
  revision: number;
  loaded: boolean;
  notice: string;
  controller: AbortController;
  required: boolean;
  personal: boolean;
  account: StatusResponse["account"];
  loading: boolean;
  error: string;
  busy: boolean;
  saving: boolean;
  connections: Partial<Record<ProviderKey, ConnKind>>;
  open: ProviderKey | null;
  method: Method | null;
  flow: Flow;
  copied: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
}

let s: State;
let overlay: HTMLElement | null = null;
let opener: HTMLElement | null = null;

function fresh(mode: Mode): State {
  return {
    mode,
    intent: null,
    active: true,
    revision: 0,
    loaded: false,
    notice: "",
    controller: new AbortController(),
    required: false,
    personal: false,
    account: "company",
    loading: true,
    error: "",
    busy: false,
    saving: false,
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
  s.revision++;
  s.flow = { kind: "pick" };
  s.method = null;
  s.busy = false;
  s.error = "";
  s.notice = "";
}

function current(state: State, revision = state.revision): boolean {
  return s === state && state.active && state.revision === revision;
}

function applyStatus(status: StatusResponse): void {
  s.required = status.required === true;
  s.personal = status.individualModelAuth === true;
  s.account = status.account;
  s.connections = {};
  for (const c of status.connections ?? []) {
    s.connections[c.provider === "anthropic" ? "claude" : "chatgpt"] = c.kind;
  }
  s.loaded = true;
  if (appState.me) {
    appState.me.individualModelAuth = s.personal;
    appState.me.modelAuthConnected = status.connections.some(
      (c) => s.account === "personal" || s.account === c.provider,
    );
    window.dispatchEvent(new CustomEvent("model-account-changed", { detail: status }));
  }
}

async function load(): Promise<void> {
  const state = s;
  const revision = s.revision;
  s.loading = true;
  s.error = "";
  paint();
  try {
    const status = await api<StatusResponse>("/api/user-model-auth/status", { signal: state.controller.signal });
    if (!current(state, revision)) return;
    applyStatus(status);
  } catch (e) {
    if (!current(state, revision)) return;
    s.loaded = false;
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

async function afterConnect(provider: "anthropic" | "openai"): Promise<void> {
  const state = s;
  resetFlow();
  s.open = null;
  await load();
  if (!current(state)) return;
  s.saving = false;
  if (!s.loaded) {
    paint();
    return;
  }
  if (s.intent || s.mode === "gate") {
    await switchAccount("personal", provider);
    if (current(state) && !s.error && s.mode === "manager") closeManager();
    return;
  }
  s.notice = "Account connected. Choose Use account to use it for your chats.";
  paint();
}

async function pickSubscription(p: ProviderMeta): Promise<void> {
  if (s.busy || s.method === "subscription") return;
  resetFlow();
  const state = s;
  const revision = s.revision;
  s.method = "subscription";
  s.busy = true;
  paint();
  try {
    if (p.key === "claude") {
      const start = await api<{ authorizeUrl: string; verifier: string }>("/api/user-model-auth/claude/start", {
        method: "POST",
        signal: state.controller.signal,
      });
      if (!current(state, revision)) return;
      s.flow = { kind: "claude", ...start, code: "" };
    } else {
      const device = await api<DevicePrompt>("/api/user-model-auth/chatgpt/start", {
        method: "POST",
        signal: state.controller.signal,
      });
      if (!current(state, revision)) return;
      s.flow = { kind: "chatgpt", device };
      s.busy = false;
      paint();
      void pollChatGPT();
      return;
    }
  } catch (e) {
    if (!current(state, revision)) return;
    s.error = friendly(e);
    s.method = null;
  }
  s.busy = false;
  paint();
}

function pickApiKey(): void {
  if (s.busy || s.method === "apikey") return;
  resetFlow();
  s.method = "apikey";
  s.flow = { kind: "apikey", value: "" };
  paint();
}

async function copyCode(code: string): Promise<void> {
  const state = s;
  const revision = s.revision;
  try {
    await navigator.clipboard.writeText(code);
    if (!current(state, revision)) return;
    s.copied = true;
    paint();
    setTimeout(() => {
      if (!current(state, revision)) return;
      s.copied = false;
      paint();
    }, 1600);
  } catch {
    if (!current(state, revision)) return;
    s.error = "Could not copy the code. Select it and copy it manually.";
    paint();
  }
}

async function finishClaude(): Promise<void> {
  if (s.flow.kind !== "claude" || !s.flow.code.trim() || s.busy) return;
  const state = s;
  const revision = s.revision;
  s.error = "";
  s.busy = true;
  s.saving = true;
  paint();
  try {
    await api("/api/user-model-auth/claude/complete", {
      method: "POST",
      body: JSON.stringify({ code: s.flow.code.trim(), verifier: s.flow.verifier }),
      signal: state.controller.signal,
    });
    if (!current(state, revision)) return;
    return afterConnect("anthropic");
  } catch (e) {
    if (!current(state, revision)) return;
    s.busy = false;
    s.saving = false;
    s.error = friendly(e);
    paint();
  }
}

async function pollChatGPT(): Promise<void> {
  if (s.flow.kind !== "chatgpt" || !s.active) return;
  const state = s;
  const revision = s.revision;
  const device = s.flow.device;
  if (Date.now() > device.expiresAt) {
    resetFlow();
    s.error = "That code expired. Select Sign in to get a new code.";
    paint();
    return;
  }
  s.saving = true;
  paint();
  try {
    const r = await api<{ status: string }>("/api/user-model-auth/chatgpt/poll", {
      method: "POST",
      signal: state.controller.signal,
      body: JSON.stringify({ deviceAuthId: device.deviceAuthId, userCode: device.userCode }),
    });
    if (!current(state, revision)) return;
    if (r.status === "connected") return afterConnect("openai");
    s.saving = false;
    paint();
  } catch (e) {
    if (!current(state, revision)) return;
    resetFlow();
    s.saving = false;
    s.error = friendly(e);
    paint();
    return;
  }
  if (current(state, revision)) s.pollTimer = setTimeout(pollChatGPT, Math.max(1000, device.intervalMs || 5000));
}

async function saveKey(p: ProviderMeta): Promise<void> {
  if (s.flow.kind !== "apikey" || !s.flow.value.trim() || s.busy) return;
  const state = s;
  const revision = s.revision;
  s.error = "";
  s.busy = true;
  s.saving = true;
  paint();
  try {
    await api("/api/user-model-auth/api-key", {
      method: "POST",
      body: JSON.stringify({ provider: p.key, apiKey: s.flow.value.trim() }),
      signal: state.controller.signal,
    });
    if (!current(state, revision)) return;
    return afterConnect(p.apiName);
  } catch (e) {
    if (!current(state, revision)) return;
    s.busy = false;
    s.saving = false;
    s.error = friendly(e);
    paint();
  }
}

async function disconnect(p: ProviderMeta): Promise<void> {
  if (s.busy) return;
  resetFlow();
  s.open = null;
  const state = s;
  const revision = s.revision;
  s.error = "";
  s.busy = true;
  s.saving = true;
  paint();
  try {
    await api("/api/user-model-auth/disconnect", {
      method: "POST",
      body: JSON.stringify({ provider: p.key }),
      signal: state.controller.signal,
    });
    if (!current(state, revision)) return;
    resetFlow();
    await load();
    if (!current(state)) return;
    s.saving = false;
    s.notice =
      s.account === p.apiName
        ? "Account disconnected. Reconnect it or choose company access to continue chatting."
        : "Account disconnected.";
    paint();
  } catch (e) {
    if (!current(state, revision)) return;
    s.busy = false;
    s.saving = false;
    s.error = friendly(e);
    paint();
  }
}

function methodRow(title: string, detail: string, selected: boolean, onPick: () => void): TemplateResult {
  return html`
    <button
      type="button"
      class="mc-method ${selected ? "selected" : ""}"
      ?disabled=${s.busy || s.saving || (title === "Company access" && s.required)}
      aria-pressed=${selected}
      @click=${onPick}
    >
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
        <a class="btn" href=${flow.authorizeUrl} target="_blank" rel="noopener">Continue to Claude ↗</a>
      </li>
      <li>
        <label class="mc-field">
          <span>Authorization code</span>
          <input
            ?disabled=${s.busy || s.saving}
            .value=${flow.code}
            placeholder="Paste the code from Claude"
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
          ${s.busy ? "Connecting…" : "Connect account"}
        </button>
      </li>
    </ol>
  `;
}

function chatgptSteps(): TemplateResult {
  if (s.flow.kind !== "chatgpt") return html``;
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
        <a class="btn" href=${device.verificationUrl} target="_blank" rel="noopener">Open chatgpt.com and paste it ↗</a>
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
          ?disabled=${s.busy || s.saving}
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
  if (s.method === "subscription") subscriptionSteps = p.key === "claude" ? claudeSteps() : chatgptSteps();
  if (s.intent) {
    return html`<div class="mc-simple-flow">
      ${s.method === "apikey" ? apikeySteps(p) : subscriptionSteps}
      ${s.busy ? html`<p class="mc-waiting">Connecting…</p>` : nothing}
      ${!s.method ? html`<button class="btn primary" ?disabled=${s.saving} @click=${() => void pickSubscription(p)}>Sign in with ${p.name}</button>` : nothing}
      <button
        class="settings-theme-link"
        ?disabled=${s.busy || s.saving}
        @click=${() => (s.method === "apikey" ? void pickSubscription(p) : pickApiKey())}
      >
        ${s.method === "apikey" ? "Use my subscription instead" : "Use an API key instead"}
      </button>
    </div>`;
  }
  return html`
    <div class="mc-connect">
      ${methodRow(
        `Sign in with ${p.name}`,
        `Uses your ${p.subscription} subscription and its usage limits.`,
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
    action = html`<button
        class="btn"
        ?disabled=${s.busy || s.saving || s.account === p.apiName}
        @click=${() => switchAccount("personal", p.apiName)}
      >
        ${s.account === p.apiName ? "In use" : "Use account"}</button
      ><button class="btn mc-quiet-danger" ?disabled=${s.busy || s.saving} @click=${() => disconnect(p)}>
        ${s.busy ? "…" : "Disconnect"}
      </button>`;
  } else if (open) {
    action = html`<button
      type="button"
      class="btn"
      ?disabled=${s.saving}
      @click=${() => {
        resetFlow();
        s.open = null;
        paint();
      }}
    >
      Cancel
    </button>`;
  } else if (!open) {
    action = html`<button
      class="btn"
      ?disabled=${s.busy || s.saving}
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
        <div class="mc-provider-actions">${action}</div>
      </div>
      ${open && !kind ? connectBody(p) : nothing}
    </section>
  `;
}

async function switchAccount(account: "personal" | "company", provider?: "anthropic" | "openai"): Promise<void> {
  if (s.busy || (account === "company" && !s.personal) || (account === "personal" && provider === s.account)) return;
  resetFlow();
  s.open = null;
  const state = s;
  const revision = s.revision;
  s.busy = true;
  s.saving = true;
  paint();
  try {
    const status = await api<StatusResponse>("/api/user-model-auth/account", {
      method: "POST",
      body: JSON.stringify({ account, provider }),
      signal: state.controller.signal,
    });
    if (!current(state, revision)) return;
    applyStatus(status);
    s.notice =
      account === "company"
        ? "New chats will use company access."
        : `New chats will use your ${provider === "anthropic" ? "Claude" : "ChatGPT / Codex"} account.`;
  } catch (e) {
    if (!current(state, revision)) return;
    s.error = friendly(e);
  }
  s.busy = false;
  s.saving = false;
  paint();
}

function view(): TemplateResult {
  const anyConnected = PROVIDERS.some(
    (p) => s.connections[p.key] && (s.account === "personal" || s.account === p.apiName),
  );
  let cta: TemplateResult | typeof nothing = nothing;
  if (s.loaded && (s.mode === "manager" || anyConnected || !s.personal)) {
    cta =
      s.mode === "gate"
        ? html`<button class="btn primary mc-cta" ?disabled=${s.saving} @click=${() => location.reload()}>
            Start chatting
          </button>`
        : html`<button class="btn primary mc-cta" ?disabled=${s.saving} @click=${closeManager}>Done</button>`;
  }
  let choices: TemplateResult;
  if (!s.loaded) choices = html`<button type="button" class="btn" @click=${() => void load()}>Retry</button>`;
  else if (s.intent)
    choices = html`<div class="mc-simple-connect">
      ${s.connections[s.intent.key] ? providerRow(s.intent) : connectBody(s.intent)}
    </div>`;
  else
    choices = html`<div class="mc-providers">
      ${methodRow(
        "Company access",
        s.required ? "Your organization requires a personal account." : "Use the access provided by your organization.",
        !s.personal,
        () => {
          if (!s.required) void switchAccount("company");
        },
      )}
      <p class="mc-account-hint">
        ${s.personal ? "Using a personal account. Choose a connected provider below." : "Or use your own account. Connect a provider, then choose Use account."}
      </p>
      ${PROVIDERS.map((p) => providerRow(p))}
    </div>`;
  let title = s.mode === "gate" ? "Connect your AI account" : "AI accounts";
  if (s.intent) title = `Connect ${s.intent.name}`;
  const body = s.loading
    ? html`<div class="mc-waiting"><span class="mc-spinner" aria-hidden="true"></span>Loading…</div>`
    : html`
        ${s.error ? html`<div class="mc-error" role="alert">${s.error}</div>` : nothing}
        ${s.saving || s.notice ? html`<p class="mc-notice" role="status">${s.saving ? "Saving changes…" : s.notice}</p>` : nothing}
        ${choices} ${s.intent ? nothing : cta}
      `;
  const personalCopy =
    s.method === "apikey"
      ? "New chats will be billed to this API key."
      : `Use your ${s.intent?.subscription} subscription for new chats.`;
  const subCopy = s.intent
    ? personalCopy
    : "Choose who provides access for your chats on the web and in Slack. Background tasks continue using company access.";
  return html`
    <div class="signin">
      <div
        class="signin-panel mc-panel"
        role=${s.mode === "manager" ? "dialog" : "region"}
        aria-modal=${s.mode === "manager" ? "true" : nothing}
        aria-labelledby="mc-title"
      >
        ${
          s.mode === "manager"
            ? html`<button
                type="button"
                class="mc-close"
                aria-label="Close"
                title="Close"
                ?disabled=${s.saving}
                @click=${closeManager}
              >
                ×
              </button>`
            : nothing
        }
        ${s.mode === "gate" ? html`<div class="signin-brand">${brandMark()}<span>${brandName()}</span></div>` : nothing}
        <h1 id="mc-title">${title}</h1>
        <p class="signin-body">${subCopy}</p>
        ${body}
      </div>
    </div>
  `;
}

function paint(): void {
  const el = target();
  if (!s.active || !el) return;
  const focused = document.activeElement;
  render(view(), el);
  if (s.mode === "manager" && focused && !focused.isConnected) {
    el.querySelector<HTMLElement>(".mc-provider.open .mc-provider-actions button, .mc-close")?.focus();
  }
}

function closeManager(): void {
  if (s.saving) return;
  stopPolling();
  s.active = false;
  s.controller.abort();
  overlay?.remove();
  overlay = null;
  restoreDialogFocus(opener, () => document.querySelector<HTMLElement>("[aria-label='Settings']"));
  opener = null;
}

export function renderModelConnectGate(): void {
  if (s) {
    stopPolling();
    s.active = false;
    s.controller.abort();
  }
  s = fresh("gate");
  paint();
  void load();
}

export function openModelConnectManager(provider?: "anthropic" | "openai"): void {
  if (overlay) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay = document.createElement("div");
  overlay.className = "mc-overlay";
  overlay.addEventListener("click", (e) => {
    if (!e.composedPath().some((node) => node instanceof Element && node.classList.contains("mc-panel")))
      closeManager();
  });
  overlay.addEventListener("keydown", (e) => trapDialogFocus(e, closeManager));
  document.body.appendChild(overlay);
  s = fresh("manager");
  s.intent = PROVIDERS.find((p) => p.apiName === provider) ?? null;
  paint();
  overlay.querySelector<HTMLElement>(".mc-close")?.focus();
  const state = s;
  void load().then(() => {
    if (current(state) && s.loaded && s.intent) {
      s.open = s.intent.key;
      if (!s.connections[s.intent.key]) void pickSubscription(s.intent);
      else paint();
    }
  });
}
