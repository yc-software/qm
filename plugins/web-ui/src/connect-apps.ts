import { openDesktopBrowser } from "../../chassis/src/desktop-browser";
import {
  takeConnectionReturn,
  completeConnectionReturn,
  saveConnectionAttempt,
  clearConnectionAttempt,
  type ConnectionAttempt,
  type PickerState,
  ACCOUNT_ID,
} from "./connection-return";
import { LitElement, html, nothing } from "lit";
import { Check, TriangleAlert } from "lucide";
import { icon } from "./icons";
import { mountConnectionPicker, type ConnectionService } from "./connection-picker";

interface ConnectedAccount {
  id: string;
  toolkit: string;
  missingScopes?: string[];
}
import type { Me } from "./shell-state";
import "./connect-apps.css";
import "./onboarding-slack";
import "./slack-account";

const continuedAttempts = new Set<string>();

export class ConnectApps extends LitElement {
  static properties = {
    me: { attribute: false },
    onConnected: { attribute: false },
    widget: {},
    toolkit: {},
    returnKey: {},
    base: {},
    adminBase: {},
    loading: { state: true },
    error: { state: true },
    authorizing: { state: true },
    authorizationError: { state: true },
    connectionOutcome: { state: true },
    connections: { state: true },
    connectionError: { state: true },
    workspaceConnected: { state: true },
    workspaceError: { state: true },
  };
  declare me: Me | null;
  declare onConnected: ((name: string) => void) | undefined;
  declare widget: "apps" | "slack" | "slack-account";
  declare toolkit: string;
  declare returnKey: string;
  declare base: string;
  declare adminBase: string;
  declare loading: boolean;
  declare error: string;
  declare authorizing: string;
  declare authorizationError: string;
  private connections: ConnectedAccount[] = [];
  private disconnecting = "";
  private connectionError = "";
  private workspaceConnected: boolean | null = null;
  private workspaceError = false;
  private realReturn: ConnectionAttempt | null = null;
  private connectionsController?: AbortController;
  private restoreScrollTop: number | null = null;
  private returnError = "";
  private returnAccount = "";
  private refreshConnections = () => {
    if (!document.hidden) void this.refreshWorkspace();
    if (this.widget === "apps" && !document.hidden) void this.loadConnections();
  };
  private pickerState: PickerState = { query: "", expanded: false };
  private retryService: ConnectionAttempt["service"] | null = null;
  declare connectionOutcome: "" | "checking" | "success" | "cancelled" | "failed" | "expired";
  private controller?: AbortController;
  private services: ConnectionService[] = [];

