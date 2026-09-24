import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { isPhone } from "./viewport";
import { hideTooltip } from "./tooltip";
import { trapDialogFocus } from "./dialog-focus";
import { repeat } from "lit/directives/repeat.js";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  GripVertical,
  House,
  Folder,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide";
import { icon } from "./ui";
import { tip } from "./tooltip";
import {
  acceptsProjects,
  defaultSidebarLayout,
  removeSidebarTab,
  reorderSidebarEntries,
  moveSidebarProject,
  removeSidebarSection,
  reorderSidebarSections,
  type SidebarSection,
  type SidebarSort,
  type SidebarLayout,
} from "./sidebar-model";
import { loadSidebarState, notifySidebar, saveSidebarState, sidebarState, updateSidebarLayout } from "./sidebar-state";

let customizationScroll = 0;
let editingTabs = false;

function closeSectionMenu(restoreFocus = false): void {
  const id = sidebarState.sectionMenu;
  sidebarState.sectionMenu = null;
  notifySidebar();
  if (restoreFocus && id)
    queueMicrotask(() => document.querySelector<HTMLElement>(`[aria-controls="sidebar-options-${id}"]`)?.focus());
}

function positionSectionMenu(element: HTMLElement): void {
  const anchor = document.querySelector(`[aria-controls="${element.id}"]`)?.getBoundingClientRect();
  if (!anchor) return;
  element.style.maxHeight = "";
  const bounds = element.getBoundingClientRect();
  let top = Math.max(8, Math.min(anchor.bottom + 5, window.innerHeight - bounds.height - 8));
  if (isPhone()) {
    element.style.left = "12px";
    top = Math.max(12, window.innerHeight - bounds.height - 12);
  } else element.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
  element.style.top = `${top}px`;
  element.style.maxHeight = `${Math.max(100, window.innerHeight - top - 12)}px`;
}

function placeSectionMenu(element?: Element): void {
  if (!(element instanceof HTMLElement)) return;
  queueMicrotask(() => {
    if (!element.isConnected || element.dataset.sectionMenu !== sidebarState.sectionMenu) return;
    element.showPopover?.();
    positionSectionMenu(element);
    element.querySelector<HTMLElement>("select, input, button")?.focus();
  });
}

window.addEventListener("resize", () => {
  const element = document.getElementById(`sidebar-options-${sidebarState.sectionMenu}`);
  if (element) positionSectionMenu(element);
});
let draggedItem: { sectionId: string; key: string } | null = null;
const expandedLists = new Set<string>();
const SECTION_DRAG = "application/x-qm-sidebar-section";
export const PROJECT_DRAG = "application/x-qm-sidebar-project";

export function changeSidebarSection(
  id: string,
  patch: Partial<
    Pick<
      SidebarSection,
      | "name"
      | "hidden"
      | "collapsed"
      | "sort"
      | "projects"
      | "tabId"
      | "icon"
      | "limit"
      | "items"
      | "scopeId"
      | "query"
      | "status"
    >
  >,
): void {
  if (patch.limit !== undefined) expandedLists.delete(id);
  if (patch.tabId && patch.tabId !== sidebarState.layout.activeTab && sidebarState.sectionMenu === id)
    sidebarState.sectionMenu = null;
  updateSidebarLayout((layout) => ({
    ...layout,
    sections: layout.sections.map((section) => (section.id === id ? { ...section, ...patch } : section)),
  }));
}

export function toggleSidebarCustomization(): void {
  sidebarState.sectionMenu = null;
  hideTooltip();
  if (!sidebarState.customizing) customizationScroll = document.getElementById("sidebar-body")?.scrollTop ?? 0;
  sidebarState.customizing = !sidebarState.customizing;
  notifySidebar();
  queueMicrotask(() => {
    const list = document.getElementById("sidebar-body");
    if (list) list.scrollTop = sidebarState.customizing ? 0 : customizationScroll;
    document
      .querySelector<HTMLElement>(sidebarState.customizing ? ".sidebar-customization summary" : ".sidebar-customize")
      ?.focus({ preventScroll: true });
  });
}

