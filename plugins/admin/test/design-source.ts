import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
const bundle = buildSync({
  entryPoints: [new URL("../ui/design.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "designUI",
}).outputFiles[0].text;
export function renderDesign(
  stateToUrl: (state: any) => string = (state) => "/admin/" + state.view,
  scope = "org:test",
) {
  const dom = new JSDOM('<div id="view-design"></div>', { runScripts: "outside-only", url: "http://localhost/" });
  Object.assign(dom.window, { route: stateToUrl, scopeId: scope });
  dom.window.eval(
    bundle +
      ';designUI.show({stateToUrl:route,scope:()=>scopeId,searchField:()=>document.createElement("input"),twoWayToggle:()=>document.createElement("div"),fileThumb:()=>document.createElement("span"),initCustomDropdowns:()=>{}});',
  );
  return dom;
}
