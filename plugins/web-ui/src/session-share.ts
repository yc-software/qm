import { html, render } from "lit";
import { X, Link, Copy, Check, Users, Globe, ChevronDown } from "lucide";
import { icon, toggleFormMenu, closeFormMenus } from "./ui";
import { api, withBase } from "./core-bridge";

interface ShareState {
  share: { token: string; audience: "internal" | "external"; createdAt: number } | null;
}

export async function openSessionShare(id: string): Promise<void> {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog session-share-dialog";
  document.body.append(dialog);
  const chat = document.getElementById("main");
  const position = () => {
    const bounds = chat?.getBoundingClientRect();
    const left = Math.max(0, bounds?.left ?? 0);
    const right = Math.min(window.innerWidth, bounds?.right ?? window.innerWidth);
    dialog.style.left = `${left}px`;
    dialog.style.right = `${window.innerWidth - right}px`;
    dialog.style.setProperty("--share-dialog-space", `${right - left}px`);
  };
  const resize = new ResizeObserver(position);
  if (chat) resize.observe(chat);
  window.addEventListener("resize", position);
  position();
  let state: ShareState = { share: null };
  let busy = false;
  let audience = "internal";
  let error = "";
  let copied = false;
  const endpoint = `/api/sessions/${encodeURIComponent(id)}/share`;
  const close = () => {
    resize.disconnect();
    window.removeEventListener("resize", position);
    closeFormMenus();
    dialog.close();
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  };
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !dialog.querySelector(".form-menu-control.open")) return;
    event.preventDefault();
    event.stopPropagation();
    closeFormMenus();
    dialog.querySelector<HTMLButtonElement>(".share-audience-button")?.focus();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  const change = async () => {
    busy = true;
    error = "";
    copied = false;
    draw();
    try {
      state = await api<ShareState>(endpoint, { method: "POST", body: JSON.stringify({ audience }) });
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not create share.";
    } finally {
      busy = false;
      draw();
    }
  };
  const draw = () => {
    const saveLabel = state.share ? "Create new link" : "Create link";
    const url = state.share
      ? new URL(withBase(`/share/${state.share.audience}/${state.share.token}`), location.origin).href
      : "";
    render(
      html`
        <div class="project-dialog-head">
          <div><h2 id="session-share-heading">Share conversation</h2></div>
          <button class="chip-x" type="button" aria-label="Close" @click=${close}>${icon(X, 16)}</button>
        </div>
        <div class="share-access-row">
          <span class="share-access-icon">${icon(audience === "external" ? Globe : Users, 18)}</span>
          <div class="form-menu-control menu-control share-audience" data-drop="down">
            <button
              class="btn menu-button share-audience-button"
              type="button"
              aria-label="Who can view"
              aria-haspopup="menu"
              aria-expanded="false"
              ?disabled=${busy}
              @click=${toggleFormMenu}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const control = (event.currentTarget as HTMLElement).parentElement!;
                if (!control.classList.contains("open")) toggleFormMenu(event);
                const options = control.querySelectorAll<HTMLButtonElement>(".menu-option");
                options[event.key === "ArrowUp" ? options.length - 1 : 0]?.focus();
              }}
            >
              <span>${audience === "external" ? "Anyone with the link" : "Anyone in your organization"}</span
              >${icon(ChevronDown, 14)}
            </button>
            <div
              class="menu-popover share-audience-menu"
              role="menu"
              aria-label="Who can view"
              hidden
              @keydown=${(event: KeyboardEvent) => {
                const options = [
                  ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(".menu-option"),
                ];
                const index = options.indexOf(document.activeElement as HTMLButtonElement);
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  let next = (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
                  if (event.key === "Home") next = 0;
                  if (event.key === "End") next = options.length - 1;
                  options[next]?.focus();
                }
              }}
            >
              ${(["internal", "external"] as const).map(
                (value) =>
                  html`<button
                    type="button"
                    role="menuitemradio"
                    aria-checked=${audience === value}
                    class=${`menu-option ${audience === value ? "active" : ""}`}
                    @click=${() => {
                      audience = value;
                      state = { share: null };
                      copied = false;
                      error = "";
                      closeFormMenus();
                      draw();
                      dialog.querySelector<HTMLButtonElement>(".share-audience-button")?.focus();
                    }}
                  >
                    ${icon(value === "external" ? Globe : Users, 16)}<span class="menu-option-label"
                      >${value === "external" ? "Anyone with the link" : "Anyone in your organization"}</span
                    >${audience === value ? icon(Check, 15) : ""}
                  </button>`,
              )}
            </div>
          </div>
          <span class="share-access-label">Can view</span>
        </div>
        ${audience === "external" ? html`<p class="share-external-warning" role="status">⚠️ External. Double-check what you're sharing.</p>` : ""}
        ${
          state.share
            ? html`
                <div class="share-link-row project-name-field">
                  <input
                    aria-label="Share link"
                    readonly
                    .value=${url}
                    @click=${(e: Event) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    class="btn primary"
                    type="button"
                    ?disabled=${busy}
                    @click=${async () => {
                      try {
                        await navigator.clipboard.writeText(url);
                        copied = true;
                      } catch {
                        error = "Could not copy. Select and copy the link above.";
                      }
                      draw();
                    }}
                  >
                    ${icon(copied ? Check : Copy, 14)}${copied ? "Copied" : "Copy link"}
                  </button>
                </div>
              `
            : ""
        }
        <p class="share-privacy-note">
          Subsequent messages will not be visible unless you re-share.
          ${url ? html`<a class="as-link" href=${url} target="_blank" rel="noreferrer">Preview</a>` : ""}
        </p>
        ${error ? html`<div class="composer-error" role="alert">${error}</div>` : ""}
        <div class="project-dialog-actions actions">
          <button
            class=${state.share ? "btn" : "btn primary"}
            type="button"
            ?disabled=${busy}
            @click=${() => void change()}
          >
            ${!state.share ? icon(Link, 14) : ""}${busy ? "Loading…" : saveLabel}
          </button>
        </div>
      `,
      dialog,
    );
  };
  dialog.setAttribute("aria-labelledby", "session-share-heading");
  draw();
  dialog.showModal();
}
