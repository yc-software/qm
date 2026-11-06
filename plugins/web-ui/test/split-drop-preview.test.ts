import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { splitTheme } from "../src/split-layout.ts";

const dom = new JSDOM("<main></main>", { pretendToBeVisual: true });
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
const { createDockview } = await import("dockview-core");
const { SplitDropPreview } = await import("../src/split-drop-preview.ts");

for (const layout of ["single", "column", "nested"])
  test(`drop previews match ${layout} layouts without changing the live canvas`, () => {
    const host = document.createElement("div");
    document.body.append(host);
    const source = createDockview(host, {
      theme: splitTheme,
      createComponent: () => ({ element: document.createElement("div"), init() {} }),
    });
    source.layout(1200, 800, true);
    source.addPanel({ id: "a", component: "pane", title: "First" });
    if (layout !== "single")
      source.addPanel({
        id: "b",
        component: "pane",
        title: "Second",
        position: { referencePanel: "a", direction: "right" },
      });
    if (layout === "nested") {
      source.addPanel({
        id: "c",
        component: "pane",
        title: "Third",
        position: { referencePanel: "b", direction: "below" },
      });
      source.getPanel("a")!.api.setSize({ width: 420 });
    }
    const preview = new SplitDropPreview(document.body);
    const before = source.toJSON();
    // dockview positions each split view inline, relative to its parent split.
    const offset = (el: HTMLElement | null) => {
      let x = 0;
      let y = 0;
      for (; el && el !== host; el = el.parentElement) {
        x += parseFloat(el.style.left) || 0;
        y += parseFloat(el.style.top) || 0;
      }
      return { x, y };
    };
    const groups = (api: typeof source) =>
      api.groups
        .map((g) => ({
          titles: g.panels.map((p) => (p.title === "Incoming" ? "Incoming" : "")).join("|"),
          active: g.activePanel?.title === "Incoming" ? "Incoming" : "",
          width: g.width,
          height: g.height,
          ...offset(g.element),
        }))
        .sort((a, b) => a.y - b.y || a.x - b.x);
    try {
      for (const [edge, direction] of [
        ["right", "right"],
        ["left", "left"],
        ["top", "above"],
        ["bottom", "below"],
        ["center", "within"],
        ["tab", "within"],
      ] as const) {
        source.fromJSON(before);
        source.layout(1200, 800, true);
        const restored = source.toJSON();
        const plan = preview.plan(source, "a", edge, "Incoming");
        preview.show(source, "a", edge, "Incoming");
        assert.deepEqual(source.toJSON(), restored, "hover leaves the live layout untouched");
        assert.equal(
          preview.plan(source, "a", edge, "Incoming"),
          plan,
          `${edge} plan is reused while the layout holds`,
        );
        source.addPanel({
          id: "new",
          component: "pane",
          title: "Incoming",
          position: { referencePanel: "a", direction },
        });
        if (edge === "center") source.removePanel(source.getPanel("a")!);
        if (layout === "single" && edge !== "center") source.layout(1188, 788, true);
        const actual = groups(source);
        const boxes = plan.boxes
          .map((b) => ({ ...b, titles: b.titles.join("|"), active: b.titles[b.active] }))
          .sort((a, b) => a.y - b.y || a.x - b.x);
        assert.equal(boxes.length, actual.length, `${edge} preview has one box per resulting pane`);
        for (const [index, box] of boxes.entries()) {
          const want = actual[index]!;
          assert.equal(box.titles, want.titles, `${edge} preview keeps tab order`);
          assert.equal(box.active, want.active, `${edge} preview shows the active tab`);
          assert.ok(Math.abs(box.width - want.width) <= 1, `${edge} preview matches the drop width`);
          assert.ok(Math.abs(box.height - want.height) <= 1, `${edge} preview matches the drop height`);
          assert.ok(Math.abs(box.x - want.x) <= 1 && Math.abs(box.y - want.y) <= 1, `${edge} preview places the pane`);
        }
        const destination = plan.boxes.filter((b) => b.destination);
        assert.equal(destination.length, 1);
        assert.equal(destination[0]!.titles[destination[0]!.active], "Incoming");
        const area = plan.boxes.reduce((sum, b) => sum + b.width * b.height, 0);
        const total = source.width * source.height;
        assert.ok(area <= total && area > total * 0.95, `${edge} preview boxes tile the canvas`);
        assert.equal(preview.element.querySelectorAll(".split-preview-box").length, plan.boxes.length);
        assert.match(preview.element.textContent!, /Drop to/);
        if (edge === "right" && layout === "column") {
          const third = (source.width - 2 * splitTheme.gap) / 3;
          assert.ok(plan.boxes.every((b) => Math.abs(b.width - third) < 2));
        }
      }
      preview.hide();
      assert.equal(preview.element.hidden, true);
    } finally {
      preview.dispose();
      source.dispose();
      host.remove();
    }
  });
