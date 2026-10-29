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
    const sizes = (api: typeof source) =>
      api.panels
        .map((p) => ({ title: p.title, width: p.api.width, height: p.api.height }))
        .sort((a, b) => a.title!.localeCompare(b.title!));
    const shape = (api: typeof source) =>
      JSON.stringify(api.toJSON().grid, (key, value) => {
        if (key === "id" || key === "size") return undefined;
        if (key === "views") return (value as string[]).map((id) => api.getPanel(id)?.title);
        if (key === "activeView") return api.getPanel(value as string)?.title;
        return value;
      });
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
        preview.show(source, "a", edge, "Incoming");
        assert.deepEqual(source.toJSON(), restored, "hover leaves the live layout untouched");
        source.addPanel({
          id: "new",
          component: "pane",
          title: "Incoming",
          position: { referencePanel: "a", direction },
        });
        if (edge === "center") source.removePanel(source.getPanel("a")!);
        if (layout === "single" && edge !== "center") source.layout(1188, 788, true);
        const actual = sizes(source);
        assert.equal(preview.api.panels.length, actual.length);
        for (const [index, panel] of sizes(preview.api).entries()) {
          assert.equal(panel.title, actual[index]!.title);
          assert.ok(Math.abs(panel.width - actual[index]!.width) <= 1, `${edge} preview matches the drop width`);
          assert.ok(Math.abs(panel.height - actual[index]!.height) <= 1, `${edge} preview matches the drop height`);
        }
        assert.equal(preview.api.groups.length, source.groups.length);
        assert.equal(shape(preview.api), shape(source), `${edge} preview matches the pane order and geometry`);
        assert.match(preview.element.textContent!, /Drop to/);
        if (edge === "right" && layout === "column") {
          assert.equal(preview.api.groups.length, 3);
          const third = (source.width - 2 * splitTheme.gap) / 3;
          assert.ok(preview.api.panels.every((p) => Math.abs(p.api.width - third) < 2));
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
