import { ArrowLeft, ArrowRight } from "lucide";
import { html, nothing, render, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { icon } from "./icons";
import { tip } from "./tooltip";

type NavigationLike = {
  canGoBack: boolean;
  canGoForward: boolean;
  addEventListener(type: "currententrychange", listener: () => void): void;
};

const navigationApi = () => (window as { navigation?: NavigationLike }).navigation;
const inDesktopApp = () => Boolean((window as { qmDesktop?: unknown }).qmDesktop);

let host: HTMLElement | undefined;
let listening = false;

function paint(): void {
  if (!host) return;
  const nav = navigationApi();
  render(
    html`<button
        class="icon-btn subtle history-btn"
        type="button"
        aria-label="Back"
        ${tip("Back")}
        ?disabled=${nav ? !nav.canGoBack : false}
        @click=${() => history.back()}
      >
        ${icon(ArrowLeft, 17)}
      </button>
      <button
        class="icon-btn subtle history-btn"
        type="button"
        aria-label="Forward"
        ${tip("Forward")}
        ?disabled=${nav ? !nav.canGoForward : false}
        @click=${() => history.forward()}
      >
        ${icon(ArrowRight, 17)}
      </button>`,
    host,
  );
}

function mount(element: Element | undefined): void {
  if (!element) return;
  host = element as HTMLElement;
  if (!listening) {
    listening = true;
    navigationApi()?.addEventListener("currententrychange", paint);
  }
  paint();
}

export function desktopHistoryNav(): TemplateResult | typeof nothing {
  if (!inDesktopApp()) return nothing;
  return html`<div class="history-nav" ${ref(mount)}></div>`;
}