export function sidebarControls(): TemplateResult {
  return html` ${
      sidebarState.notice
        ? html`<div class="sidebar-save-error" role="alert">
            ${sidebarState.notice}
            <button
              type="button"
              @click=${() => {
                sidebarState.notice = "";
                notifySidebar();
              }}
            >
              Dismiss
            </button>
          </div>`
        : nothing
    }
    ${
      sidebarState.error
        ? html`<div class="sidebar-save-error" role="alert">
            ${sidebarState.error}
            <button
              type="button"
              @click=${() => (sidebarState.loaded ? void saveSidebarState() : void loadSidebarState())}
            >
              Retry
            </button>
          </div>`
        : nothing
    }
    <button
      class="navrow sidebar-customize ${sidebarState.customizing ? "customizing" : ""}"
      type="button"
      ?disabled=${!sidebarState.loaded}
      aria-pressed=${sidebarState.customizing}
      @click=${toggleSidebarCustomization}
    >
      ${icon(sidebarState.customizing ? Check : SlidersHorizontal, 15)}<span
        >${sidebarState.customizing ? "Done" : "Customize sidebar"}</span
      >
      ${sidebarState.saving ? html`<small role="status">Saving…</small>` : nothing}
    </button>`;
}

function moveSectionBy(id: string, direction: -1 | 1): void {
  const sections = sidebarState.layout.sections.filter((section) => section.tabId === sidebarState.layout.activeTab);
  const index = sections.findIndex((section) => section.id === id);
  const target = sections[index + direction];
  if (!target) return;
  updateSidebarLayout((layout) =>
    direction < 0 ? reorderSidebarSections(layout, id, target.id) : reorderSidebarSections(layout, target.id, id),
  );
  queueMicrotask(() =>
    document.querySelector<HTMLElement>(`[data-section-id="${id}"] [data-direction="${direction}"]`)?.focus(),
  );
}

