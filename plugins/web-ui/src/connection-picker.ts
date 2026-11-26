import { html, nothing, render } from "lit";
import { Search, ArrowUpRight, Check, RefreshCw } from "lucide";
import { connectorLogo } from "./connector-logo";
import { icon } from "./icons";
import type { PickerState } from "./connection-preview";

export interface ConnectionService {
  id: string;
  name: string;
  description: string;
  popularity: number;
  logoUrl?: string;
  connectUrl?: string;
  connected?: boolean;
  stale?: boolean;
}

export function mountConnectionPicker(
  container: HTMLElement,
  services: ConnectionService[],
  onSelect: (service: ConnectionService) => void,
  state: PickerState = { query: "" },
  titled = true,
  popular = 6,
): void {
  let query = state.query;
  const sorted = [...services].sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name));
  function draw(): void {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = sorted.filter((service) => {
      const text = `${service.name} ${service.description}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
    const shown = words.length ? matches : matches.slice(0, popular);
    render(
      html`<section class="connection-picker" aria-label="Connect your apps">
        ${
          titled
            ? html`<header class="connection-picker-header">
                <div>
                  <h3>Connect your apps</h3>
                </div>
              </header>`
            : nothing
        }
        <div class="connection-picker-caption" role="status" aria-live="polite">
          ${words.length ? `${matches.length} ${matches.length === 1 ? "app" : "apps"} found` : "Popular apps"}
        </div>
        <div class="connection-picker-grid">
          ${shown.map((service) => {
            let action = { label: `Connect ${service.name}`, mark: ArrowUpRight };
            if (service.stale) action = { label: `Reconnect ${service.name}`, mark: RefreshCw };
            else if (service.connected) action = { label: `${service.name} connected`, mark: Check };
            return html`<button
              type="button"
              class=${service.stale ? "connection-picker-app stale" : "connection-picker-app"}
              ?disabled=${service.connected && !service.stale}
              aria-label=${action.label}
              @click=${() => onSelect(service)}
            >
              ${connectorLogo(service.id, service.logoUrl)}
              <span class="connection-picker-name">${service.name}</span>
              <span class="connection-picker-trailing">${icon(action.mark, 14)}</span>
            </button>`;
          })}
        </div>
        ${matches.length === 0 ? html`<p class="connection-picker-empty">No apps match “${query}”. Try another name.</p>` : nothing}
        <label class="connection-picker-search">
          ${icon(Search, 16)}
          <input
            type="search"
            aria-label="Search apps"
            placeholder=${`Search ${services.length} apps`}
            .value=${query}
            @input=${(event: Event) => {
              query = (event.target as HTMLInputElement).value;
              state.query = query;
              draw();
            }}
          />
        </label>
      </section>`,
      container,
    );
  }
  draw();
}
