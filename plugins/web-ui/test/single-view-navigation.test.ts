import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { deepLinkPath } from "../src/deep-link.ts";

const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const functionSource = (source: string, name: string): string => {
  const match = source.match(new RegExp(`(?:export )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match);
  return match[0].replace("export ", "");
};
const compile = (source: string): string =>
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;

test("single-pane navigation follows the pane identity without depending on the session list", () => {
  const dockApi = { panels: [] as { params: { sessionId?: string; appId?: string } }[] };
  const splitState = { active: true };
  const appState = { currentView: "chats" };
  let url = "/";
  const sync = runInNewContext(
    compile(
      `${functionSource(split, "singlePaneSessionId")}\n${functionSource(shell, "syncUrlFromState")}\nsyncUrlFromState;`,
    ),
    {
      dockApi,
      splitState,
      appState,
      mainConversation: () => ({ state: { sessionId: "stale-main-session" } }),
      panelParams: (panel: { params: object }) => panel.params,
      paneKindEntry: (params: { appId?: string }) => params.appId,
      contextsState: { selected: null },
      UI_BASE: "",
      deepLinkPath,
      location: {
        get pathname() {
          return url;
        },
        search: "",
      },
      history: {
        replaceState: (_state: unknown, _title: string, next: string) => {
          url = next;
        },
      },
    },
  ) as (override?: string | null) => void;
  dockApi.panels = [{ params: { sessionId: "first" } }];
  sync();
  assert.equal(url, "/s/first");
  dockApi.panels = [{ params: { sessionId: "second" } }];
  sync("stale-override");
  assert.equal(url, "/s/second");
  dockApi.panels.push({ params: { sessionId: "third" } });
  sync();
  assert.equal(url, "/");
  dockApi.panels.shift();
  sync();
  assert.equal(url, "/s/third");
  dockApi.panels = [{ params: {} }];
  sync();
  assert.equal(url, "/");
  dockApi.panels[0]!.params.sessionId = "created";
  sync();
  assert.equal(url, "/s/created");
  dockApi.panels = [{ params: { appId: "app", sessionId: "unrelated" } }];
  sync();
  assert.equal(url, "/");
  appState.currentView = "files";
  sync();
  assert.equal(url, "/files");
  appState.currentView = "chats";
  splitState.active = false;
  sync("phone-session");
  assert.equal(url, "/s/phone-session");
});

test("background canvas updates preserve non-chat detail routes", () => {
  const layout = split.match(/api\.onDidLayoutChange\(\(\) => \{([^]*?)\n {2}\}\);/)?.[1];
  assert.ok(layout);
  for (const source of [functionSource(split, "refreshHeaders"), `function refreshHeaders() {${layout}\n}`]) {
    const appState = { currentView: "crons" };
    let syncs = 0;
    const refresh = runInNewContext(compile(`${source}\nrefreshHeaders;`), {
      appState,
      syncUrlFromState: () => {
        syncs++;
      },
      headerSignature: "",
      computeHeaderSignature: () => "",
      syncDocumentTitle: () => {},
      paneTabs: [],
      groupActions: [],
      paneContents: new Map(),
      host: { classList: { contains: () => true, toggle: () => {} } },
      api: { panels: [{}], groups: [] },
      paneDrag: null,
      persistSoon: () => {},
    }) as () => void;
    for (const view of ["crons", "webhooks", "inbox", "skills", "contexts"]) {
      appState.currentView = view;
      refresh();
      assert.equal(syncs, 0, `${view} detail URL must stay intact`);
    }
    appState.currentView = "chats";
    refresh();
    assert.equal(syncs, 1);
  }
});

test("single and multiview headers render mutually exclusive tools and pane controls", () => {
  const source = split.slice(split.indexOf("class GroupActions"), split.indexOf("function notePaneSession"));
  let output = "";
  const dockApi = { panels: [{}], groups: [{ id: "group", activePanel: null, panels: [] }] };
  const flatten = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(flatten).join("");
    if (typeof value === "function") return "";
    return String(value ?? "");
  };
  const html = (strings: TemplateStringsArray, ...values: unknown[]): string =>
    strings.reduce((result, part, i) => result + part + flatten(values[i]), "");
  const actions = runInNewContext(compile(`${source}\nnew GroupActions();`), {
    document: { createElement: () => ({}), addEventListener: () => {} },
    groupActions: new Set(),
    dockApi,
    html,
    nothing: "",
    render: (value: string) => {
      output = value;
    },
    paneScopeId: () => null,
    paneKindEntry: () => null,
    PANE_TOOLS: ["Crons", "Files", "Apps", "Skills", "Memory", "Your keychain"].map((label) => ({
      label,
      tool: label,
      glyph: label,
    })),
    icon: () => "",
    tip: () => "",
    ref: () => "",
    Plus: "",
    Maximize2: "",
    X: "",
    MoreHorizontal: "",
    Shrink: "",
    Expand: "",
  }) as { init: (props: unknown) => void; draw: () => void; menuOpen: boolean };
  actions.init({ group: { id: "group" }, api: { isMaximized: () => false } });
  assert.equal((output.match(/class="session-tool"/g) ?? []).length, 6);
  assert.doesNotMatch(output, /split-tools-btn|Split this pane|Open full screen|Close pane/);
  dockApi.panels.push({});
  actions.draw();
  assert.doesNotMatch(output, /class="session-tool"/);
  for (const label of ["Tools", "Split this pane with a new session", "Open full screen", "Close pane"])
    assert.ok(output.includes(`aria-label="${label}"`) || output.includes(`aria-label=${label}`));
  actions.menuOpen = true;
  dockApi.panels.pop();
  actions.draw();
  assert.equal(actions.menuOpen, false);
  assert.doesNotMatch(output, /split-tools-btn|role="menu"|Close pane/);
});