  constructor() {
    super();
    this.me = null;
    this.widget = "apps";
    this.toolkit = "";
    this.returnKey = "settings";
    this.base = "/";
    this.adminBase = "/admin";
    this.loading = true;
    this.error = "";
    this.authorizing = "";
    this.authorizationError = "";
    this.connectionOutcome = "";
  }
  protected createRenderRoot(): HTMLElement {
    return this;
  }
  private accountUser(): string {
    return `${this.me?.org}:${this.me?.user}`;
  }
  private async refreshWorkspace(): Promise<void> {
    if (this.widget === "apps" || (this.widget !== "slack-account" && this.me?.permissions?.includes("admin"))) return;
    try {
      const response = await fetch(`${this.base}api/composio/slack`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error("Slack status unavailable");
      this.workspaceConnected = (await response.json()).workspaceInstalled === true;
      this.workspaceError = false;
    } catch {
      this.workspaceConnected = null;
      this.workspaceError = true;
    }
  }
  protected firstUpdated(): void {
    void this.refreshWorkspace();
    window.addEventListener("focus", this.refreshConnections);
    document.addEventListener("visibilitychange", this.refreshConnections);
    if (this.widget !== "apps") return;
    const returnUrl = takeConnectionReturn(this.accountUser(), this.returnKey);
    if (returnUrl) {
      const params = returnUrl.url.searchParams;
      const attempt = returnUrl.attempt;
      this.realReturn = returnUrl.verified ? null : attempt;
      this.returnError = params.get("error") ?? "";
      this.returnAccount = params.get("connectedAccountId") ?? "";
      if (attempt) {
        this.pickerState = { ...attempt.picker };
        this.restoreScrollTop = attempt.scrollTop;
        this.retryService = attempt.service;
        this.connectionOutcome = returnUrl.verified ? "" : "checking";
      } else this.connectionOutcome = "expired";
      const clean = new URL(location.href);
      for (const key of ["composioReturn", "status", "error", "connectedAccountId"]) clean.searchParams.delete(key);
      history.replaceState(history.state, "", clean);
    }
    void this.loadConnections();
    void this.loadCatalog();
  }
  private drawPicker(): void {
    const target = this.querySelector<HTMLElement>(".connect-apps-picker");
    const connected = this.connections.map((account) => account.toolkit);
    const stale = this.staleToolkits();
    const services = this.services.map((service) => ({
      ...service,
      connected: connected.includes(service.id),
      stale: stale.has(service.id),
    }));
    const requested = services.find((service) => service.id === this.requestedToolkit());
    if (target && !this.error && !this.loading)
      mountConnectionPicker(
        target,
        requested ? [requested] : services,
        (service) => this.authorize(service, this.staleAccount(service.id)),
        requested ? { query: "", expanded: false } : this.pickerState,
        requested,
      );
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.controller?.abort();
    this.connectionsController?.abort();
    window.removeEventListener("focus", this.refreshConnections);
    document.removeEventListener("visibilitychange", this.refreshConnections);
  }
  private staleToolkits(): Set<string> {
    const toolkits = new Set(this.connections.map((account) => account.toolkit));
    return new Set(
      [...toolkits].filter((toolkit) =>
        this.connections.every((account) => account.toolkit !== toolkit || account.missingScopes?.length),
      ),
    );
  }
  private staleAccount(toolkit: string): string | undefined {
    return this.staleToolkits().has(toolkit)
      ? this.connections.find((account) => account.toolkit === toolkit)?.id
      : undefined;
  }
  private async disconnect(account: ConnectedAccount, name: string): Promise<boolean> {
    this.disconnecting = account.id;
    this.connectionError = "";
    this.requestUpdate();
    try {
      const response = await fetch(`${this.base}api/composio/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
      if (!response.ok && response.status !== 404) throw new Error(`Could not disconnect ${name}. Please try again.`);
      this.connections = this.connections.filter((candidate) => candidate.id !== account.id);
      return true;
    } catch (error) {
      this.connectionError = error instanceof Error ? error.message : `Could not disconnect ${name}.`;
      return false;
    } finally {
      this.disconnecting = "";
      this.requestUpdate();
      await this.updateComplete;
      this.drawPicker();
    }
  }
  private confirmDisconnect(account: ConnectedAccount, name: string): void {
    if (window.confirm(`Disconnect ${name}? QM will lose access to it until you connect it again.`))
      void this.disconnect(account, name);
  }
  private requestedToolkit(): string {
    return this.services.some((service) => service.id === this.toolkit) ? this.toolkit : "";
  }
  private async loadConnections(): Promise<void> {
    this.connectionsController?.abort();
    const controller = (this.connectionsController = new AbortController());
    this.connectionError = "";
    try {
      const accounts: ConnectedAccount[] = [];
      const seen = new Set<string>();
      let cursor = "";
      do {
        if (seen.has(cursor) || seen.size >= 100) throw new Error("Could not finish checking connected apps.");
        seen.add(cursor);
        const response = await fetch(`${this.base}api/composio/connections?${new URLSearchParams({ cursor })}`, {
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.items))
          throw new Error("Could not check connected apps. Please try again.");
        accounts.push(...result.items);
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : "";
      } while (cursor);
      if (!this.isConnected || controller.signal.aborted) return;
      this.connections = accounts;
      if (this.realReturn) {
        const attempt = this.realReturn;
        const verified = accounts.some(
          (account) => account.id === attempt.accountId && account.toolkit === attempt.service.id,
        );
        if (verified && (!this.returnAccount || this.returnAccount === attempt.accountId))
          this.connectionOutcome = "success";
        else this.connectionOutcome = this.returnError === "access_denied" ? "cancelled" : "failed";
        clearConnectionAttempt(this.accountUser());
        if (this.connectionOutcome === "success") {
          completeConnectionReturn(this.accountUser(), attempt.state);
          this.realReturn = null;
          const replaced = accounts.find(
            (account) => account.id === attempt.replaces && account.id !== attempt.accountId,
          );
          if (replaced && !(await this.disconnect(replaced, attempt.service.name)))
            this.connectionError = `${attempt.service.name} is reconnected, but the old connection is still there. Disconnect it below.`;
          if (attempt.service.id === this.toolkit && !continuedAttempts.has(attempt.state)) {
            continuedAttempts.add(attempt.state);
            this.onConnected?.(attempt.service.name);
          }
        }
      }
      await this.updateComplete;
      this.drawPicker();
    } catch (error) {
      if (controller.signal.aborted || !this.isConnected) return;
      this.connections = [];
      this.connectionOutcome = "";
      this.connectionError = error instanceof Error ? error.message : "Could not check connected apps.";
      await this.updateComplete;
      this.drawPicker();
    }
  }
  private async loadCatalog(): Promise<void> {
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    this.loading = true;
    this.error = "";
    const services: ConnectionService[] = [];
    const cursors = new Set<string>();
    let cursor = "";
    try {
      do {
        if (cursors.has(cursor)) throw new Error("Could not finish loading apps. Please try again.");
        cursors.add(cursor);
        const response = await fetch(`${this.base}api/composio/toolkits?${new URLSearchParams({ cursor })}`, {
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.message ?? "App connections are unavailable right now. Please try again.");
        for (const item of result.items as Array<{ id: string; name: string; description: string }>) {
          if (item.id !== "slack" && !services.some((service) => service.id === item.id))
            services.push({ ...item, popularity: 100000 - services.length });
        }
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : "";
        if (cursors.size > 100) throw new Error("Could not finish loading apps. Please try again.");
      } while (cursor);
      this.services = services;
    } catch (error) {
      if (controller.signal.aborted) return;
      this.error = error instanceof Error ? error.message : "Could not load apps. Please try again.";
    }
    if (!this.isConnected || controller.signal.aborted) return;
    this.loading = false;
    await this.updateComplete;
    this.drawPicker();
    const restoreTop = this.restoreScrollTop;
    if (restoreTop !== null && restoreTop !== undefined) {
      await this.updateComplete;
      requestAnimationFrame(() => {
        const scroller = this.closest(".chat-scroll");
        if (scroller && this.isConnected) scroller.scrollTop = restoreTop;
        this.restoreScrollTop = null;
      });
    }
  }
  private async authorize(service: ConnectionService, replaces?: string): Promise<void> {
    if (this.authorizing) return;
    this.authorizing = service.name;
    this.authorizationError = "";
    try {
      if (await openDesktopBrowser(`${this.base}settings`)) return;
      const state = crypto.randomUUID();
      const attempt: ConnectionAttempt = {
        state,
        user: this.accountUser(),
        service: { id: service.id, name: service.name },
        accountId: "",
        ...(replaces ? { replaces } : {}),
        widget: this.returnKey,
        expiresAt: Date.now() + 20 * 60_000,
        path: location.pathname,
        picker: { ...this.pickerState },
        scrollTop: this.closest(".chat-scroll")?.scrollTop ?? 0,
      };
      saveConnectionAttempt(attempt);
      const response = await fetch(`${this.base}api/composio/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: service.id, returnTo: location.pathname + location.search, state }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Could not open authorization. Please try again.");
      if (typeof result.accountId !== "string" || !ACCOUNT_ID.test(result.accountId))
        throw new Error("Could not start authorization. Please try again.");
      saveConnectionAttempt({ ...attempt, accountId: result.accountId });
      window.location.assign(result.url);
    } catch (error) {
      this.authorizationError =
        error instanceof Error ? error.message : "Could not open authorization. Please try again.";
    } finally {
      this.authorizing = "";
    }
  }
  protected render() {
    const serviceName = this.retryService?.name ?? "App";
    const requested = this.requestedToolkit();
    const connectedAccounts = this.connections.filter((account) => !requested || account.toolkit === requested);
    const serviceFor = (id: string) =>
      this.services.find((service) => service.id === id) ?? { id, name: id, description: "", popularity: 0 };
    const outcome = {
      "": { title: "", detail: "" },
      checking: {
        title: `Checking ${serviceName} connection…`,
        detail: "Confirming access before marking it connected.",
      },
      success: {
        title: `${serviceName} connected`,
        detail: "",
      },
      cancelled: {
        title: `${serviceName} wasn’t connected`,
        detail: "You cancelled authorization. You can try again whenever you’re ready.",
      },
      expired: { title: "This connection attempt has expired", detail: "Choose an app below to start again." },
      failed: {
        title: `Couldn’t connect ${serviceName}`,
        detail: "We couldn’t confirm an active connection yet. Try checking again, or restart authorization.",
      },
    }[this.connectionOutcome];
    return html`<section class="connect-apps">
      ${
        this.widget === "slack" && this.me?.permissions?.includes("admin")
          ? html`<qm-onboarding-slack
              .adminBase=${this.adminBase}
              @slack-installation-status=${(event: CustomEvent<{ connected: boolean }>) => {
                this.workspaceConnected = event.detail.connected;
              }}
            ></qm-onboarding-slack>`
          : nothing
      }
      ${this.widget === "slack-account" && this.workspaceError ? html`<p role="status">Could not check Slack setup. <button class="btn" @click=${() => void this.refreshWorkspace()}>Try again</button></p>` : nothing}
      ${this.widget === "slack-account" && this.workspaceConnected === false ? html`<p role="status">QM needs to be added to your company’s Slack workspace before you can link your account. Ask an administrator to finish setup.</p>` : nothing}
      ${this.workspaceConnected && this.widget !== "apps" ? html`<qm-slack-account .user=${this.accountUser()}></qm-slack-account>` : nothing}
      ${
        this.widget !== "apps"
          ? nothing
          : html`<div>
              ${this.loading ? html`<div class="connect-apps-load" role="status">Loading your available apps…</div>` : nothing}
              ${
                this.error
                  ? html`<div class="connect-apps-load">
                      <strong>Connect your apps</strong>
                      <p role="status">${this.error}</p>
                      <button
                        type="button"
                        class="btn"
                        @click=${() => {
                          void this.loadCatalog();
                          void this.loadConnections();
                          void this.refreshWorkspace();
                        }}
                      >
                        Try again
                      </button>
                    </div>`
                  : nothing
              }
              ${
                this.connectionOutcome && this.connectionOutcome !== "success"
                  ? html`<div
                      class="connection-result"
                      data-outcome=${this.connectionOutcome}
                      role="status"
                      aria-live="polite"
                    >
                      <strong>${outcome.title}</strong>
                      ${outcome.detail ? html`<p>${outcome.detail}</p>` : nothing}
                      ${["cancelled", "failed"].includes(this.connectionOutcome) && this.retryService ? html`<button class="btn" @click=${() => this.authorize({ ...this.retryService!, description: "", popularity: 0 })}>Try again</button>` : nothing}
                    </div>`
                  : nothing
              }
              ${this.connectionError && !this.error && !this.loading ? html`<div class="connect-apps-status" role="status">${this.connectionError} <button class="btn" @click=${() => void this.loadConnections()}>Check again</button></div>` : nothing}
              ${this.connectionOutcome === "failed" ? html`<button class="btn" @click=${() => void this.loadConnections()}>Check again</button>` : nothing}
              <div class="connect-apps-picker" ?inert=${Boolean(this.authorizing)}></div>
              ${
                connectedAccounts.length
                  ? html`<div class="connection-connected" role="status" aria-live="polite">
                      ${connectedAccounts.map((account) => {
                        const service = serviceFor(account.toolkit);
                        const stale = Boolean(account.missingScopes?.length);
                        return html`<span class=${stale ? "stale" : ""}
                          >${icon(stale ? TriangleAlert : Check, 10)}${`${service.name} ${stale ? "needs new permissions" : "connected"}`}
                          ${
                            account.id
                              ? html`<button
                                    type="button"
                                    class="kc-text-action"
                                    ?disabled=${Boolean(this.authorizing || this.disconnecting)}
                                    @click=${() => void this.authorize(service, account.id)}
                                  >
                                    Reconnect
                                  </button>
                                  <button
                                    type="button"
                                    class="kc-text-action danger"
                                    ?disabled=${Boolean(this.authorizing || this.disconnecting)}
                                    @click=${() => this.confirmDisconnect(account, service.name)}
                                  >
                                    Disconnect
                                  </button>`
                              : nothing
                          }</span
                        >`;
                      })}
                    </div>`
                  : nothing
              }
              ${this.authorizing ? html`<p class="connect-apps-status" role="status">Opening ${this.authorizing}…</p>` : nothing}
              ${this.authorizationError ? html`<p class="connect-apps-status" role="alert">${this.authorizationError}</p>` : nothing}
            </div>`
      }
    </section>`;
  }
}
if (!customElements.get("qm-connect-apps")) customElements.define("qm-connect-apps", ConnectApps);
