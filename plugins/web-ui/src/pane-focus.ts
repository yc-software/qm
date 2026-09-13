type Selection = { start: number | null; end: number | null; direction: "forward" | "backward" | "none" | null };

function isTextControl(
  view: (Window & typeof globalThis) | null,
  element: Element | null,
): element is HTMLInputElement {
  return Boolean(
    view && element && (element instanceof view.HTMLInputElement || element instanceof view.HTMLTextAreaElement),
  );
}

function readSelection(view: (Window & typeof globalThis) | null, element: Element | null): Selection | null {
  if (!isTextControl(view, element)) return null;
  return { start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection };
}

function applySelection(
  view: (Window & typeof globalThis) | null,
  element: HTMLElement,
  selection: Selection | null,
): void {
  if (!selection || selection.start === null || selection.end === null) return;
  if (!isTextControl(view, element)) return;
  element.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
}

export function replaceChildrenPreservingFocus(container: HTMLElement, host: HTMLElement): void {
  const view = container.ownerDocument.defaultView;
  const active = container.contains(container.ownerDocument.activeElement)
    ? (container.ownerDocument.activeElement as HTMLElement)
    : null;
  const key = active?.dataset.focusKey;
  const selection = readSelection(view, active);
  container.replaceChildren(host);
  if (!key) return;
  const next = [...container.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
    (element) => element.dataset.focusKey === key,
  );
  next?.focus();
  if (next) applySelection(view, next, selection);
}

export function preservingFocus(doc: Document, mutate: () => void): void {
  const view = doc.defaultView;
  const active = doc.activeElement as HTMLElement | null;
  const selection = readSelection(view, active);
  mutate();
  if (!active || doc.activeElement === active || !active.isConnected) return;
  active.focus();
  applySelection(view, active, selection);
}

export function focusComposerOnPaneClick(host: HTMLElement, activePane: () => HTMLElement | null): void {
  let previousPane: HTMLElement | null = null;
  let pointerClick = false;
  host.addEventListener(
    "pointerdown",
    (event) => {
      previousPane = activePane();
      pointerClick = event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    },
    true,
  );
  const cancel = (): void => {
    pointerClick = false;
  };
  host.addEventListener("pointercancel", cancel);
  host.addEventListener("dragstart", cancel);
  host.addEventListener("click", (event) => {
    const switched = pointerClick && activePane() !== previousPane;
    cancel();
    const target = event.target;
    const doc = host.ownerDocument;
    if (!switched || event.defaultPrevented || !(target instanceof doc.defaultView!.Element)) return;
    if (
      target.closest(
        'a, button, input, textarea, select, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="slider"]',
      ) ||
      doc.getSelection()?.isCollapsed === false
    )
      return;
    activePane()?.querySelector<HTMLTextAreaElement>(".composer-input:not(:disabled)")?.focus({ preventScroll: true });
  });
}
