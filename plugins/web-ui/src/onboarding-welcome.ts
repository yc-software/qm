import { openDesktopBrowser } from "../../chassis/src/desktop-browser";
import {
  isConnectionReturn,
  takeConnectionReturn,
  completeConnectionReturn,
  saveConnectionAttempt,
  clearConnectionAttempt,
  type ConnectionAttempt,
  ACCOUNT_ID,
} from "./connection-return";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { Check, TriangleAlert } from "lucide";
import { icon } from "./icons";
import { mountConnectionPicker, type ConnectionService } from "./connection-picker";
import { connectionActions, connectionCard, type ConnectionOutcome } from "./connection-card";
import { suggestedActivities } from "./suggested-activities";
import { welcomeActivities } from "./welcome-ideas";
import { errMessage } from "../../chassis/src/errors.ts";

interface ConnectedAccount {
  id: string;
  toolkit: string;
  missingScopes?: string[];
}
import type { Me } from "./shell-state";
import type { ActivitySeeds } from "../../chassis/src/suggested-activities.ts";
import "./onboarding-welcome.css";
import "./onboarding-slack";
import "./slack-account";
import "./welcome-about";
import { firstName } from "./welcome-about-scenes";
import {
  connectionPreviewEnabled,
  previewParameters,
  readPreviewAttempt,
  startPreviewAttempt,
  finishPreviewAttempt,
  verifyPreviewAttempt,
  previewConnections,
  savePreviewConnection,
  clearPreviewAttempt,
  resetPreview,
  type PreviewAttempt,
  type PickerState,
} from "./connection-preview";

const continuedAttempts = new Set<string>();

const HARNESS = "QM, your agent harness.";

export class OnboardingWelcome extends LitElement {
  static properties = {
    me: { attribute: false },
    onIdea: { attribute: false },
    onConnected: { attribute: false },
    animateWelcome: { type: Boolean },
    setupOnly: { type: Boolean },
    widget: {},
    toolkit: {},
    returnKey: {},
    base: {},
    loading: { state: true },
    error: { state: true },
    authorizing: { state: true },
    authorizationError: { state: true },
    connectionOutcome: { state: true },
    connections: { state: true },
    connectionsChecked: { state: true },
    connectionError: { state: true },
    workspaceConnected: { state: true },
    slackLinked: { state: true },
    workspaceError: { state: true },
    about: { state: true },
  };
  declare me: Me | null;
  declare onIdea: ((prompt: string) => void) | undefined;
  declare onConnected: ((name: string) => void) | undefined;
  declare animateWelcome: boolean;
  declare setupOnly: boolean;
  declare widget: "all" | "apps" | "slack" | "slack-account";
  declare toolkit: string;
  declare returnKey: string;
  declare base: string;
  declare loading: boolean;
  declare error: string;
  declare authorizing: string;
  declare authorizationError: string;
  private connections: ConnectedAccount[] = [];
  private connectionsChecked = false;
  private disconnecting = "";
  private connectionError = "";
  private workspaceConnected: boolean | null = null;
  private slackLinked = false;
  private workspaceError = false;
  private realReturn: ConnectionAttempt | null = null;
  private connectionsController?: AbortController;
  private restoreScrollTop: number | null = null;
  private returnError = "";
  private returnAccount = "";
  private refreshConnections = () => {
    if (!document.hidden) void this.refreshWorkspace();
    if (!this.preview && !["slack", "slack-account"].includes(this.widget) && !document.hidden)
      void this.loadConnections();
  };
  private preview = connectionPreviewEnabled();
  private consent: PreviewAttempt | null = null;
  private returned: PreviewAttempt | null = null;
  private pickerState: PickerState = { query: "" };
  private retryService: PreviewAttempt["service"] | null = null;
  declare about: boolean;
  declare connectionOutcome: ConnectionOutcome;
  private controller?: AbortController;
  private services: ConnectionService[] = [];

