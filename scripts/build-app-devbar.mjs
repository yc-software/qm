import { build, transform } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = fileURLToPath(import.meta.resolve("devbar.sh"));
const version = JSON.parse(await readFile(resolve(dirname(entry), "../package.json"), "utf8")).version;
if (version !== "1.1.0") throw new Error("Review the QM Devbar adapter before upgrading devbar.sh");
const replaceRequired = (source, search, replacement) => {
  if (!source.includes(search)) throw new Error(`Devbar adapter mismatch: ${search}`);
  return source.replace(search, replacement);
};
const replaceBetween = (source, start, end, replacement) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || source.indexOf(start, a + 1) !== -1) throw new Error(`Devbar adapter mismatch: ${start}`);
  return source.slice(0, a) + replacement + source.slice(b);
};
await build({
  entryPoints: [resolve(root, "plugins/web-ui/src/app-devbar.ts")],
  outfile: resolve(root, "src/deploy/vendor/devbar.js"),
  bundle: true,
  minify: true,
  legalComments: "none",
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "qm-devbar",
      setup(builder) {
        builder.onLoad({ filter: /devbar\.sh\/dist\/index\.js$/ }, async () => {
          let source = await readFile(entry, "utf8");
          source = `import { readTextSelection, resolveTextSelection } from ${JSON.stringify(resolve(root, "plugins/web-ui/src/app-text-selection.ts"))};\n${source}`;
          const selectStart = source.indexOf("function SelectOverlay(");
          const selectEnd = source.indexOf("function DrawOverlay(", selectStart);
          let select = source.slice(selectStart, selectEnd);
          select = replaceRequired(select, "  onCapture,", "  passive = false,\n  onCapture,");
          select = replaceRequired(select, 'a.type === "element"', 'a.type === "element" && !a.data.textSelection');
          select = replaceRequired(
            select,
            "const beginComment = useCallback((el) => {",
            "const beginComment = useCallback((el, quote = null) => {",
          );
          select = replaceRequired(
            select,
            "    const r = rectOf(el);\n    if (captureRef.current?.elementScreenshot !== false)",
            "    const r = quote ? quote.rect : rectOf(el);\n    if (quote) { data.boundingRect = r; data.textSelection = quote.textSelection; data.innerText = quote.textSelection.exact; }\n    if (!quote && captureRef.current?.elementScreenshot !== false)",
          );
          select = replaceRequired(
            select,
            "label: `${tag}${ident}`,",
            "label: quote ? quote.textSelection.exact : `${tag}${ident}`,",
          );
          select = replaceRequired(
            select,
            "  useEffect(() => {",
            `  const captureText = () => {
            if (commentOpenRef.current) return false;
            const selected = readTextSelection(window.getSelection());
            if (!selected) return false;
            const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
            beginComment(selected.element, { ...selected, rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
            return true;
          };
          useEffect(() => {`,
          );
          select = replaceRequired(
            select,
            "      if (commentOpenRef.current)\n        return;\n      const prev",
            "      if (passive || commentOpenRef.current) return;\n      const prev",
          );
          select = replaceRequired(
            select,
            "    const onClick = (e) => {",
            "    const onClick = (e) => {\n      if (passive) return;",
          );
          select = replaceRequired(
            select,
            "      const existing2 = findExistingAnnotation(el);",
            "      if (captureText()) return;\n      const existing2 = findExistingAnnotation(el);",
          );
          select = replaceRequired(
            select,
            "    const onKeyDown = (e) => {",
            "    const onKeyDown = (e) => {\n      if (passive) return;",
          );
          select = replaceRequired(
            select,
            '    window.addEventListener("mousemove", onMouseMove, true);',
            `    const onMouseUp = (e) => {
            if (e.target.closest?.("[data-devbar]")) return;
            captureText();
          };
          window.addEventListener("mouseup", onMouseUp);
          window.addEventListener("mousemove", onMouseMove, true);`,
          );
          select = replaceRequired(
            select,
            '      window.removeEventListener("mousemove", onMouseMove, true);',
            '      window.removeEventListener("mouseup", onMouseUp);\n      window.removeEventListener("mousemove", onMouseMove, true);',
          );
          select = replaceRequired(
            select,
            "[findExistingAnnotation, beginComment, quickCapture, retarget]",
            "[findExistingAnnotation, beginComment, quickCapture, retarget, passive]",
          );
          select = replaceRequired(
            select,
            "    commentOpenRef.current = false;\n    setCommentInput(null);",
            "    window.getSelection()?.removeAllRanges();\n    commentOpenRef.current = false;\n    setCommentInput(null);",
          );
          select = replaceRequired(
            select,
            "    const shot = pendingScreenshot.current;",
            "    window.getSelection()?.removeAllRanges();\n    const shot = pendingScreenshot.current;",
          );
          select = replaceRequired(
            select,
            "setCommentInput((prev) => prev ? { ...prev, rect: r } : null);",
            "setCommentInput((prev) => prev ? { ...prev, rect: getAnnotationRect(prev.annotation) ?? prev.rect } : null);",
          );
          select = replaceRequired(select, "      rect && !commentInput", "      !passive && rect && !commentInput");
          select = replaceRequired(
            select,
            '/* @__PURE__ */ jsxs("div", {\n        className: "devbar-instruction",',
            '!passive && /* @__PURE__ */ jsxs("div", {\n        className: "devbar-instruction",',
          );
          select = replaceRequired(
            select,
            "        const selector = a.data.cssSelector;",
            `        const quoteRange = a.data.textSelection ? resolveTextSelection(a.data.textSelection, document) : null;
        if (a.data.textSelection && !quoteRange) { wrapper.style.display = "none"; continue; }
        const selector = a.data.cssSelector;`,
          );
          select = replaceRequired(
            select,
            "        let el = null;",
            "        let el = quoteRange?.commonAncestorContainer ?? null;",
          );
          select = replaceRequired(
            select,
            "          if (selector)\n            el =",
            "          if (!quoteRange && selector)\n            el =",
          );
          select = replaceRequired(
            select,
            "        const rect = el.getBoundingClientRect();",
            "        const rect = quoteRange ? quoteRange.getBoundingClientRect() : el.getBoundingClientRect();",
          );
          source = source.slice(0, selectStart) + select + source.slice(selectEnd);
          source = replaceRequired(
            source,
            "function getAnnotationRect(a) {",
            "function getAnnotationRect(a) {\n  if (a.data.textSelection) return resolveTextSelection(a.data.textSelection, document)?.getBoundingClientRect() ?? null;",
          );
          source = replaceRequired(source, '"Click to annotate · "', '"Select text to comment · click to annotate · "');
          source = replaceRequired(
            source,
            'state.activeMode === "select" && /* @__PURE__ */ jsx10(SelectOverlay, {',
            '(state.activeMode === "select" || (qmChatOpen && !state.activeMode)) && /* @__PURE__ */ jsx10(SelectOverlay, { passive: state.activeMode !== "select",',
          );
          source = replaceBetween(
            source,
            'var DB_NAME = "devbar";',
            "function useDevbarState()",
            `
          const STORE_NAME = "annotations", EXPORTS_STORE = "exports";
          const dbGetAll = async () => [];
          const dbPutRecord = async () => {};
          const dbDeleteRecord = async () => {};
          const dbClearStore = async () => {};
          const dbArchive = async () => {};
          const dbRestore = async () => {};
        `,
          );
          source = replaceBetween(
            source,
            "  const renderAgentButton =",
            "  const renderSettingsButton =",
            "  const renderAgentButton = () => null;\n",
          );
          source = replaceBetween(
            source,
            "  const renderExportButton =",
            "  const renderToolButtons =",
            "  const renderExportButton = () => null;\n",
          );
          source = replaceBetween(
            source,
            "  const renderTaskInput =",
            "  const renderAnnotationList =",
            "  const renderTaskInput = () => null;\n",
          );
          source = replaceRequired(
            source,
            '  { key: "annotations", label: "Annotations" },\n  { key: "history", label: "History" }',
            '  { key: "annotations", label: "Annotations" }',
          );
          source = replaceRequired(source, '  { key: "agent", label: "Agent" },\n', "");
          source = replaceRequired(
            source,
            "Pick a tool, mark up the page, then export the whole thing as a prompt.",
            "Pick a tool and mark up the page. Annotations appear automatically as attachments in QM chat.",
          );
          source = replaceRequired(
            source,
            '          ["⌘↵", effectiveServer ? "Submit the report" : "Copy the report"],\n',
            "",
          );
          source = replaceRequired(source, '          ["Alt+T", "Focus the task field"],\n', "");
          for (const label of ["Include images", "Image export format"]) {
            const title = source.indexOf(`children: "${label}"`);
            const row = '\n      /* @__PURE__ */ jsxs10("div", {';
            const start = source.lastIndexOf(row, title);
            const end = source.indexOf(row, title);
            if (title < 0 || start < 0 || end < 0) throw new Error(`Devbar settings adapter mismatch: ${label}`);
            source = source.slice(0, start) + source.slice(end);
          }
          source = replaceRequired(source, "  xpath: false,", "  xpath: true,");
          source = source.replaceAll('"devbar-settings-v2"', '"qm-app-annotate-settings-v1"');
          source = replaceRequired(
            source,
            "const [activeMode, setActiveMode] = useState9(null);",
            'const [activeMode, setActiveMode] = useState9(document.documentElement.dataset.qmAnnotating === "true" ? "select" : null);',
          );
          source = replaceRequired(
            source,
            "className: `devbar-bar-btn ${state.activeMode === tool.key",
            '"data-shortcut": tool.shortcut,\n      title: `${tool.label} (${tool.shortcut})`,\n      className: `devbar-bar-btn ${state.activeMode === tool.key',
          );
          source = replaceRequired(
            source,
            '"aria-label": `${tool.label} tool`,',
            '"data-shortcut": tool.shortcut,\n                "aria-label": `${tool.label} tool`,',
          );
          source = source.replaceAll(
            'onClick: () => togglePanelTab("annotations"),',
            '"data-shortcut": "Alt+A", onClick: () => togglePanelTab("annotations"),',
          );
          source = source.replaceAll(
            'onClick: () => togglePanelTab("settings"),',
            '"data-shortcut": "Alt+,", onClick: () => togglePanelTab("settings"),',
          );
          source = source.replaceAll('title: "Minimize",', '"data-shortcut": "Alt+H", title: "Minimize",');
          source = source.replaceAll("onClick: togglePanel,", '"data-shortcut": "Alt+A", onClick: togglePanel,');
          const drawStart = source.indexOf("function DrawOverlay(");
          const drawEnd = source.indexOf("function CaptureOverlay(", drawStart);
          let draw = source.slice(drawStart, drawEnd);
          draw = replaceBetween(
            draw,
            "  const remembered =",
            "  const [shapes, setShapes]",
            '  const activeTool = "pen", activeColor = "#ff3b30", activeWidth = 2.5;\n',
          );
          draw = replaceBetween(
            draw,
            "      if (!e.metaKey && !e.ctrlKey && !e.altKey) {",
            "    };\n    window.addEventListener",
            "",
          );
          draw = replaceBetween(
            draw,
            "          ALL_TOOLS.map((tool, i) => {",
            '          /* @__PURE__ */ jsx3("button", {\n            type: "button",\n            onClick: handleUndo,',
            "",
          );
          draw = replaceBetween(
            draw,
            '          "Draw on the page · ",',
            '          /* @__PURE__ */ jsx3("kbd", {\n            children: "⌘Z"',
            '          "Draw on the page · ",\n',
          );
          source = source.slice(0, drawStart) + draw + source.slice(drawEnd);
          source = replaceRequired(
            source,
            'state.activeMode && /* @__PURE__ */ jsxs10("div", {\n        className: `devbar-minibar',
            'state.activeMode && state.activeMode !== "draw" && /* @__PURE__ */ jsxs10("div", {\n        className: `devbar-minibar',
          );
          const captureStart = source.indexOf("function CaptureOverlay(");
          const captureEnd = source.indexOf("  const selectionRect =", captureStart);
          let capture = source.slice(captureStart, captureEnd);
          capture = replaceRequired(
            capture,
            "  const dragging = useRef4(false);",
            "  const dragging = useRef4(false);\n  const regionPointer = useRef4({ start: null, end: null });",
          );
          capture = replaceRequired(
            capture,
            "    dragging.current = true;",
            "    dragging.current = true;\n    regionPointer.current = { start: { x: e.clientX, y: e.clientY }, end: { x: e.clientX, y: e.clientY } };",
          );
          capture = replaceRequired(
            capture,
            "    setRegionEnd({ x: e.clientX, y: e.clientY });\n  }, [captureMode]);\n  const onMouseUp",
            "    regionPointer.current.end = { x: e.clientX, y: e.clientY };\n    setRegionEnd({ x: e.clientX, y: e.clientY });\n  }, [captureMode]);\n  const onMouseUp",
          );
          capture = replaceRequired(
            capture,
            "  const onMouseUp = useCallback4(async () => {",
            "  const onMouseUp = useCallback4(async () => {\n    const { start: regionStart, end: regionEnd } = regionPointer.current;",
          );
          if (!capture.includes("regionPointer.current.end =")) throw new Error("Devbar capture adapter mismatch");
          source = source.slice(0, captureStart) + capture + source.slice(captureEnd);
          const anchor = "  const copiedTimerRef = useRef10(undefined);";
          if (!source.includes(anchor)) throw new Error("Devbar annotation observer hook changed");
          source = replaceRequired(
            source,
            anchor,
            `const qmAnnotatingRef = useRef10(document.documentElement.dataset.qmAnnotating === "true");
        const [qmChatOpen, setQmChatOpen] = useState10(document.documentElement.dataset.qmChatOpen === "true");
        useEffect11(() => {
          onSubmit?.(buildPayload(state.annotations, promptTemplate, settings, task));
        }, [state.annotations, onSubmit]);
        useEffect11(() => {
          const hide = (event) => {
            if (event.source === window.parent && event.origin === location.origin && event.data?.type === "qm:devbar-toggle" ) {
              setQmChatOpen(Boolean(event.data.chatOpen));
              if (event.data.on && !qmAnnotatingRef.current) startTool("select");
              else if (!event.data.on && qmAnnotatingRef.current) { state.deactivateTool(); setPanelOpen(false); }
              qmAnnotatingRef.current = Boolean(event.data.on);
            }
          };
          window.addEventListener("message", hide);
          return () => window.removeEventListener("message", hide);
        }, [state.deactivateTool, startTool]);\n${anchor}`,
          );
          source = replaceRequired(source, 'if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {', "if (false) {");
          source = replaceRequired(source, 'panelTab === "annotations" && renderFooter()', "false && renderFooter()");
          source = source.replaceAll("Alt+A", "L").replaceAll("Alt+", "");
          source = replaceRequired(
            source,
            "const boundTool = e.altKey ?",
            "const boundTool = !e.altKey && !e.metaKey && !e.ctrlKey ?",
          );
          source = source.replaceAll("if (!e.altKey)", "if (e.altKey || e.metaKey || e.ctrlKey)");
          source = replaceRequired(source, 'if (is("a")) {', 'if (is("l")) {');
          source = source.replaceAll(
            "const onKeyDown = (e) => {",
            `const onKeyDown = (e) => {
            if (document.documentElement.dataset.qmAnnotating !== 'true' || e.isComposing || e.repeat || e.target.closest?.('input,textarea,select,[contenteditable], [data-devbar="quote"]')) return;`,
          );
          return { contents: source, loader: "js", resolveDir: dirname(entry) };
        });
      },
    },
  ],
});
const css = await transform(await readFile(resolve(dirname(entry), "index.css"), "utf8"), {
  loader: "css",
  minify: true,
  legalComments: "none",
});
await writeFile(
  resolve(root, "src/deploy/vendor/devbar.css"),
  css.code +
    `
[data-devbar="root"][data-passive="true"] .devbar-toolbar > :not([data-devbar="select-overlay"]) { display: none !important; }
[data-devbar="note-input"] .devbar-note-input-target { max-height: 70px; overflow: auto; }
[data-devbar] button[data-shortcut] { display: inline-flex; flex-direction: column; justify-content: center; gap: 3px; width: 42px; min-width: 42px; height: 44px; padding: 3px; }
[data-devbar] button[data-shortcut]::after { content: attr(data-shortcut); font: 9px/12px ui-monospace, monospace; white-space: nowrap; border: 1px solid var(--devbar-border); border-radius: 3px; padding: 0 2px; color: var(--devbar-text-secondary); }
[data-devbar] .devbar-minibar { max-width: calc(100vw - 16px); box-sizing: border-box; flex-wrap: wrap; justify-content: center; }
[data-devbar] .devbar-bar { max-width: calc(100vw - 16px); box-sizing: border-box; flex-wrap: wrap; }
`,
);
const licenses = await Promise.all(
  ["devbar.sh", "react", "react-dom", "scheduler", "html-to-image"].map(async (name) => {
    const folder = name === "devbar.sh" ? resolve(dirname(entry), "..") : resolve(root, "node_modules", name);
    const pkg = JSON.parse(await readFile(resolve(folder, "package.json"), "utf8"));
    return `${name} ${pkg.version}\n\n${await readFile(resolve(folder, "LICENSE"), "utf8")}`;
  }),
);
await writeFile(resolve(root, "src/deploy/vendor/LICENSE"), licenses.join("\n\n"));