function addSection(event: SubmitEvent): void {
  event.preventDefault();
  const input = (event.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>("input")!;
  const name = input.value.trim();
  if (!name || sidebarState.layout.sections.length >= 29) {
    input.focus();
    return;
  }
  const section: SidebarSection = {
    id: `custom-${crypto.randomUUID()}`,
    name,
    kind: "custom",
    hidden: false,
    collapsed: false,
    sort: "manual",
    projects: [],
    tabId: sidebarState.layout.activeTab,
    icon: "",
    limit: 10,
    items: [],
    scopeId: "",
    query: "",
    status: "all",
  };
  const source =
    (event.currentTarget as HTMLFormElement).querySelector<HTMLSelectElement>("select")?.value ?? "projects";
  if (source !== "projects") {
    section.kind = "chats";
    section.sort = "recent";
    section.scopeId = source === "chats" ? "" : source;
  }
  updateSidebarLayout((layout) => {
    const sections = [...layout.sections];
    sections.splice(
      sections.findIndex((item) => item.kind === "private"),
      0,
      section,
    );
    return { ...layout, sections };
  });
  input.value = "";
  input.focus();
}

export interface SidebarChoice {
  target: string;
  name: string;
  icon: string;
}

function tabSelect(label: string, value: string, change: (value: string) => void): TemplateResult {
  return html`<label
    >Move to tab<select
      aria-label=${label}
      @change=${(event: Event) => change((event.currentTarget as HTMLSelectElement).value)}
    >
      ${sidebarState.layout.tabs.map((tab) => html`<option value=${tab.id} ?selected=${tab.id === value}>${tab.name}</option>`)}
    </select></label
  >`;
}

function tabDestination(
  label: string,
  value: string,
  change: (value: string) => void,
): TemplateResult | typeof nothing {
  if (sidebarState.layout.tabs.length < 2) return nothing;
  return html`<details
    class="sidebar-row-settings"
    @keydown=${(event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      const details = event.currentTarget as HTMLDetailsElement;
      details.open = false;
      details.querySelector("summary")?.focus();
    }}
  >
    <summary aria-label=${label.replace("Tab for", "Options for")}>${icon(Ellipsis, 14)}</summary>
    <div>
      ${tabSelect(label, value, (next) => {
        document.querySelectorAll<HTMLDetailsElement>(".sidebar-row-settings[open]").forEach((details) => {
          details.open = false;
        });
        change(next);
      })}
    </div>
  </details>`;
}

function moveEntry(collection: "tabs" | "shortcuts", id: string, before: string): void {
  updateSidebarLayout(
    (layout) =>
      ({
        ...layout,
        [collection]: reorderSidebarEntries<{ id: string }>(layout[collection], id, before),
      }) as SidebarLayout,
  );
}

function entryOrder(
  collection: "tabs" | "shortcuts",
  entries: { id: string; name: string }[],
  index: number,
): TemplateResult {
  const entry = entries[index]!;
  return html`<button
      class="sidebar-small-button"
      aria-label=${`Move ${entry.name} ${collection === "tabs" ? "tab" : "shortcut"} left or up`}
      ?disabled=${index === 0}
      @click=${() => moveEntry(collection, entry.id, entries[index - 1]!.id)}
    >
      ${icon(ArrowUp, 13)}
    </button>
    <button
      class="sidebar-small-button"
      aria-label=${`Move ${entry.name} ${collection === "tabs" ? "tab" : "shortcut"} right or down`}
      ?disabled=${index === entries.length - 1}
      @click=${() => moveEntry(collection, entries[index + 1]!.id, entry.id)}
    >
      ${icon(ArrowDown, 13)}
    </button>`;
}

function selectSidebarTab(id: string): void {
  sidebarState.sectionMenu = null;
  hideTooltip();
  updateSidebarLayout((layout) => ({ ...layout, activeTab: id }));
}

export function sidebarTabs(): TemplateResult {
  const layout = sidebarState.layout;
  return html`<div
    class="sidebar-tabs"
    role="tablist"
    aria-label="Sidebar tabs"
    @keydown=${(event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = layout.tabs.findIndex((tab) => tab.id === layout.activeTab);
      let next = (index + (event.key === "ArrowRight" ? 1 : layout.tabs.length - 1)) % layout.tabs.length;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = layout.tabs.length - 1;
      selectSidebarTab(layout.tabs[next]!.id);
      queueMicrotask(() => document.querySelector<HTMLElement>('.sidebar-tabs [aria-selected="true"]')?.focus());
    }}
  >
    ${layout.tabs.map(
      (tab) =>
        html`<button
          type="button"
          role="tab"
          aria-selected=${tab.id === layout.activeTab}
          aria-controls="sidebar-body"
          aria-label=${tab.name}
          tabindex=${tab.id === layout.activeTab ? 0 : -1}
          draggable="true"
          @dragstart=${(event: DragEvent) => event.dataTransfer?.setData("application/x-qm-sidebar-tab", tab.id)}
          @dragover=${(event: DragEvent) => {
            if (event.dataTransfer?.types.includes("application/x-qm-sidebar-tab")) event.preventDefault();
          }}
          @drop=${(event: DragEvent) => {
            const id = event.dataTransfer?.getData("application/x-qm-sidebar-tab");
            if (id) {
              event.preventDefault();
              moveEntry("tabs", id, tab.id);
            }
          }}
          @contextmenu=${(event: Event) => {
            event.preventDefault();
            editingTabs = true;
            selectSidebarTab(tab.id);
            if (!sidebarState.customizing) toggleSidebarCustomization();
            else notifySidebar();
          }}
          @click=${() => selectSidebarTab(tab.id)}
          ${tip(tab.name)}
        >
          <span aria-hidden="true"
            >${tab.icon === "⌂" ? icon(House, 15) : nothing}${tab.icon === "▱" ? icon(Folder, 15) : nothing}${!["⌂", "▱"].includes(tab.icon) ? tab.icon : nothing}</span
          >${layout.showTabNames && tab.id === layout.activeTab ? html`<span>${tab.name}</span>` : nothing}
        </button>`,
    )}
  </div>`;
}

let resetPending = false;

export function sidebarCustomization(choices: SidebarChoice[] = []): TemplateResult {
  const layout = sidebarState.layout;
  const sections = layout.sections.filter((section) => section.tabId === layout.activeTab);
  const shortcuts = layout.shortcuts.filter((shortcut) => shortcut.tabId === layout.activeTab);
  const patchTab = (id: string, patch: { name?: string; icon?: string }) =>
    updateSidebarLayout((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    }));
  const patchShortcut = (id: string, patch: { name?: string; icon?: string; tabId?: string }) =>
    updateSidebarLayout((current) => ({
      ...current,
      shortcuts: current.shortcuts.map((shortcut) => (shortcut.id === id ? { ...shortcut, ...patch } : shortcut)),
    }));
  return html`<div
    class="sidebar-customization"
    @keydown=${(event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        toggleSidebarCustomization();
      }
    }}
  >
    <div class="sidebar-customization-heading">Customize sidebar</div>
    <details
      class="sidebar-tab-settings"
      ?open=${editingTabs}
      @toggle=${(event: Event) => {
        editingTabs = (event.currentTarget as HTMLDetailsElement).open;
      }}
    >
      <summary>Tab settings</summary>
      <label class="sidebar-preference"
        ><input
          type="checkbox"
          .checked=${layout.showTabNames}
          @change=${(event: Event) => updateSidebarLayout((current) => ({ ...current, showTabNames: (event.currentTarget as HTMLInputElement).checked }))}
        />
        Show tab names</label
      >
      ${repeat(
        layout.tabs,
        (tab) => tab.id,
        (tab, index) =>
          html`<div class="sidebar-customization-row">
            <input
              class="sidebar-icon-input"
              aria-label=${`Icon for ${tab.name} tab`}
              maxlength="16"
              .value=${tab.icon}
              @change=${(event: Event) => patchTab(tab.id, { icon: (event.currentTarget as HTMLInputElement).value })}
            />
            <input
              class="sidebar-section-name-input"
              aria-label=${`Rename ${tab.name} tab`}
              maxlength="40"
              .value=${tab.name}
              @change=${(event: Event) => {
                const input = event.currentTarget as HTMLInputElement;
                if (input.value.trim()) patchTab(tab.id, { name: input.value });
                else input.value = tab.name;
              }}
            />
            ${entryOrder("tabs", layout.tabs, index)}
            <button
              class="sidebar-small-button"
              aria-label=${`Remove ${tab.name} tab`}
              ?disabled=${layout.tabs.length === 1}
              ${tip("Sections and shortcuts move to the first remaining tab")}
              @click=${() => updateSidebarLayout((current) => removeSidebarTab(current, tab.id))}
            >
              ${icon(X, 13)}
            </button>
          </div>`,
      )}
    </details>
    <form
      class="sidebar-add-section"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const input = (event.currentTarget as HTMLFormElement).querySelector("input")!;
        if (!input.value.trim() || layout.tabs.length >= 12) return;
        const id = `tab-${crypto.randomUUID()}`;
        updateSidebarLayout((current) => ({
          ...current,
          tabs: [...current.tabs, { id, name: input.value, icon: "▱" }],
          activeTab: id,
        }));
        input.value = "";
      }}
    >
      <input
        aria-label="New tab name"
        placeholder="New tab…"
        maxlength="40"
        required
        ?disabled=${layout.tabs.length >= 12}
      /><button class="sidebar-small-button" aria-label="Add tab" ?disabled=${layout.tabs.length >= 12}>
        ${icon(Plus, 16)}
      </button>
    </form>
    <h3>Shortcuts in ${layout.tabs.find((tab) => tab.id === layout.activeTab)?.name}</h3>
    ${repeat(
      shortcuts,
      (shortcut) => shortcut.id,
      (shortcut, index) =>
        html`<div
          class="sidebar-edit-card"
          draggable="true"
          @dragstart=${(event: DragEvent) => event.dataTransfer?.setData("application/x-qm-sidebar-shortcut", shortcut.id)}
          @dragover=${(event: DragEvent) => {
            if (event.dataTransfer?.types.includes("application/x-qm-sidebar-shortcut")) event.preventDefault();
          }}
          @drop=${(event: DragEvent) => {
            const id = event.dataTransfer?.getData("application/x-qm-sidebar-shortcut");
            if (id) {
              event.preventDefault();
              moveEntry("shortcuts", id, shortcut.id);
            }
          }}
        >
          <div class="sidebar-customization-row">
            <input
              class="sidebar-icon-input"
              aria-label=${`Icon for ${shortcut.name} shortcut`}
              maxlength="16"
              .value=${shortcut.icon}
              @change=${(event: Event) => patchShortcut(shortcut.id, { icon: (event.currentTarget as HTMLInputElement).value })}
            />
            <input
              class="sidebar-section-name-input"
              aria-label=${`Rename ${shortcut.name} shortcut`}
              maxlength="64"
              .value=${shortcut.name}
              @change=${(event: Event) => {
                const input = event.currentTarget as HTMLInputElement;
                if (input.value.trim()) patchShortcut(shortcut.id, { name: input.value });
                else input.value = shortcut.name;
              }}
            />
            ${tabDestination(`Tab for ${shortcut.name} shortcut`, shortcut.tabId, (tabId) => patchShortcut(shortcut.id, { tabId }))}
            ${entryOrder("shortcuts", shortcuts, index)}<button
              class="sidebar-small-button"
              aria-label=${`Remove ${shortcut.name} shortcut`}
              @click=${() => updateSidebarLayout((current) => ({ ...current, shortcuts: current.shortcuts.filter((item) => item.id !== shortcut.id) }))}
            >
              ${icon(X, 13)}
            </button>
          </div>
        </div>`,
    )}
    <form
      class="sidebar-add-shortcut"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const select = (event.currentTarget as HTMLFormElement).querySelector("select")!;
        const choice = choices.find((item) => item.target === select.value);
        if (!choice || layout.shortcuts.length >= 60) return;
        updateSidebarLayout((current) => ({
          ...current,
          shortcuts: [
            ...current.shortcuts,
            { ...choice, id: `shortcut-${crypto.randomUUID()}`, tabId: current.activeTab },
          ],
        }));
      }}
    >
      <select aria-label="Shortcut destination">
        ${choices.map((choice) => html`<option value=${choice.target}>${choice.name}</option>`)}</select
      ><button
        class="sidebar-small-button"
        aria-label="Add shortcut"
        ?disabled=${!choices.length || layout.shortcuts.length >= 60}
      >
        ${icon(Plus, 16)}
      </button>
    </form>
    <h3>Sections</h3>
    <p>Choose your sections. Drag to reorder.</p>
    ${repeat(
      sections,
      (section) => section.id,
      (section, index) => html`
        <div
          class="sidebar-customization-row ${section.hidden ? "is-hidden" : ""}"
          data-section-id=${section.id}
          draggable="true"
          @dragstart=${(event: DragEvent) => {
            event.stopPropagation();
            event.dataTransfer?.setData(SECTION_DRAG, section.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          }}
          @dragover=${(event: DragEvent) => {
            if (event.dataTransfer?.types.includes(SECTION_DRAG)) event.preventDefault();
          }}
          @drop=${(event: DragEvent) => {
            const id = event.dataTransfer?.getData(SECTION_DRAG);
            if (!id) return;
            event.preventDefault();
            event.stopPropagation();
            updateSidebarLayout((layout) => reorderSidebarSections(layout, id, section.id));
          }}
        >
          <span class="sidebar-drag-grip" aria-hidden="true">${icon(GripVertical, 14)}</span>
          <input
            type="checkbox"
            .checked=${!section.hidden}
            aria-label=${`Show ${section.name}`}
            @change=${(event: Event) => changeSidebarSection(section.id, { hidden: !(event.currentTarget as HTMLInputElement).checked })}
          />
          ${
            section.kind === "custom" || section.kind === "chats"
              ? html`<input
                  class="sidebar-section-name-input"
                  aria-label=${`Rename ${section.name}`}
                  maxlength="64"
                  .value=${section.name}
                  @change=${(event: Event) => {
                    const input = event.currentTarget as HTMLInputElement;
                    const name = input.value.trim();
                    if (name) changeSidebarSection(section.id, { name });
                    else input.value = section.name;
                  }}
                />`
              : html`<span class="sidebar-customization-name">${section.name}</span>`
          }
          ${tabDestination(`Tab for ${section.name} section`, section.tabId, (tabId) => changeSidebarSection(section.id, { tabId }))}
          <button
            class="sidebar-small-button"
            data-direction="-1"
            ?disabled=${index === 0}
            aria-label=${`Move ${section.name} up`}
            ${tip("Move up")}
            @click=${() => moveSectionBy(section.id, -1)}
          >
            ${icon(ArrowUp, 13)}
          </button>
          <button
            class="sidebar-small-button"
            data-direction="1"
            ?disabled=${index === sections.length - 1}
            aria-label=${`Move ${section.name} down`}
            ${tip("Move down")}
            @click=${() => moveSectionBy(section.id, 1)}
          >
            ${icon(ArrowDown, 13)}
          </button>
          ${
            section.kind === "custom" || section.kind === "chats"
              ? html`<button
                  class="sidebar-small-button"
                  aria-label=${`Remove ${section.name} section`}
                  ${tip("Remove section · projects return to Projects")}
                  @click=${() => {
                    updateSidebarLayout((layout) => removeSidebarSection(layout, section.id));
                    queueMicrotask(() =>
                      document.querySelector<HTMLInputElement>(".sidebar-add-section input")?.focus(),
                    );
                  }}
                >
                  ${icon(X, 13)}
                </button>`
              : nothing
          }
        </div>
      `,
    )}
    <form class="sidebar-add-section" @submit=${addSection}>
      <input
        aria-label="New section name"
        placeholder="New section…"
        maxlength="64"
        required
        ?disabled=${sections.length >= 29}
      />
      <select aria-label="New section content">
        <option value="projects">Project group</option>
        <option value="chats">Conversation view</option>
        ${choices.filter((choice) => choice.target.startsWith("project:")).map((choice) => html`<option value=${choice.target.slice(8)}>${choice.name} chats</option>`)}
      </select>
      <button class="sidebar-small-button" type="submit" aria-label="Add section" ?disabled=${sections.length >= 29}>
        ${icon(Plus, 16)}
      </button>
    </form>
    <p class="sidebar-customization-hint">
      Organize projects with their ••• menu, or drag them into a section. Your sidebar is only yours.
    </p>
    <button
      class="sidebar-reset"
      @click=${() => {
        resetPending = !resetPending;
        notifySidebar();
      }}
    >
      Reset sidebar
    </button>
    ${
      resetPending
        ? html`<p>Restore the default layout? Projects and conversations stay intact.</p>
            <button
              class="sidebar-reset"
              @click=${() => {
                resetPending = false;
                updateSidebarLayout(() => defaultSidebarLayout());
              }}
            >
              Restore default layout
            </button>`
        : nothing
    }
  </div>`;
}

export function sidebarSection(
  section: SidebarSection,
  rows: { key: string; name: string; content: TemplateResult }[],
  options: {
    empty: string;
    add?: () => void;
    addLabel?: string;
    projectOrder?: string[];
    itemOrder?: string[];
    scopes?: { id: string; name: string }[];
  },
): TemplateResult {
  const open = !section.collapsed;
  const showAll = expandedLists.has(section.id);
  const visible = showAll || section.limit === 0 ? rows : rows.slice(0, section.limit);
  return html`<section
    class="sidebar-section"
    aria-label=${section.name}
    data-section-id=${section.id}
    @dragover=${(event: DragEvent) => {
      if (!acceptsProjects(section) || !event.dataTransfer?.types.includes(PROJECT_DRAG)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      (event.currentTarget as HTMLElement).classList.add("sidebar-drop-over");
    }}
    @dragleave=${(event: DragEvent) => {
      const target = event.currentTarget as HTMLElement;
      if (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget))
        target.classList.remove("sidebar-drop-over");
    }}
    @drop=${(event: DragEvent) => {
      (event.currentTarget as HTMLElement).classList.remove("sidebar-drop-over");
      const scope = event.dataTransfer?.getData(PROJECT_DRAG);
      if (!scope || !acceptsProjects(section)) return;
      event.preventDefault();
      event.stopPropagation();
      updateSidebarLayout((layout) =>
        moveSidebarProject(
          {
            ...layout,
            sections: layout.sections.map((item) =>
              item.id === section.id
                ? {
                    ...item,
                    projects: options.projectOrder ?? item.projects,
                    items: options.itemOrder ?? item.items,
                  }
                : item,
            ),
          },
          scope,
          section.id,
        ),
      );
    }}
  >
    <div class="sidebar-section-head">
      <button
        class="sidebar-section-toggle"
        type="button"
        aria-expanded=${open}
        aria-controls=${`sidebar-section-${section.id}`}
        @click=${() => changeSidebarSection(section.id, { collapsed: open })}
      >
        ${icon(open ? ChevronDown : ChevronRight, 12)}${section.icon ? html`<span aria-hidden="true">${section.icon}</span>` : nothing}<span
          >${section.name}</span
        >
      </button>
      <span class="sidebar-section-count">${rows.length || ""}</span>
      <button
        class="sidebar-small-button sidebar-section-action"
        aria-label=${`Options for ${section.name} section`}
        aria-expanded=${sidebarState.sectionMenu === section.id}
        aria-haspopup="dialog"
        aria-controls=${`sidebar-options-${section.id}`}
        ${tip("Section options")}
        @click=${() => {
          hideTooltip();
          sidebarState.sectionMenu = sidebarState.sectionMenu === section.id ? null : section.id;
          notifySidebar();
        }}
      >
        ${icon(Ellipsis, 15)}
      </button>
      ${options.add ? html`<button class="sidebar-small-button sidebar-section-action" aria-label=${options.addLabel ?? "New project"} ${tip(options.addLabel ?? "New project")} @click=${options.add}>${icon(Plus, 15)}</button>` : nothing}
    </div>
    ${
      sidebarState.sectionMenu === section.id
        ? html`<div
            class="sidebar-section-options"
            id=${`sidebar-options-${section.id}`}
            data-section-menu=${section.id}
            popover="auto"
            role="dialog"
            aria-label=${`${section.name} section options`}
            ${ref(placeSectionMenu)}
            @toggle=${(event: Event) => {
              const element = event.currentTarget as HTMLElement;
              if (
                (event as Event & { newState?: string }).newState === "closed" &&
                element.isConnected &&
                sidebarState.sectionMenu === section.id
              )
                closeSectionMenu();
            }}
            @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, () => closeSectionMenu(true))}
          >
            ${html`<label
              >Sort by
              <select
                aria-label=${`Sort ${section.name}`}
                .value=${section.sort}
                @change=${(event: Event) => changeSidebarSection(section.id, { sort: (event.currentTarget as HTMLSelectElement).value as SidebarSort })}
              >
                <option value="manual" ?selected=${section.sort === "manual"}>Manual</option>
                <option value="name" ?selected=${section.sort === "name"}>Name</option>
                <option value="recent" ?selected=${section.sort === "recent"}>Recent activity</option>
              </select></label
            >`}
            <label
              >Show<select
                aria-label=${`Show items in ${section.name}`}
                @change=${(event: Event) => changeSidebarSection(section.id, { limit: Number((event.currentTarget as HTMLSelectElement).value) })}
              >
                ${[5, 10, 15, 20, 50, 0].map((limit) => html`<option value=${limit} ?selected=${section.limit === limit}>${limit ? `${limit} items` : "All items"}</option>`)}
              </select></label
            >
            <label
              >Icon<input
                aria-label=${`Icon for ${section.name} section`}
                maxlength="16"
                .value=${section.icon}
                placeholder="Emoji or symbol"
                @change=${(event: Event) => changeSidebarSection(section.id, { icon: (event.currentTarget as HTMLInputElement).value })}
            /></label>
            ${tabSelect(`Tab for ${section.name} section`, section.tabId, (tabId) => changeSidebarSection(section.id, { tabId }))}
            ${
              section.kind === "chats"
                ? html`<label
                      >Project<select
                        aria-label=${`Project for ${section.name}`}
                        ${ref((element) => {
                          if (element instanceof HTMLSelectElement)
                            queueMicrotask(() => {
                              if (element.isConnected) element.value = section.scopeId;
                            });
                        })}
                        @change=${(event: Event) => changeSidebarSection(section.id, { scopeId: (event.currentTarget as HTMLSelectElement).value })}
                      >
                        <option value="" ?selected=${!section.scopeId}>All projects and personal chats</option>
                        ${section.scopeId && !options.scopes?.some((scope) => scope.id === section.scopeId) ? html`<option value=${section.scopeId} selected>Unavailable project</option>` : nothing}
                        ${options.scopes?.map((scope) => html`<option value=${scope.id} ?selected=${section.scopeId === scope.id}>${scope.name}</option>`)}
                      </select></label
                    ><label
                      >Title contains<input
                        aria-label=${`Filter ${section.name}`}
                        .value=${section.query}
                        maxlength="128"
                        placeholder="All conversations"
                        @change=${(event: Event) => changeSidebarSection(section.id, { query: (event.currentTarget as HTMLInputElement).value })}
                    /></label>
                    <label
                      >Status<select
                        aria-label=${`Status for ${section.name}`}
                        @change=${(event: Event) => changeSidebarSection(section.id, { status: (event.currentTarget as HTMLSelectElement).value as SidebarSection["status"] })}
                      >
                        ${(
                          [
                            ["all", "Active"],
                            ["waiting", "Waiting for you"],
                            ["archived", "Archived"],
                          ] as const
                        ).map(
                          ([value, label]) =>
                            html`<option value=${value} ?selected=${section.status === value}>${label}</option>`,
                        )}
                      </select></label
                    >`
                : nothing
            }
            <button type="button" @click=${() => moveSectionBy(section.id, -1)}>Move section up</button>
            <button type="button" @click=${() => moveSectionBy(section.id, 1)}>Move section down</button>
            ${
              rows.length > 1
                ? html`<details>
                    <summary>Reorder items</summary>
                    ${rows.map(
                      (row, index) =>
                        html`<div class="sidebar-customization-row">
                          <span class="sidebar-customization-name">${row.name}</span>
                          <button
                            class="sidebar-small-button"
                            aria-label=${`Move ${row.name} up in ${section.name}`}
                            ?disabled=${index === 0}
                            @click=${() =>
                              changeSidebarSection(section.id, {
                                sort: "manual",
                                items: reorderSidebarEntries(
                                  rows.map((item) => ({ id: item.key })),
                                  row.key,
                                  rows[index - 1]!.key,
                                ).map((item) => item.id),
                              })}
                          >
                            ${icon(ArrowUp, 13)}
                          </button>
                          <button
                            class="sidebar-small-button"
                            aria-label=${`Move ${row.name} down in ${section.name}`}
                            ?disabled=${index === rows.length - 1}
                            @click=${() =>
                              changeSidebarSection(section.id, {
                                sort: "manual",
                                items: reorderSidebarEntries(
                                  rows.map((item) => ({ id: item.key })),
                                  rows[index + 1]!.key,
                                  row.key,
                                ).map((item) => item.id),
                              })}
                          >
                            ${icon(ArrowDown, 13)}
                          </button>
                        </div>`,
                    )}
                  </details>`
                : nothing
            }
            <button
              type="button"
              @click=${() => {
                sidebarState.sectionMenu = null;
                changeSidebarSection(section.id, { hidden: true });
              }}
            >
              Hide section
            </button>
            <button type="button" @click=${toggleSidebarCustomization}>Customize sidebar</button>
          </div>`
        : nothing
    }
    <div id=${`sidebar-section-${section.id}`} ?hidden=${!open}>
      ${
        rows.length
          ? repeat(
              visible,
              (row) => row.key,
              (row) =>
                html`<div
                  class="sidebar-item"
                  @dragstart=${(event: DragEvent) => {
                    if ((event.target as Element).closest(".recent-project-children")) return;
                    draggedItem = { sectionId: section.id, key: row.key };
                    event.dataTransfer?.setData("application/x-qm-sidebar-item", JSON.stringify(draggedItem));
                  }}
                  @dragend=${() => {
                    draggedItem = null;
                    document
                      .querySelectorAll(".sidebar-drop-over, .sidebar-project-drop, .sidebar-item-over")
                      .forEach((element) =>
                        element.classList.remove("sidebar-drop-over", "sidebar-project-drop", "sidebar-item-over"),
                      );
                  }}
                  @dragover=${(event: DragEvent) => {
                    if (draggedItem?.sectionId !== section.id || draggedItem.key === row.key) return;
                    event.preventDefault();
                    (event.currentTarget as HTMLElement).classList.add("sidebar-item-over");
                  }}
                  @dragleave=${(event: DragEvent) => {
                    const element = event.currentTarget as HTMLElement;
                    if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget))
                      element.classList.remove("sidebar-item-over");
                  }}
                  @drop=${(event: DragEvent) => {
                    (event.currentTarget as HTMLElement).classList.remove("sidebar-item-over");
                    const raw = event.dataTransfer?.getData("application/x-qm-sidebar-item");
                    if (!raw) return;
                    let item: { sectionId?: string; key?: string };
                    try {
                      item = JSON.parse(raw);
                    } catch {
                      return;
                    }
                    if (item.sectionId !== section.id || !item.key) return;
                    event.preventDefault();
                    event.stopPropagation();
                    changeSidebarSection(section.id, {
                      sort: "manual",
                      items: reorderSidebarEntries(
                        rows.map((entry) => ({ id: entry.key })),
                        item.key,
                        row.key,
                      ).map((entry) => entry.id),
                    });
                  }}
                >
                  ${row.content}
                </div>`,
            )
          : html`<div class="sidebar-section-empty">${options.empty}</div>`
      }
      ${
        section.limit > 0 && rows.length > section.limit
          ? html`<button
              class="sidebar-show-more"
              @click=${() => {
                if (showAll) expandedLists.delete(section.id);
                else expandedLists.add(section.id);
                notifySidebar();
              }}
            >
              ${icon(showAll ? ChevronDown : Ellipsis, 14)}${showAll ? "Show less" : `Show ${rows.length - section.limit} more`}
            </button>`
          : nothing
      }
    </div>
  </section>`;
}
