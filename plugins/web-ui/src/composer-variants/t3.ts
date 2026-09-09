import { html, nothing } from "lit";
import { Brain, ChevronDown, ChevronUp, Eye, Paperclip, Search, Zap } from "lucide";
import type { ComposerParts, ComposerVariantModule, Tpl } from "../composer-parts";
import type { ModelOption } from "../model-options";
import { icon } from "../ui.ts";

const FAVORITES = 4;
const PICKER = "picker";

let showAll = false;

function badges(p: ComposerParts, { model }: ModelOption): Tpl {
  return html`<span class="t3-badges">
    ${model.input.includes("image") ? html`<span class="t3-badge vision" title="Vision">${icon(Eye, 12)}</span>` : nothing}
    ${model.reasoning ? html`<span class="t3-badge reason" title="Reasoning">${icon(Brain, 12)}</span>` : nothing}
    ${p.models.supportsFast(model.id) ? html`<span class="t3-badge fast" title="Fast">${icon(Zap, 12)}</span>` : nothing}
    ${model.contextWindow >= 1_000_000 ? html`<span class="t3-badge ctx" title="1M context">1M</span>` : nothing}
  </span>`;
}

function modelRow(p: ComposerParts, option: ModelOption): Tpl {
  const selected = option.value === p.models.selected.value;
  return html`<button
    class="t3-model"
    type="button"
    role="menuitemradio"
    aria-checked=${selected ? "true" : "false"}
    @click=${() => p.models.select(option.value)}
  >
    <span class="t3-mark" aria-hidden="true">${option.model.provider.charAt(0).toUpperCase()}</span>
    <span class="t3-model-name">${option.label}</span>
    ${badges(p, option)}
  </button>`;
}

function section(p: ComposerParts, label: string, options: ModelOption[]): Tpl {
  if (!options.length) return nothing;
  return html`<div class="menu-group-label">${label}</div>
    ${options.map((option) => modelRow(p, option))}`;
}

function picker(p: ComposerParts): Tpl {
  const query = p.menu.query.trim().toLocaleLowerCase();
  const matching = (options: ModelOption[]) =>
    query
      ? options.filter((o) => `${o.label} ${o.groupLabel} ${o.harnessLabel}`.toLocaleLowerCase().includes(query))
      : options;
  const favorites = p.models.all.filter((o) => o.harnessId === p.models.selected.harnessId).slice(0, FAVORITES);
  const others = p.models.all.filter((o) => !favorites.includes(o));
  const shownFavorites = matching(favorites);
  const shownOthers = matching(others);
  const expanded = showAll || query.length > 0;
  const toggleShowAll = () => {
    showAll = !showAll;
    p.menu.setQuery(p.menu.query, PICKER);
  };
  return html`<div
    class="menu-popover"
    id="composer-picker-menu"
    role="menu"
    @click=${(e: Event) => e.stopPropagation()}
  >
    <label class="menu-search t3-search">
      ${icon(Search, 14)}
      <span class="sr-only">Search models</span>
      <input
        type="search"
        placeholder="Search models..."
        .value=${p.menu.query}
        @input=${(e: Event) => p.menu.setQuery((e.currentTarget as HTMLInputElement).value, PICKER)}
      />
    </label>
    ${query && !shownFavorites.length && !shownOthers.length ? html`<div class="menu-empty">No models found</div>` : nothing}
    ${section(p, "Favorites", shownFavorites)} ${expanded ? section(p, "Others", shownOthers) : nothing}
    ${
      others.length && !query
        ? html`<button class="t3-show-all" type="button" @click=${toggleShowAll}>
            ${showAll ? "Show less" : "Show all"} ${icon(showAll ? ChevronUp : ChevronDown, 14)}
          </button>`
        : nothing
    }
  </div>`;
}

export const t3: ComposerVariantModule = {
  render: (p) => {
    const open = p.menu.open === PICKER && !p.inputBlocked;
    return html`
      <form class="composer-wrap" data-composer="t3" @submit=${p.onSubmit}>
        ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.attachments} ${p.approvals} ${p.textarea}
        <div class="t3-row">
          <div class="t3-row-left">
            <div class="menu-control" data-align="left" data-drop="up">
              <button
                class="t3-model-trigger"
                type="button"
                aria-haspopup="menu"
                aria-expanded=${open ? "true" : "false"}
                aria-controls="composer-picker-menu"
                ?disabled=${p.inputBlocked}
                @click=${(e: Event) => p.menu.toggle(e, PICKER)}
              >
                <span class="t3-model-label">${p.models.selected.buttonLabel}</span>
                ${icon(ChevronDown, 14)}
              </button>
              ${open ? picker(p) : nothing}
            </div>
            ${
              p.fast.supported
                ? html`<button
                    class="t3-fast"
                    type="button"
                    aria-pressed=${p.fast.on ? "true" : "false"}
                    aria-disabled=${p.fast.available ? "false" : "true"}
                    ?disabled=${p.inputBlocked}
                    @click=${() => p.fast.toggle()}
                  >
                    ${icon(Zap, 14)} Fast
                  </button>`
                : nothing
            }
            ${p.fileInput}
            <button
              class="icon-btn t3-attach"
              type="button"
              aria-label="Attach files"
              ?disabled=${p.attachingDisabled}
              @click=${() => p.pickFiles()}
            >
              ${icon(Paperclip, 16)}
            </button>
            ${p.defaultButtons}
          </div>
          <div class="t3-row-right">${p.sendControls}</div>
        </div>
        ${p.notice}
      </form>
      ${p.pasteDialog}
    `;
  },
};
