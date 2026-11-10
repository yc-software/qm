const READING_BLOCKS = "qm-markdown :is(p, h1, h2, h3, h4, h5, h6, pre, li, table, blockquote)";

interface ReadingAnchor {
  element: HTMLElement;
  text: string;
  row: string;
  offset: number;
}

function rowKey(element: HTMLElement): string {
  return element.closest<HTMLElement>("[data-entry-seqs]")?.dataset.entrySeqs ?? "";
}

function readingAnchor(stack: HTMLElement, line: number, origin: number, skip: string): ReadingAnchor | null {
  for (const row of stack.querySelectorAll<HTMLElement>("[data-index]")) {
    if (row.closest(skip) || row.getBoundingClientRect().bottom <= line) continue;
    const block = [...row.querySelectorAll<HTMLElement>(READING_BLOCKS)].find(
      (node) => !node.closest(skip) && node.textContent?.trim() && node.getBoundingClientRect().bottom > line,
    );
    const element = block ?? row;
    return {
      element,
      text: block?.textContent ?? "",
      row: rowKey(element),
      offset: element.getBoundingClientRect().top - origin,
    };
  }
  return null;
}

function locateAnchor(stack: HTMLElement, anchor: ReadingAnchor, origin: number): HTMLElement | null {
  const { element, text, row } = anchor;
  const kept = stack.contains(element) && (!text || !!element.textContent?.startsWith(text));
  if (kept && (!row || rowKey(element) === row)) return element;
  if (!text) return row ? stack.querySelector<HTMLElement>(`[data-entry-seqs="${row}"]`) : null;
  const matches = [...stack.querySelectorAll<HTMLElement>(element.tagName)].filter((node) =>
    node.textContent?.startsWith(text),
  );
  const distance = (node: HTMLElement): number => Math.abs(node.getBoundingClientRect().top - origin - anchor.offset);
  return (
    matches.find((node) => row && rowKey(node) === row) ??
    (kept ? element : matches.sort((a, b) => distance(a) - distance(b))[0]) ??
    null
  );
}

export function preserveTranscriptScroll(root: HTMLElement): () => void {
  const snapshots = [...root.querySelectorAll<HTMLElement>(".chat-scroll")]
    .filter((element) => element.clientHeight > 0)
    .map((element) => {
      const top = element.getBoundingClientRect().top;
      const stack = element.querySelector<HTMLElement>(".message-stack");
      return {
        element,
        stack,
        scrollTop: element.scrollTop,
        bottom: element.scrollHeight - element.clientHeight - element.scrollTop <= 1,
        anchor: stack ? readingAnchor(stack, top, top, ".user-row") : null,
      };
    });
  return () => {
    for (const { element, stack, scrollTop, bottom, anchor } of snapshots) {
      if (!root.contains(element) || element.clientHeight === 0) continue;
      if (bottom) {
        element.scrollTop = element.scrollHeight;
        continue;
      }
      const top = element.getBoundingClientRect().top;
      const found = anchor && stack && element.contains(stack) ? locateAnchor(stack, anchor, top) : null;
      if (found && anchor) element.scrollTop += found.getBoundingClientRect().top - top - anchor.offset;
      else element.scrollTop = scrollTop;
    }
  };
}

const CONDENSED_LINES = 2;
const READING_LINE = 1 / 3;
const NEAR_TOP = 400;
const AWAY_FROM_BOTTOM = 160;

