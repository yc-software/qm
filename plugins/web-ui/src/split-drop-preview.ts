import { createDockview, type DockviewApi, type SerializedDockview } from "dockview-core";
import { splitTheme, edgeToDirection, type DropEdge } from "./split-layout.ts";

type Grid = SerializedDockview["grid"];
type GridNode = { type: "leaf" | "branch"; data: unknown; size: number };
type Leaf = { id: string; views: string[]; activeView?: string };
type Plan = { boxes: PreviewBox[]; single: boolean; hint: string };

interface PreviewBox {
  x: number;
  y: number;
  width: number;
  height: number;
  titles: string[];
  active: number;
  destination: boolean;
}

const INCOMING = "split-drop-preview-incoming";

export class SplitDropPreview {
  readonly element = document.createElement("div");
  private planner: DockviewApi | null = null;
  private readonly plans = new Map<string, Plan>();
  private plansFor = "";
  private target = "";

  constructor(host: HTMLElement) {
    this.element.className = "split-drop-preview";
    this.element.setAttribute("aria-hidden", "true");
    this.element.inert = true;
    this.element.hidden = true;
    host.append(this.element);
  }

  show(source: DockviewApi, paneId: string, edge: DropEdge | "tab", title: string): void {
    const target = `${paneId}:${edge}`;
    if (this.target === target && !this.element.hidden) return;
    this.target = target;
    const plan = this.plan(source, paneId, edge, title);
    this.element.classList.toggle("single-pane", plan.single);
    this.element.replaceChildren(...plan.boxes.map((box) => boxElement(box, plan.hint)));
    this.element.hidden = false;
  }

  hide(): void {
    this.target = "";
    if (!this.element.hidden) this.element.hidden = true;
  }

  dispose(): void {
    this.planner?.dispose();
    this.element.remove();
  }

  plan(source: DockviewApi, paneId: string, edge: DropEdge | "tab", title: string): Plan {
    const layout = source.toJSON();
    const plansFor = `${title}:${source.width}x${source.height}:${JSON.stringify(layout)}`;
    if (plansFor !== this.plansFor) {
      this.plans.clear();
      this.plansFor = plansFor;
    }
    const key = `${paneId}:${edge}`;
    const cached = this.plans.get(key);
    if (cached) return cached;
    const firstSplit = source.panels.length === 1 && edge !== "center";
    let hint = `Drop to add a pane · ${source.groups.length + 1} panes`;
    if (edge === "tab") hint = "Drop to open as a tab";
    if (edge === "center") hint = "Drop to replace this pane";
    const titleOf = (id: string) => (id === INCOMING ? title : "");
    let boxes: PreviewBox[];
    if ((edge === "center" || edge === "tab") && !firstSplit) {
      const destination = source.getPanel(paneId)?.group.id;
      boxes = gridBoxes(layout.grid, titleOf, (leaf) => {
        if (leaf.id !== destination) return null;
        const views = [...leaf.views.filter((id) => edge === "tab" || id !== paneId), INCOMING];
        return { ...leaf, views, activeView: INCOMING };
      });
    } else {
      const api = (this.planner ??= createDockview(document.createElement("div"), {
        theme: splitTheme,
        disableDnd: true,
        disableTabsOverflowList: true,
        createComponent: () => ({ element: document.createElement("div"), init() {} }),
      }));
      api.fromJSON(layout);
      api.layout(source.width, source.height, true);
      const group = api.addPanel({
        id: INCOMING,
        component: "preview",
        title,
        position: { referencePanel: paneId, direction: edge === "tab" ? "within" : edgeToDirection(edge) },
      }).group.id;
      if (firstSplit) api.layout(source.width - splitTheme.gap * 2, source.height - splitTheme.gap * 2, true);
      boxes = gridBoxes(api.toJSON().grid, titleOf, (leaf) => (leaf.id === group ? leaf : null));
    }
    const plan = { boxes, single: source.panels.length === 1 && !firstSplit, hint };
    this.plans.set(key, plan);
    return plan;
  }
}

function gridBoxes(grid: Grid, titleOf: (id: string) => string, destination: (leaf: Leaf) => Leaf | null) {
  const boxes: PreviewBox[] = [];
  const walk = (node: GridNode, horizontal: boolean, x: number, y: number, width: number, height: number): void => {
    if (node.type === "leaf") {
      const dest = destination(node.data as Leaf);
      const leaf = dest ?? (node.data as Leaf);
      const active = leaf.activeView ?? leaf.views[0];
      boxes.push({
        x,
        y,
        width,
        height,
        titles: leaf.views.map(titleOf),
        active: Math.max(0, leaf.views.indexOf(active!)),
        destination: dest !== null,
      });
      return;
    }
    let offset = 0;
    for (const child of node.data as GridNode[]) {
      if (horizontal) walk(child, false, x + offset, y, child.size, height);
      else walk(child, true, x, y + offset, width, child.size);
      offset += child.size + splitTheme.gap;
    }
  };
  walk(grid.root as GridNode, grid.orientation === "HORIZONTAL", 0, 0, grid.width, grid.height);
  return boxes;
}

function boxElement(box: PreviewBox, hint: string): HTMLElement {
  const el = document.createElement("div");
  el.className = box.destination ? "split-preview-box split-preview-destination" : "split-preview-box";
  el.style.cssText = `left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px`;
  const header = document.createElement("div");
  header.className = box.titles.length > 1 ? "split-preview-tabs" : "split-preview-tabs single";
  box.titles.forEach((t, i) => {
    const tab = document.createElement("div");
    tab.className = i === box.active ? "split-preview-title active" : "split-preview-title";
    tab.textContent = t;
    header.append(tab);
  });
  const body = document.createElement("div");
  body.className = box.destination ? "split-preview-content split-preview-incoming" : "split-preview-content";
  if (box.destination) body.textContent = hint;
  el.append(header, body);
  return el;
}
