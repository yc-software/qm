import { openDesktopBrowser } from "../../chassis/src/desktop-browser.ts";
import { LitElement, html, nothing } from "lit";
import { ArrowUpRight, Check, Link2, UserRound } from "lucide";
import { discordMark } from "./discord-mark.ts";
import { icon } from "./icons.ts";
import { withBase } from "./core-bridge.ts";
import "./slack-account.css";
import {
  clearAttempt,
  createReturnCapture,
  loadAttempt,
  saveAttempt,
  watchVisible,
  type OAuthAttempt,
} from "./oauth-attempt.ts";

interface LinkStatus {
  available: boolean;
  linked: boolean;
  canUnlink: boolean;
  tag?: string;
}

interface DiscordAttempt extends OAuthAttempt {
  nonce: string;
}

const ATTEMPT_KEY = "qm-discord-account";
const ATTEMPT_TTL_MS = 10 * 60_000;
const RETURN_KEYS = ["code", "state", "error", "error_description"];
const discordReturn = createReturnCapture((p) => p.has("state") && (p.has("code") || p.has("error")));

const LINK_UNAVAILABLE = "Discord linking isn't set up. Ask an administrator.";

function discordErrorMessage(error?: string, fallback = "Couldn't connect Discord."): string {
  if (error === "link_unavailable") return LINK_UNAVAILABLE;
  return fallback;
}

export const captureDiscordReturn = discordReturn.capture;

export class DiscordAccount extends LitElement {
  static properties = { user: {}, status: { state: true }, note: { state: true }, busy: { state: true } };
  user = "";
  navigate: (url: string) => void = (url) => window.location.assign(url);
  private status: LinkStatus | null = null;
  private note = "";
  private busy = false;
  private unwatch = (): void => {};

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.unwatch = watchVisible(() => void this.load());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unwatch();
  }

  protected firstUpdated(): void {
    const url = discordReturn.take();
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const cancelled = url.searchParams.has("error");
    if (!state || (!code && !cancelled)) return void this.load();
    const current = new URL(location.href);
    for (const key of RETURN_KEYS) current.searchParams.delete(key);
    history.replaceState(history.state, "", current);
    const attempt = loadAttempt<DiscordAttempt>(ATTEMPT_KEY, this.user);
    clearAttempt(ATTEMPT_KEY);
    if (!attempt || attempt.state !== state) {
      this.note =
        "This connection expired or was started in another QM account. Sign in to the account you want to connect and try again.";
      return void this.load();
    }
    if (cancelled || !code) {
      this.note = "Discord authorization was cancelled. Your QM account has not been linked.";
      return void this.load();
    }
    void this.complete(code, state, attempt.nonce);
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(withBase("/api/discord/link"), {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      this.status = res.ok ? ((await res.json()) as LinkStatus) : { available: false, linked: false, canUnlink: false };
    } catch {
      this.status = { available: false, linked: false, canUnlink: false };
    }
  }

  private async connect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.note = "";
    try {
      if (await openDesktopBrowser(withBase("/settings"))) return;
      const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
      const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
      const nonceHash = Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, "0")).join("");

      const res = await fetch(withBase("/api/discord/link/authorize"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonceHash }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = (await res.json().catch(() => ({}))) as { url?: string; message?: string; error?: string };
      if (!res.ok || !result.url)
        throw Error(
          result.message || discordErrorMessage(result.error, "Couldn't start the Discord connection. Try again."),
        );
      const url = new URL(result.url);
      const state = url.searchParams.get("state");
      const redirectUri = url.searchParams.get("redirect_uri");
      const expectedRedirectUri = new URL(withBase("/settings"), location.origin).href;
      if (
        url.protocol !== "https:" ||
        url.hostname !== "discord.com" ||
        url.pathname !== "/oauth2/authorize" ||
        url.username ||
        url.password ||
        !state ||
        redirectUri !== expectedRedirectUri
      )
        throw Error("Could not verify the Discord authorization link.");
      saveAttempt(ATTEMPT_KEY, { user: this.user, state, nonce, expiresAt: Date.now() + ATTEMPT_TTL_MS });
      this.navigate(url.href);
    } catch (error) {
      this.note = error instanceof Error ? error.message : "Couldn't connect Discord.";
    } finally {
      this.busy = false;
    }
  }

  private async complete(code: string, state: string, nonce: string): Promise<void> {
    this.busy = true;
    try {
      const res = await fetch(withBase("/api/discord/link/complete"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, state, nonce }),
        signal: AbortSignal.timeout(45_000),
      });
      const result = (await res.json().catch(() => ({}))) as { tag?: string; message?: string; error?: string };
      if (!res.ok) {
        const msg =
          result.message || discordErrorMessage(result.error, "Could not verify your Discord account. Try again.");
        throw Error(msg);
      }
      await this.load();
    } catch (error) {
      this.note = error instanceof Error ? error.message : "Could not verify your Discord account.";
      await this.load();
    } finally {
      this.busy = false;
    }
  }

  private async disconnect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await fetch(withBase("/api/discord/link"), { method: "DELETE", signal: AbortSignal.timeout(10_000) });
      const result = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        const msg = result.message || discordErrorMessage(result.error, "Couldn't disconnect. Try again.");
        throw Error(msg);
      }
      this.note = "Discord disconnected.";
      await this.load();
    } catch (error) {
      this.note = error instanceof Error ? error.message : "Couldn't disconnect. Try again.";
    } finally {
      this.busy = false;
    }
  }

  private renderLinked(s: LinkStatus) {
    const onClick = () => void this.disconnect();
    const disconnect = html`<button class="btn" ?disabled=${this.busy} @click=${onClick}>${"Disconnect"}</button>`;
    return html`<div class="slack-connected" role="status">
      ${icon(Check, 14)}<span>Connected as ${s.tag ?? "your Discord account"}</span>
      ${s.canUnlink ? disconnect : html`<small>Linked by an administrator.</small>`}
    </div>`;
  }

  private renderConnect() {
    return html`<button class="welcome-slack" type="button" ?disabled=${this.busy} @click=${() => void this.connect()}>
      <div class="slack-link-icon" aria-hidden="true">
        <span class="slack-link-person">${icon(UserRound, 17)}</span>
        <span class="slack-link-service">${discordMark(18)}</span>
        <span class="slack-link-chain">${icon(Link2, 13)}</span>
      </div>
      <span
        ><strong>${this.busy ? "Linking Discord…" : "Link your Discord account"}</strong
        ><small>Reach QM from Discord as yourself.</small></span
      >
      ${icon(ArrowUpRight, 16)}
    </button>`;
  }

  render() {
    const s = this.status;
    if (!s) return nothing;
    if (!s.linked && !s.available && this.note !== LINK_UNAVAILABLE) return nothing;
    let body;
    if (s.linked) body = this.renderLinked(s);
    else if (s.available) body = this.renderConnect();
    else body = nothing;
    return html`<section class="slack-account" aria-label="Your Discord account">
      ${body} ${this.note ? html`<p class="slack-account-error" role="alert">${this.note}</p>` : nothing}
    </section>`;
  }
}

if (!customElements.get("qm-discord-account")) customElements.define("qm-discord-account", DiscordAccount);