  constructor() {
    super();
    this.me = null;
    this.animateWelcome = true;
    this.setupOnly = false;
    this.widget = "all";
    this.toolkit = "";
    this.returnKey = "welcome";
    this.base = "/";
    this.loading = true;
    this.error = "";
    this.authorizing = "";
    this.authorizationError = "";
    this.connectionOutcome = "";
    this.about = false;
  }
  protected createRenderRoot(): HTMLElement {
    return this;
  }
  private previewUser(): string {
    return `${this.me?.org}:${this.me?.user}`;
  }
  private async refreshWorkspace(): Promise<void> {
    if (
      this.widget === "apps" ||
      (this.widget !== "slack-account" &&
        (this.me?.permissions?.includes("admin") || this.me?.permissions?.includes("owner")) &&
        !this.seeded)
    )
      return;
    try {
      const response = await fetch(`${this.base}api/composio/slack`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error("Slack status unavailable");
      const status = await response.json();
      this.workspaceConnected = status.workspaceInstalled === true;
      this.slackLinked = status.connected === true;
      this.workspaceError = false;
    } catch {
      this.workspaceConnected = null;
      this.workspaceError = true;
    }
  }
  protected firstUpdated(): void {
    void this.refreshWorkspace();
    const params = previewParameters();
    const returnUrl =
      !this.preview && !["slack", "slack-account"].includes(this.widget)
        ? takeConnectionReturn(this.previewUser(), this.returnKey)
        : null;
    const realParams = returnUrl?.url.searchParams;
    const returning = !this.preview && isConnectionReturn();
    if (realParams) {
      const attempt = returnUrl!.attempt;
      this.realReturn = returnUrl!.verified ? null : attempt;
      this.returnError = realParams.get("error") ?? "";
      this.returnAccount = realParams.get("connectedAccountId") ?? "";
      if (attempt) {
        this.pickerState = { ...attempt.picker };
        this.restoreScrollTop = attempt.scrollTop;
        this.retryService = attempt.service;
        this.connectionOutcome = returnUrl!.verified ? "" : "checking";
      } else this.connectionOutcome = "expired";
      const clean = new URL(location.href);
      for (const key of ["composioReturn", "status", "error", "connectedAccountId"]) clean.searchParams.delete(key);
      history.replaceState(history.state, "", clean);
    }
    if (!this.preview) {
      window.addEventListener("focus", this.refreshConnections);
      document.addEventListener("visibilitychange", this.refreshConnections);
      if (!["slack", "slack-account"].includes(this.widget)) void this.loadConnections();
    }
    if (this.preview) {
      const visible = new URL(location.href);
      visible.searchParams.set("connectionDemo", "1");
      if (params.has("connectionConsent"))
        visible.searchParams.set("connectionConsent", params.get("connectionConsent")!);
      history.replaceState(history.state, "", visible);
    }
    const attempt = this.preview ? readPreviewAttempt(this.previewUser()) : null;
    if (this.preview && params.has("connectionConsent")) {
      this.consent = attempt?.state === params.get("connectionConsent") ? attempt : null;
      this.connectionOutcome = this.consent ? "" : "expired";
      this.requestUpdate();
      return;
    }
    if (this.preview && params.has("connectionReturn")) {
      if (attempt?.state === params.get("connectionReturn") && attempt.accountId === params.get("connectedAccountId")) {
        this.returned = attempt;
        this.retryService = attempt.service;
        this.pickerState = attempt.picker;
        this.connectionOutcome = "checking";
        window.setTimeout(() => {
          if (!this.isConnected) return;
          if (verifyPreviewAttempt(attempt)) {
            savePreviewConnection(attempt);
            this.connectionOutcome = "success";
          } else {
            this.connectionOutcome = params.get("error") === "access_denied" ? "cancelled" : "failed";
          }
          clearPreviewAttempt(attempt);
          this.drawPicker();
        }, 1000);
      } else this.connectionOutcome = "expired";
      const clean = new URL(location.href);
      for (const key of ["connectionReturn", "status", "error", "connectedAccountId"]) clean.searchParams.delete(key);
      history.replaceState(history.state, "", clean);
    } else if (
      !returning &&
      !this.setupOnly &&
      this.animateWelcome &&
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === false
    ) {
      this.classList.add("welcome-rolling");
    }
    if (!["slack", "slack-account"].includes(this.widget)) void this.loadCatalog().then(() => this.connectRequested());
  }
  private connectRequested(): void {
    const url = new URL(location.href);
    const service = this.services.find((item) => item.id === url.searchParams.get("connect"));
    if (!service) return;
    const replaces = url.searchParams.get("replaces") ?? undefined;
    url.searchParams.delete("connect");
    url.searchParams.delete("replaces");
    history.replaceState(history.state, "", url);
    void this.authorize(service, replaces);
  }
  private drawPicker(): void {
    const target = this.querySelector<HTMLElement>(".welcome-picker");
    const connected = this.preview
      ? previewConnections(this.previewUser())
      : this.connections.map((account) => account.toolkit);
    const stale = this.staleToolkits();
    const services = this.services.map((service) => ({
      ...service,
      connected: connected.includes(service.id),
      stale: stale.has(service.id),
    }));
    if (target && !this.error && !this.loading)
      mountConnectionPicker(
        target,
        services,
        (service) => this.authorize(service, this.staleAccount(service.id)),
        this.pickerState,
        !this.seeded,
        this.seeded ? 15 : 6,
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
    if (this.preview) return new Set();
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
      this.connectionError = errMessage(error, `Could not disconnect ${name}.`);
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
  private accountRows(accounts: ConnectedAccount[]): TemplateResult {
    return html`<div class="connection-connected" role="status" aria-live="polite">
      ${accounts.map((account) => {
        const service = this.services.find((item) => item.id === account.toolkit) ?? {
          id: account.toolkit,
          name: account.toolkit,
          description: "",
          popularity: 0,
        };
        const stale = Boolean(account.missingScopes?.length);
        return html`<span class=${stale ? "stale" : ""}
          >${icon(stale ? TriangleAlert : Check, 10)}${`${service.name} ${stale ? "needs new permissions" : "connected"}`}
          ${
            account.id
              ? connectionActions(
                  service.name,
                  Boolean(this.authorizing || this.disconnecting),
                  () => void this.authorize(service, account.id),
                  () => this.confirmDisconnect(account, service.name),
                )
              : nothing
          }</span
        >`;
      })}
    </div>`;
  }
  private card(notice: string, listed: ConnectedAccount[]): TemplateResult | undefined {
    if (this.widget !== "apps" || !this.toolkit || this.error) return undefined;
    const service = this.services.find((item) => item.id === this.toolkit);
    if (!service) return this.loading ? connectionCard({ id: this.toolkit }) : undefined;
    const accounts = listed.filter((account) => account.toolkit === service.id);
    const removable = accounts.filter((account) => account.id);
    const sole = removable.length === 1 ? removable[0] : undefined;
    const stale = this.staleToolkits().has(service.id);
    const checked = this.preview || this.connectionsChecked;
    const problem = this.connectionError || this.authorizationError;
    const connect = () => void this.authorize(service, sole?.id);
    let working = "";
    if (this.authorizing) working = `Opening ${service.name}…`;
    else if (this.disconnecting) working = "Disconnecting…";
    return html`${connectionCard(service, {
      outcome: this.connectionOutcome,
      notice,
      checked,
      connected: accounts.length > 0,
      stale,
      working,
      problem,
      connect,
      reconnect: sole && connect,
      disconnect: sole && (() => this.confirmDisconnect(sole, service.name)),
      recheck:
        (!checked && problem) || (!this.preview && this.connectionOutcome === "failed")
          ? () => void this.loadConnections()
          : undefined,
    })}${removable.length > 1 && !this.disconnecting ? this.accountRows(removable) : nothing}`;
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
      this.connectionsChecked = true;
      if (this.realReturn) {
        const attempt = this.realReturn;
        const verified = accounts.some(
          (account) => account.id === attempt.accountId && account.toolkit === attempt.service.id,
        );
        if (verified && (!this.returnAccount || this.returnAccount === attempt.accountId))
          this.connectionOutcome = "success";
        else this.connectionOutcome = this.returnError === "access_denied" ? "cancelled" : "failed";
        clearConnectionAttempt(this.previewUser());
        if (this.connectionOutcome === "success") {
          completeConnectionReturn(this.previewUser(), attempt.state);
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
      this.connectionsChecked = false;
      this.connectionOutcome = "";
      this.connectionError = errMessage(error, "Could not check connected apps.");
      await this.updateComplete;
      this.drawPicker();
    }
  }
  private async loadCatalog(): Promise<void> {
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    this.loading = true;
    this.error = "";
    const load = async (toolkit: string): Promise<ConnectionService[]> => {
      const services: ConnectionService[] = [];
      const cursors = new Set<string>();
      let cursor = "";
      do {
        if (cursors.has(cursor)) throw new Error("Could not finish loading apps. Please try again.");
        cursors.add(cursor);
        const query = new URLSearchParams({ cursor, ...(toolkit ? { toolkit } : {}) });
        const response = await fetch(`${this.base}api/composio/toolkits?${query}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.message ?? "App connections are unavailable right now. Please try again.");
        for (const item of result.items as Array<Omit<ConnectionService, "popularity">>) {
          if (item.id !== "slack" && !services.some((service) => service.id === item.id))
            services.push({ ...item, popularity: 100000 - services.length });
        }
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : "";
        if (cursors.size > 100) throw new Error("Could not finish loading apps. Please try again.");
      } while (cursor);
      return services;
    };
    try {
      const asked = this.widget === "apps" ? this.toolkit : "";
      let services = asked ? await load(asked) : [];
      if (services.length === 1) this.toolkit = services[0]!.id;
      else if (!services.some((service) => service.id === asked)) services = await load("");
      this.services = services;
    } catch (error) {
      if (controller.signal.aborted) return;
      this.error = errMessage(error, "Could not load apps. Please try again.");
    }
    if (!this.isConnected || controller.signal.aborted) return;
    this.loading = false;
    await this.updateComplete;
    this.drawPicker();
    const restoreTop = this.returned?.scrollTop ?? this.restoreScrollTop;
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
    if (service.connectUrl) {
      if (!(await openDesktopBrowser(service.connectUrl))) window.open(service.connectUrl, "_blank", "noopener");
      return;
    }
    if (this.preview) {
      startPreviewAttempt(this.previewUser(), service, this.pickerState, this.closest(".chat-scroll")?.scrollTop ?? 0);
      return;
    }
    this.authorizing = service.name;
    this.authorizationError = "";
    try {
      const handoff = new URLSearchParams({ connect: service.id, ...(replaces ? { replaces } : {}) });
      if (await openDesktopBrowser(`${this.base}settings?${handoff}`)) return;
      const state = crypto.randomUUID();
      const attempt: ConnectionAttempt = {
        state,
        user: this.previewUser(),
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
      this.authorizationError = errMessage(error, "Could not open authorization. Please try again.");
    } finally {
      this.authorizing = "";
    }
  }
  private get seeded(): ActivitySeeds | undefined {
    return this.setupOnly ? undefined : this.me?.welcome;
  }
  private async showAbout(about: boolean): Promise<void> {
    this.about = about;
    const scroller = this.closest(".chat-scroll");
    if (scroller) scroller.scrollTop = 0;
    await this.updateComplete;
    this.drawPicker();
  }
  private intro(greeting: string, toolkits: string[]) {
    const seeds = this.seeded;
    if (!seeds) return this.standardIntro(greeting);
    const names = new Map(this.services.map((service) => [service.id, service.name]));
    const { activities, fresh } = welcomeActivities(
      seeds,
      [
        ...(this.slackLinked ? [{ id: "slack", name: "Slack" }] : []),
        ...[...new Set(toolkits)].map((id) => ({ id, name: names.get(id) ?? id })),
      ],
      ["", "success"].includes(this.connectionOutcome) ? (this.retryService?.id ?? "") : "",
    );
    return html`<div class="welcome-hero welcome-beat" style="--welcome-delay:0ms">
        ${greeting ? html`<p>${greeting}</p>` : nothing}
        <h1>Welcome to QM! <img src=${`${this.base}qm.png`} alt="" /></h1>
        <p class="welcome-what">
          <button type="button" class="welcome-more-ideas" @click=${() => void this.showAbout(true)}>
            What is this?
          </button>
        </p>
      </div>
      <div class="welcome-section welcome-beat" style="--welcome-delay:300ms">
        <h2>Where to start</h2>
        ${this.me?.companyName?.trim() ? html`<h3>Ideas for ${this.me.companyName.trim()}</h3>` : nothing}
        ${suggestedActivities(activities, {
          onSelect: (activity) => this.onIdea?.(activity.prompt),
          redraw: () => this.requestUpdate(),
          count: activities.length,
          fresh,
        })}
      </div>
      <div class="welcome-section welcome-beat" style="--welcome-delay:600ms">
        <h2>Connect your accounts</h2>
        <p>It’s many times more useful with maximal context.</p>
      </div>`;
  }
  private standardIntro(greeting: string) {
    const purpose = `Use it to research customers, build tools, and automate the everyday work of running ${this.me?.companyName?.trim() || "your company"}.`;
    return html`${greeting ? html`<h1 class="welcome-beat" style="--welcome-delay:0ms">${greeting}</h1>` : nothing}
      <p class="welcome-beat" style="--welcome-delay:400ms">Welcome to ${HARNESS} ${purpose}</p>
      <p class="welcome-beat" style="--welcome-delay:700ms">The easiest way to get up and running:</p>`;
  }
  protected render() {
    if (this.preview && previewParameters().has("connectionConsent")) {
      return html`<section class="connection-consent-preview">
        <span class="connection-preview-label">Provider simulation · No account access</span>
        <h1>${this.consent ? `Connect ${this.consent.service.name}` : "This preview has expired"}</h1>
        <p>
          This stands in for the provider’s consent page. Choose an outcome to return to QM through the callback URL.
        </p>
        ${
          this.consent
            ? html`<div class="connection-preview-actions">
                  <button class="btn" @click=${() => finishPreviewAttempt(this.consent!, "success")}>
                    Approve connection
                  </button>
                  <button class="btn" @click=${() => finishPreviewAttempt(this.consent!, "cancelled")}>Cancel</button>
                  <button class="btn" @click=${() => finishPreviewAttempt(this.consent!, "failed")}>
                    Simulate provider error
                  </button>
                </div>
                <details>
                  <summary>Callback URL</summary>
                  <code>${this.consent.callbackUrl}</code>
                </details>`
            : nothing
        }
        <a href="?connectionDemo=1">Back to QM</a>
      </section>`;
    }
    if (this.about)
      return html`<qm-welcome-about .me=${this.me} .onBack=${() => void this.showAbout(false)}></qm-welcome-about>`;
    const name = firstName(this.me?.displayName);
    const seeds = this.seeded;
    const serviceName = this.retryService?.name ?? "App";
    const connected = this.preview
      ? previewConnections(this.previewUser())
      : this.connections.map((account) => account.toolkit);
    const listed = this.preview
      ? connected.map((toolkit) => ({ id: "", toolkit }) as ConnectedAccount)
      : this.connections;
    const connectedAccounts = this.loading ? [] : listed;
    const outcome = {
      "": { title: "", brief: "", detail: "" },
      checking: {
        title: `Checking ${serviceName} connection…`,
        brief: "Confirming access…",
        detail: "Confirming access before marking it connected.",
      },
      success: {
        title: `${serviceName} connected`,
        brief: "",
        detail: "",
      },
      cancelled: {
        title: `${serviceName} wasn’t connected`,
        brief: "Sign-in cancelled",
        detail: "You cancelled authorization. You can try again whenever you’re ready.",
      },
      expired: {
        title: "This connection attempt has expired",
        brief: "That sign-in expired",
        detail: "Choose an app below to start again.",
      },
      failed: {
        title: `Couldn’t connect ${serviceName}`,
        brief: "Couldn’t confirm the connection",
        detail: "We couldn’t confirm an active connection yet. Try checking again, or restart authorization.",
      },
    }[this.connectionOutcome];
    const card = this.card(outcome.brief, listed);
    return html`<section class="welcome-content ${seeds ? "welcome-seeded" : ""}">
      ${this.preview ? html`<div class="connection-preview-label">Connection preview · No accounts are linked <button @click=${() => resetPreview(this.previewUser())}>Reset</button></div>` : nothing}
      ${this.setupOnly ? nothing : this.intro(name ? `Hi ${name}!` : "", connected)}
      ${
        !["apps", "slack-account"].includes(this.widget) &&
        (this.me?.permissions?.includes("admin") || this.me?.permissions?.includes("owner"))
          ? html`<qm-onboarding-slack
              class="welcome-beat"
              style="--welcome-delay:900ms"
              @slack-installation-status=${(event: CustomEvent<{ connected: boolean }>) => {
                this.workspaceConnected = event.detail.connected;
              }}
            ></qm-onboarding-slack>`
          : nothing
      }
      ${this.widget === "slack-account" && this.workspaceError ? html`<p role="status">Could not check Slack setup. <button class="btn" @click=${() => void this.refreshWorkspace()}>Try again</button></p>` : nothing}
      ${this.widget === "slack-account" && this.workspaceConnected === false ? html`<p role="status">QM needs to be added to your company’s Slack workspace before you can link your account. Ask an administrator to finish setup.</p>` : nothing}
      <div class="welcome-beat" style="--welcome-delay:1100ms">
        ${this.workspaceConnected && this.widget !== "apps" && (["slack", "slack-account"].includes(this.widget) || (!this.loading && !this.error)) ? html`<qm-slack-account .user=${this.previewUser()} @slack-linked=${() => void this.refreshWorkspace()}></qm-slack-account>` : nothing}
      </div>
      ${
        card || ["slack", "slack-account"].includes(this.widget)
          ? (card ?? nothing)
          : html`<div class="welcome-beat welcome-apps" style="--welcome-delay:1300ms">
              ${this.loading ? html`<div class="welcome-load" role="status">Loading your available apps…</div>` : nothing}
              ${
                this.error
                  ? html`<div class="welcome-load">
                      ${this.seeded ? nothing : html`<strong>Connect your apps</strong>`}
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
              ${this.connectionError && !this.error && !this.loading ? html`<div class="welcome-connection-status" role="status">${this.connectionError} <button class="btn" @click=${() => void this.loadConnections()}>Check again</button></div>` : nothing}
              ${!this.preview && this.connectionOutcome === "failed" ? html`<button class="btn" @click=${() => void this.loadConnections()}>Check again</button>` : nothing}
              <div class="welcome-picker" ?inert=${Boolean(this.authorizing)}></div>
              ${connectedAccounts.length ? this.accountRows(connectedAccounts) : nothing}
              ${this.authorizing ? html`<p class="welcome-connection-status" role="status">Opening ${this.authorizing}…</p>` : nothing}
              ${this.authorizationError ? html`<p class="welcome-connection-status" role="alert">${this.authorizationError}</p>` : nothing}
            </div>`
      }
    </section>`;
  }
}
if (!customElements.get("qm-onboarding-welcome")) customElements.define("qm-onboarding-welcome", OnboardingWelcome);
