export function preserveTranscriptScroll(root: HTMLElement): () => void {
  const snapshots = [...root.querySelectorAll<HTMLElement>(".chat-scroll")]
    .filter((element) => element.clientHeight > 0)
    .map((element) => {
      const top = element.getBoundingClientRect().top;
      const anchor = [
        ...element.querySelectorAll<HTMLElement>(".message-stack :is(p, h1, h2, h3, h4, h5, h6, pre, li, table)"),
      ].find((node) => !node.closest(".user-row") && node.getBoundingClientRect().bottom > top);
      return {
        element,
        scrollTop: element.scrollTop,
        bottom: element.scrollHeight - element.clientHeight - element.scrollTop <= 1,
        anchor,
        offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      };
    });
  return () => {
    for (const snapshot of snapshots) {
      const { element, anchor } = snapshot;
      if (!root.contains(element) || element.clientHeight === 0) continue;
      if (snapshot.bottom) element.scrollTop = element.scrollHeight;
      else if (anchor && element.contains(anchor))
        element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - snapshot.offset;
      else element.scrollTop = snapshot.scrollTop;
    }
  };
}

const CONDENSED_LINES = 2;

export function createTranscriptViewport() {
  let scroller: HTMLElement | null = null;
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
  const contentUpdates = new Set<Promise<void>>();

  function setFollowing(value: boolean): void {
    following = value;
    if (scroller) scroller.style.overflowAnchor = value ? "none" : "";
  }

  function cancelFollow(): void {
    setFollowing(false);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
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

  function syncSticky(): void {
    if (!scroller) return;
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

  function anchorEdge(): number {
    const previous = prompt?.previousElementSibling;
    if (previous) return previous.getBoundingClientRect().bottom;
    return stack?.getBoundingClientRect().top ?? 0;
  }

  function restingGap(promptStyle: CSSStyleDeclaration): number {
    const previous = prompt?.previousElementSibling;
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

  function onScroll(): void {
    if (!scroller || contentUpdates.size > 0) return;
    const movingUp = scroller.scrollTop < lastTop;
    const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
    const resumeFollowing = atBottom && (following || !movingUp);
    if (!resumeFollowing && movingUp) cancelFollow();
    lastTop = scroller.scrollTop;
    syncSticky();
    if (resumeFollowing) setFollowing(true);
    if (movingUp) loadEarlier();
  }

  function loadEarlier(): void {
    if (!scroller || scroller.scrollTop > 400) return;
    const button = scroller.querySelector<HTMLButtonElement>(".earlier-messages-btn:not(:disabled)");
    if (!button) return;
    cancelFollow();
    button.click();
  }

  function beforeRender(): void {
    if (!scroller || contentUpdates.size > 0) return;
    if (scroller.scrollTop !== lastTop) onScroll();
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
    if (!scroller || !following || contentUpdates.size > 0) return;
    lastTop = scroller.scrollTop;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    follow();
  }

  function onWheel(event: WheelEvent): void {
    if (!scroller) return;
    if (event.deltaY < 0) loadEarlier();
    if (event.deltaY < 0 && scroller.scrollTop > 0) cancelFollow();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.target !== scroller || event.key !== "End" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    follow(true);
  }

  function dispose(): void {
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
    clearPrompt();
    scroller = pins = prompt = stack = content = null;
    lastTop = 0;
    following = false;
    contentUpdates.clear();
  }

  function sync(element: HTMLElement | null): void {
    let changed = false;
    if (scroller !== element) {
      changed = true;
      dispose();
      scroller = element;
      lastTop = scroller?.scrollTop ?? 0;
      setFollowing(false);
      scroller?.addEventListener("qm-content-updating", onContentUpdating);
      scroller?.addEventListener("scroll", onScroll, { passive: true });
      scroller?.addEventListener("wheel", onWheel, { passive: true });
      scroller?.addEventListener("click", onClick);
      scroller?.addEventListener("keydown", onKeyDown);
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver((entries = []) => {
          if (entries.some((entry) => entry.target === scroller) || contentChanged()) remeasure = true;
          beforeRender();
          syncSticky();
          follow();
        });
        if (scroller) observer.observe(scroller);
      }
    }
    const nextStack = scroller?.querySelector<HTMLElement>(".message-stack") ?? null;
    if (stack !== nextStack) {
      changed = true;
      if (stack) observer?.unobserve(stack);
      stack = nextStack;
      if (stack) observer?.observe(stack);
    }
    const nextPins = scroller?.querySelector<HTMLElement>(".pinned-strip") ?? null;
    const prompts = stack?.querySelectorAll<HTMLElement>(".user-row");
    const nextPrompt = prompts?.item(prompts.length - 1) ?? null;
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
      element.scrollTop = element.scrollHeight;
      lastTop = scroller?.scrollTop ?? 0;
      syncSticky();
    });
  }

  return { sync, follow, cancelFollow, beforeRender, afterRender, dispose };
}
