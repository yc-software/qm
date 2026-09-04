import { html, nothing, type TemplateResult } from "lit";

export interface ForkOriginView {
  title: string;
  messageCount?: number;
  expanded: boolean;
  icon?: unknown;
  navigate(): void;
  toggle(): void;
}

export interface ForkOriginState<T> {
  inheritedMessages: T[];
  inheritedLoaded: boolean;
  inheritedExpanded: boolean;
}

export function createForkOriginController<T>(options: {
  state: ForkOriginState<T>;
  load(): Promise<T[]>;
  navigate(): Promise<void>;
  current(): boolean;
  redraw(): void;
  setError(error: string): void;
}) {
  let refreshGeneration = 0;
  let toggleGeneration = 0;
  let loadingGeneration: number | null = null;
  return {
    reset() {
      options.setError("");
      toggleGeneration++;
      loadingGeneration = null;
    },
    beginRefresh() {
      return ++refreshGeneration;
    },
    invalidateRefresh() {
      refreshGeneration++;
    },
    isCurrentRefresh(generation: number) {
      return generation === refreshGeneration && options.current();
    },
    applyRefresh(generation: number, messages: T[] | null) {
      if (generation !== refreshGeneration || !options.current()) return false;
      if (messages) options.state.inheritedMessages = messages;
      return true;
    },
    async navigate() {
      try {
        await options.navigate();
      } catch {
        options.setError("You no longer have access to the original conversation.");
        options.redraw();
      }
    },
    async toggle() {
      if (loadingGeneration !== null) return;
      options.setError("");
      if (!options.state.inheritedExpanded && !options.state.inheritedLoaded) {
        const generation = ++toggleGeneration;
        loadingGeneration = generation;
        try {
          const messages = await options.load();
          if (generation !== toggleGeneration || !options.current()) return;
          options.state.inheritedMessages = messages;
          options.state.inheritedLoaded = true;
        } catch {
          if (generation === toggleGeneration && options.current()) {
            options.setError("Couldn't load the original conversation's history.");
            options.redraw();
          }
          return;
        } finally {
          if (loadingGeneration === generation) loadingGeneration = null;
        }
      }
      options.state.inheritedExpanded = !options.state.inheritedExpanded;
      options.redraw();
    },
  };
}

export function forkOriginView(view: ForkOriginView | null): TemplateResult | typeof nothing {
  if (!view) return nothing;
  return html`<div class="fork-origin-row">
    <button class="fork-origin-badge" type="button" @click=${view.navigate}>
      ${view.icon ?? nothing}<span>Forked from ${view.title}</span>${
        view.messageCount ? html`<span>· ${view.messageCount} messages</span>` : nothing
      }
    </button>
    <button class="fork-origin-toggle" type="button" @click=${view.toggle}>${view.expanded ? "hide" : "show"}</button>
  </div>`;
}
