import { createDockview, type DockviewApi } from "dockview-core";
import { splitTheme, edgeToDirection, type DropEdge } from "./split-layout.ts";

export class SplitDropPreview {
  readonly element = document.createElement("div");
  readonly api: DockviewApi;
  private target = "";

  constructor(host: HTMLElement) {
    this.element.className = "split-drop-preview";
    this.element.setAttribute("aria-hidden", "true");
    this.element.inert = true;
    host.append(this.element);
    this.api = createDockview(this.element, {
      theme: splitTheme,
      disableTabsOverflowList: true,
      disableDnd: true,
      singleTabMode: "fullwidth",
      createTabComponent: () => {
        const element = document.createElement("div");
        element.className = "split-preview-title";
        return {
          element,
          init: ({ api }) => {
            element.textContent = api.title ?? "";
          },
        };
      },
      createComponent: () => {
        const element = document.createElement("div");
        element.className = "split-preview-content";
        return {
          element,
          init: ({ params }) => {
            element.textContent = params.dropHint ?? "";
            element.classList.toggle("split-preview-incoming", Boolean(params.dropHint));
          },
        };
      },
    });
  }

  show(source: DockviewApi, paneId: string, edge: DropEdge | "tab", title: string): void {
    const target = `${paneId}:${edge}`;
    if (this.target === target) return;
    this.target = target;
    const firstSplit = source.panels.length === 1 && edge !== "center";
    const insetChange = firstSplit ? splitTheme.gap * 2 : 0;
    this.element.classList.toggle("single-pane", source.panels.length === 1 && !firstSplit);
    this.element.hidden = false;
    this.api.fromJSON(source.toJSON());
    this.api.layout(source.width, source.height, true);
    let dropHint = `Drop to add a pane · ${source.groups.length + 1} panes`;
    if (edge === "tab") dropHint = "Drop to open as a tab";
    if (edge === "center") dropHint = "Drop to replace this pane";
    const panel = this.api.addPanel({
      id: crypto.randomUUID(),
      component: "preview",
      title,
      params: { dropHint },
      position: {
        referencePanel: paneId,
        direction: edge === "center" || edge === "tab" ? "within" : edgeToDirection(edge),
      },
    });
    if (edge === "center") this.api.removePanel(this.api.getPanel(paneId)!);
    if (insetChange) this.api.layout(source.width - insetChange, source.height - insetChange, true);
    panel.group.element.classList.add("split-preview-destination");
  }

  hide(): void {
    this.target = "";
    this.element.hidden = true;
  }

  dispose(): void {
    this.api.dispose();
    this.element.remove();
  }
}