export function createTranscriptViewport(options: { pinPrompt?: () => boolean } = {}) {
  let scroller: HTMLElement | null = null;
  let scrollIdle: ReturnType<typeof setTimeout> | undefined;
  let pins: HTMLElement | null = null;
  let prompt: HTMLElement | null = null;
  let stack: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let promptKey: string | undefined;
  let expanded = false;
  let lastTop = 0;
  let observer: ResizeObserver | null = null;
  let following = false;
  let frame: number | null = null;
  let remeasure = true;
  let restContent = 0;
  let condensedContent = 0;
  let contentHeight = 0;
  let condensedHeight = 0;
  let gap: number | null = null;
  let contentMax = "";
  let collapseDistance = 0;
  let geometryDistance: number | null = null;
  let filledAtSize: number | null = null;
  let heldStack: HTMLElement | null = null;
  let anchor: ReadingAnchor | null = null;
  let below = 0;
  const contentUpdates = new Set<Promise<void>>();

  function setFollowing(value: boolean): void {
    following = value;
    if (value) anchor = null;
    syncAway();
  }

  function cancelFollow(): void {
    setFollowing(false);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function holdHeight(): void {
    if (!stack || (heldStack && following)) return;
    if (heldStack !== stack) releaseHeight();
    const height = stack.getBoundingClientRect().height;
    if (heldStack && height <= parseFloat(heldStack.style.minHeight)) return;
    heldStack = stack;
    heldStack.style.minHeight = `${height}px`;
  }

  function releaseHeight(): void {
    heldStack?.style.removeProperty("min-height");
    heldStack = null;
  }

  function clearPrompt(): void {
    if (content) content.scrollTop = 0;
    prompt?.classList.remove("stuck", "sticky-disabled", "pin-expanded", "pin-condensed", "latest-prompt");
    prompt?.style.removeProperty("--pin-expanded-max");
    prompt?.style.removeProperty("--pin-rest-height");
    prompt?.style.removeProperty("--pin-content-max");
    restContent = condensedContent = contentHeight = condensedHeight = 0;
    gap = null;
    contentMax = "";
    collapseDistance = 0;
    geometryDistance = null;
    remeasure = true;
    const toggle = prompt?.querySelector<HTMLButtonElement>(".pin-toggle");
    if (toggle) toggle.hidden = true;
    expanded = false;
    promptKey = undefined;
  }

  function syncPrompt(): void {
    if (!scroller || !prompt || !content) return;
    prompt.classList.toggle("pin-expanded", expanded);
    const clipped = !expanded && content.scrollHeight > content.clientHeight + 1;
    const toggle = prompt.querySelector<HTMLButtonElement>(".pin-toggle");
    if (toggle) {
      toggle.hidden = !clipped && !expanded;
      const label = expanded ? "Show less" : "Show more";
      const text = toggle.querySelector<HTMLElement>(".pin-toggle-label") ?? toggle;
      if (text.textContent !== label) text.textContent = label;
      toggle.setAttribute("aria-expanded", String(expanded));
    }
  }

  function onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.nodeType !== 1) return;
    const toggle = target.closest<HTMLButtonElement>(".pin-toggle");
    if (!toggle || !prompt?.contains(toggle)) return;
    cancelFollow();
    expanded = !expanded;
    if (!expanded && content) content.scrollTop = 0;
    syncSticky();
  }

  function distanceToBottom(): number {
    return scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : 0;
  }

  function syncAway(): void {
    if (!scroller) return;
    const away = !following && distanceToBottom() > AWAY_FROM_BOTTOM;
    scroller.toggleAttribute("data-away-from-bottom", away);
    if (!away) scroller.removeAttribute("data-new-below");
  }

  function viewportTop(): number {
    return scroller!.getBoundingClientRect().top + scroller!.clientTop;
  }

  function captureAnchor(): void {
    if (!scroller || !stack || following) return;
    const origin = viewportTop();
    const stuck = prompt?.classList.contains("stuck") ? prompt.getBoundingClientRect().bottom : 0;
    const edge = Math.max(origin + (pins?.getBoundingClientRect().height ?? 0), stuck);
    const line = edge + (origin + scroller.clientHeight - edge) * READING_LINE;
    anchor = readingAnchor(stack, line, origin, ".latest-prompt.stuck");
    below = distanceToBottom();
  }

  function restoreAnchor(): void {
    if (!scroller || !stack || following || contentUpdates.size > 0) return;
    if (!anchor || scroller.scrollTop !== lastTop) return captureAnchor();
    const origin = viewportTop();
    const element = locateAnchor(stack, anchor, origin);
    if (!element) return captureAnchor();
    anchor.element = element;
    anchor.row = rowKey(element);
    const shift = element.getBoundingClientRect().top - origin - anchor.offset;
    if (Math.abs(shift) >= 0.5) {
      scroller.scrollTop += shift;
      lastTop = scroller.scrollTop;
    }
    const distance = distanceToBottom();
    if (distance > below + 1 && scroller.hasAttribute("data-away-from-bottom"))
      scroller.setAttribute("data-new-below", "");
    below = distance;
  }

  function syncSticky(): void {
    if (!scroller) return;
    syncAway();
    syncPrompt();
    const top = pins?.getBoundingClientRect().height ?? 0;
    scroller.style.setProperty("--chat-sticky-top", `${top}px`);
    const style = getComputedStyle(scroller);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const promptStyle = prompt ? getComputedStyle(prompt) : null;
    const promptMargin = promptStyle ? parseFloat(promptStyle.marginBottom) || 0 : 0;
    if (prompt && content && promptStyle && remeasure && !expanded) measureRest(promptStyle);
    if (prompt && content) {
      const chrome = prompt.getBoundingClientRect().height - content.getBoundingClientRect().height;
      const available = scroller.clientHeight - top - paddingTop - paddingBottom - promptMargin - chrome;
      prompt.style.setProperty("--pin-expanded-max", `${Math.max(0, Math.floor(available))}px`);
    }
    const canStick =
      !!prompt &&
      prompt.getBoundingClientRect().height + promptMargin + top + paddingTop + paddingBottom <= scroller.clientHeight;
    prompt?.classList.toggle("sticky-disabled", !canStick);
    const line = scroller.getBoundingClientRect().top + scroller.clientTop + paddingTop + top;
    const stuck = !!prompt && canStick && scroller.scrollTop > 0 && prompt.getBoundingClientRect().top <= line + 0.5;
    prompt?.classList.toggle("stuck", stuck);
    if (!prompt || !content || !promptStyle) return;
    const edge = anchorEdge();
    if (!stuck) gap = prompt.getBoundingClientRect().top - edge;
    condense(stuck && !expanded, line - edge - (gap ?? restingGap(promptStyle)));
    syncPrompt();
  }

  function precedingBlock(): Element | null {
    let node: Element | null = prompt;
    while (node && node !== stack) {
      let previous = node.previousElementSibling;
      while (previous && getComputedStyle(previous).display === "contents")
        previous = previous.lastElementChild ?? previous.previousElementSibling;
      if (previous) return previous;
      node = node.parentElement;
    }
    return null;
  }

  function anchorEdge(): number {
    const previous = precedingBlock();
    if (previous) return previous.getBoundingClientRect().bottom;
    return stack?.getBoundingClientRect().top ?? 0;
  }

  function restingGap(promptStyle: CSSStyleDeclaration): number {
    const previous = precedingBlock();
    let before = 0;
    if (previous) before = parseFloat(getComputedStyle(previous).marginBottom) || 0;
    else if (stack) before = parseFloat(getComputedStyle(stack).paddingTop) || 0;
    return before + (parseFloat(promptStyle.marginTop) || 0);
  }

  function measureRest(promptStyle: CSSStyleDeclaration): void {
    if (!prompt || !content) return;
    remeasure = false;
    prompt.classList.remove("pin-condensed");
    prompt.style.removeProperty("--pin-content-max");
    prompt.style.setProperty("--pin-rest-height", "0px");
    contentMax = "";
    restContent = content.getBoundingClientRect().height;
    contentHeight = content.scrollHeight;
    const inner =
      prompt.getBoundingClientRect().height -
      (promptStyle.boxSizing === "border-box"
        ? 0
        : (parseFloat(promptStyle.paddingTop) || 0) + (parseFloat(promptStyle.paddingBottom) || 0));
    prompt.style.setProperty("--pin-rest-height", `${Math.max(0, inner)}px`);
    const contentStyle = getComputedStyle(content);
    const lineHeight = parseFloat(contentStyle.lineHeight) || (parseFloat(contentStyle.fontSize) || 0) * 1.5;
    condensedContent = CONDENSED_LINES * lineHeight;
  }

  function contentChanged(): boolean {
    if (!content) return false;
    return content.scrollHeight !== (prompt?.classList.contains("pin-condensed") ? condensedHeight : contentHeight);
  }

  function condense(active: boolean, distance: number): void {
    if (!prompt || !content) return;
    if (!active) {
      collapseDistance = 0;
      geometryDistance = null;
    } else {
      if (geometryDistance === null) collapseDistance = Math.max(0, distance);
      else if (following) collapseDistance = Math.max(collapseDistance, distance);
      else collapseDistance = Math.max(0, collapseDistance + distance - geometryDistance);
      geometryDistance = distance;
    }
    distance = collapseDistance;
    const span = restContent - condensedContent;
    const settled = span <= 0.5 || span - distance < 0.5;
    if (active && settled && !prompt.classList.contains("pin-condensed")) {
      prompt.classList.add("pin-condensed");
      condensedHeight = content.scrollHeight;
    } else if (!(active && settled)) prompt.classList.remove("pin-condensed");
    let max = "";
    if (active) max = `${settled ? condensedContent : restContent - Math.max(0, distance)}px`;
    if (max === contentMax) return;
    contentMax = max;
    if (max) prompt.style.setProperty("--pin-content-max", max);
    else prompt.style.removeProperty("--pin-content-max");
  }

  function hideScrollbar(): void {
    clearTimeout(scrollIdle);
    scrollIdle = undefined;
    scroller?.classList.remove("user-scrolling");
  }

  function showScrollbar(): void {
    if (!scroller?.closest(".split-canvas:not(.single-pane)")) {
      hideScrollbar();
      return;
    }
    if (scroller.scrollHeight <= scroller.clientHeight) return;
    scroller.classList.add("user-scrolling");
    clearTimeout(scrollIdle);
    scrollIdle = setTimeout(hideScrollbar, 700);
  }

  function onScroll(): void {
    if (!scroller || contentUpdates.size > 0) return;
    const moved = scroller.scrollTop !== lastTop;
    if (moved) showScrollbar();
    const movingUp = scroller.scrollTop < lastTop;
    const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
    const resumeFollowing = atBottom && (following || !movingUp);
    if (!resumeFollowing && movingUp) cancelFollow();
    lastTop = scroller.scrollTop;
    syncSticky();
    if (resumeFollowing) setFollowing(true);
    else if (moved) captureAnchor();
    if (movingUp) loadEarlier();
  }

  function earlierButton(): HTMLButtonElement | null {
    return scroller?.querySelector<HTMLButtonElement>(".earlier-messages-btn:not(:disabled)") ?? null;
  }

  function loadEarlier(): void {
    if (!scroller || scroller.scrollTop > NEAR_TOP) return;
    const button = earlierButton();
    if (!button) return;
    cancelFollow();
    button.click();
  }

  function fillViewport(): void {
    const button = earlierButton();
    if (!button || !scroller || scroller.clientHeight === 0) return;
    if (scroller.scrollHeight - scroller.clientHeight > NEAR_TOP) return;
    const size = (stack ?? scroller).getElementsByTagName("*").length;
    if (size === filledAtSize) return;
    filledAtSize = size;
    button.click();
  }

  function catchUpScroll(): boolean {
    if (!scroller || contentUpdates.size > 0) return false;
    if (scroller.scrollTop !== lastTop) onScroll();
    return true;
  }

  function beforeRender(): void {
    if (catchUpScroll()) holdHeight();
  }

  function onContentUpdating(event: Event): void {
    beforeRender();
    const completion = (event as CustomEvent<Promise<void>>).detail;
    contentUpdates.add(completion);
    const complete = (): void => {
      if (contentUpdates.delete(completion) && contentUpdates.size === 0) afterRender();
    };
    void completion.then(complete, complete);
  }

  function afterRender(): void {
    if (!scroller || contentUpdates.size > 0) return;
    if (!following) return settle();
    lastTop = scroller.scrollTop;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    follow();
  }

  function settle(): void {
    if (frame !== null) return;
    const element = scroller;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (element !== scroller || following || contentUpdates.size > 0) return;
      restoreAnchor();
      syncSticky();
    });
  }

  function onWheel(event: WheelEvent): void {
    if (!scroller) return;
    if (event.deltaY < 0) loadEarlier();
    if (event.deltaY < 0 && scroller.scrollTop > 0) cancelFollow();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.target !== scroller || event.key !== "End" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    showScrollbar();
    follow(true);
  }

  function dispose(): void {
    hideScrollbar();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    observer?.disconnect();
    observer = null;
    scroller?.removeEventListener("qm-content-updating", onContentUpdating);
    scroller?.removeEventListener("scroll", onScroll);
    scroller?.removeEventListener("wheel", onWheel);
    scroller?.removeEventListener("click", onClick);
    scroller?.removeEventListener("keydown", onKeyDown);
    scroller?.style.removeProperty("--chat-sticky-top");
    scroller?.style.removeProperty("overflow-anchor");
    scroller?.removeAttribute("data-away-from-bottom");
    scroller?.removeAttribute("data-new-below");
    releaseHeight();
    clearPrompt();
    scroller = pins = prompt = stack = content = null;
    lastTop = 0;
    following = false;
    anchor = null;
    filledAtSize = null;
    contentUpdates.clear();
  }

  function sync(element: HTMLElement | null): void {
    let changed = false;
    if (scroller !== element) {
      changed = true;
      dispose();
      scroller = element;
      lastTop = scroller?.scrollTop ?? 0;
      scroller?.style.setProperty("overflow-anchor", "none");
      setFollowing(false);
      scroller?.addEventListener("qm-content-updating", onContentUpdating);
      scroller?.addEventListener("scroll", onScroll, { passive: true });
      scroller?.addEventListener("wheel", onWheel, { passive: true });
      scroller?.addEventListener("click", onClick);
      scroller?.addEventListener("keydown", onKeyDown);
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver((entries = []) => {
          if (entries.some((entry) => entry.target === scroller) || contentChanged()) remeasure = true;
          restoreAnchor();
          if (catchUpScroll() && following) holdHeight();
          syncSticky();
          follow();
          fillViewport();
        });
        if (scroller) observer.observe(scroller);
      }
    }
    const nextStack = scroller?.querySelector<HTMLElement>(".message-stack") ?? null;
    if (stack !== nextStack) {
      changed = true;
      filledAtSize = null;
      releaseHeight();
      if (stack) observer?.unobserve(stack);
      stack = nextStack;
      if (stack) observer?.observe(stack);
    }
    const nextPins = scroller?.querySelector<HTMLElement>(".pinned-strip") ?? null;
    const prompts = stack?.querySelectorAll<HTMLElement>(":scope > .user-row, .inline-steer > .user-row");
    const pinPrompt = options.pinPrompt?.() ?? true;
    const nextPrompt = pinPrompt ? (prompts?.item(prompts.length - 1) ?? null) : null;
    if (pins !== nextPins) {
      changed = true;
      if (pins) observer?.unobserve(pins);
      pins = nextPins;
      if (pins) observer?.observe(pins);
    }
    if (prompt !== nextPrompt || promptKey !== nextPrompt?.dataset.index) {
      changed = true;
      clearPrompt();
      if (prompt) observer?.unobserve(prompt);
      prompt = nextPrompt;
      promptKey = prompt?.dataset.index;
      if (prompt) observer?.observe(prompt);
    }
    prompt?.classList.add("latest-prompt");
    const nextContent = prompt?.querySelector<HTMLElement>(".pin-content") ?? null;
    if (content !== nextContent) {
      changed = true;
      remeasure = true;
      if (content) observer?.unobserve(content);
      content = nextContent;
      if (content) observer?.observe(content);
    }
    if (changed) syncSticky();
    fillViewport();
  }

  function follow(force = false): void {
    if (force) {
      setFollowing(true);
      lastTop = scroller?.scrollTop ?? 0;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    }
    if (!scroller || !following || contentUpdates.size > 0 || frame !== null) return;
    const element = scroller;
    const priorTop = element.scrollTop;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (element !== scroller || !element.isConnected || !following || contentUpdates.size > 0) return;
      if (element.scrollTop < priorTop && element.scrollHeight - element.clientHeight - element.scrollTop > 1)
        return cancelFollow();
      releaseHeight();
      element.scrollTop = element.scrollHeight;
      lastTop = scroller?.scrollTop ?? 0;
      syncSticky();
    });
  }

  function refresh(): void {
    if (scroller) sync(scroller);
  }

  return { sync, refresh, follow, cancelFollow, beforeRender, afterRender, dispose };
}
