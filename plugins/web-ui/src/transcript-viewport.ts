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

export function createTranscriptViewport() {
  let scroller: HTMLElement | null = null;
  let pins: HTMLElement | null = null;
  let prompt: HTMLElement | null = null;
  let stack: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let promptKey: string | undefined;
  let expanded = false;
  let lastTop = 0;
  let lastBottom = 0;
  let previousBottom = 0;
  let bottomChangedAt = 0;
  let inputBottom: number | null = null;
  let observer: ResizeObserver | null = null;
  let following = false;
  let frame: number | null = null;
  const contentUpdates = new Set<Promise<void>>();

  function setFollowing(value: boolean): void {
    following = value;
    if (scroller) scroller.style.overflowAnchor = value ? "none" : "";
  }

  function clearInput(): void {
    inputBottom = null;
  }

  function cancelFollow(): void {
    clearInput();
    setFollowing(false);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function clearPrompt(): void {
    if (content) content.scrollTop = 0;
    prompt?.classList.remove("stuck", "sticky-disabled", "pin-expanded");
    prompt?.style.removeProperty("--pin-expanded-max");
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
      if (toggle.textContent !== label) toggle.textContent = label;
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
    const promptMargin = prompt ? parseFloat(getComputedStyle(prompt).marginBottom) || 0 : 0;
    if (prompt && content) {
      const chrome = prompt.getBoundingClientRect().height - content.getBoundingClientRect().height;
      const available = scroller.clientHeight - top - paddingTop - paddingBottom - promptMargin - chrome;
      prompt.style.setProperty("--pin-expanded-max", `${Math.max(0, Math.floor(available))}px`);
    }
    const canStick =
      !!prompt &&
      prompt.getBoundingClientRect().height + promptMargin + top + paddingTop + paddingBottom <= scroller.clientHeight;
    prompt?.classList.toggle("sticky-disabled", !canStick);
    prompt?.classList.toggle(
      "stuck",
      canStick &&
        scroller.scrollTop > 0 &&
        prompt.getBoundingClientRect().top <=
          scroller.getBoundingClientRect().top + scroller.clientTop + paddingTop + top + 0.5,
    );
  }

  function onScroll(): void {
    if (!scroller || contentUpdates.size > 0) return;
    const movingUp = scroller.scrollTop < lastTop;
    const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
    const reachedPreviousBottom =
      scroller.scrollTop > lastTop &&
      (Math.abs(scroller.scrollTop - lastBottom) <= 1 ||
        (inputBottom !== null && Math.abs(scroller.scrollTop - inputBottom) <= 1));
    if (atBottom || reachedPreviousBottom) setFollowing(true);
    else if (scroller.scrollTop < lastTop) cancelFollow();
    if (scroller.scrollTop !== lastTop) clearInput();
    lastTop = scroller.scrollTop;
    measureBottom();
    syncSticky();
    if (movingUp) loadEarlier();
  }

  function loadEarlier(): void {
    if (!scroller || scroller.scrollTop > 400) return;
    const button = scroller.querySelector<HTMLButtonElement>(".earlier-messages-btn:not(:disabled)");
    if (!button) return;
    cancelFollow();
    button.click();
  }

  function measureBottom(): void {
    if (!scroller) return;
    const bottom = scroller.scrollHeight - scroller.clientHeight;
    if (bottom === lastBottom) return;
    previousBottom = lastBottom;
    lastBottom = bottom;
    bottomChangedAt = performance.now();
  }

  function beforeRender(): void {
    if (!scroller || contentUpdates.size > 0) return;
    if (scroller.scrollTop !== lastTop) onScroll();
    measureBottom();
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
    measureBottom();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    follow();
  }

  function onWheel(event: WheelEvent): void {
    if (!scroller) return;
    if (event.deltaY < 0) loadEarlier();
    if (event.deltaY < 0 && scroller.scrollTop > 0) cancelFollow();
    if (event.deltaY > 0) {
      clearInput();
      inputBottom = scroller.scrollHeight - scroller.clientHeight;
    }
    if (
      event.deltaY > 0 &&
      event.timeStamp < bottomChangedAt &&
      scroller.scrollTop > lastTop &&
      Math.abs(scroller.scrollTop - previousBottom) <= 1
    )
      setFollowing(true);
  }

  function onKeyDown(event: KeyboardEvent): void {
    clearInput();
    if (event.target !== scroller || event.key !== "End" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    follow(true);
  }

  function dispose(): void {
    clearInput();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    observer?.disconnect();
    observer = null;
    scroller?.removeEventListener("qm-content-updating", onContentUpdating);
    scroller?.removeEventListener("scroll", onScroll);
    scroller?.removeEventListener("wheel", onWheel);
    scroller?.removeEventListener("click", onClick);
    scroller?.removeEventListener("pointerdown", clearInput);
    scroller?.removeEventListener("keydown", onKeyDown);
    scroller?.style.removeProperty("--chat-sticky-top");
    scroller?.style.removeProperty("overflow-anchor");
    clearPrompt();
    scroller = pins = prompt = stack = content = null;
    lastTop = lastBottom = previousBottom = bottomChangedAt = 0;
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
      lastBottom = previousBottom = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
      setFollowing(false);
      scroller?.addEventListener("qm-content-updating", onContentUpdating);
      scroller?.addEventListener("scroll", onScroll, { passive: true });
      scroller?.addEventListener("wheel", onWheel, { passive: true });
      scroller?.addEventListener("click", onClick);
      scroller?.addEventListener("pointerdown", clearInput);
      scroller?.addEventListener("keydown", onKeyDown);
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => {
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
    const nextPrompt = scroller?.querySelector<HTMLElement>(".message-stack .user-row:not(:has(~ .user-row))") ?? null;
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
    const nextContent = prompt?.querySelector<HTMLElement>(".pin-content") ?? null;
    if (content !== nextContent) {
      changed = true;
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

  return { sync, follow, beforeRender, afterRender, dispose };
}
