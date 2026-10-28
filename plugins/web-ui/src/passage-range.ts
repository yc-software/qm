function normalizedText(root: Element): { text: string; positions: Array<{ node: Text; offset: number } | null> } {
  const walker = root.ownerDocument.createTreeWalker(root, root.ownerDocument.defaultView!.NodeFilter.SHOW_TEXT);
  const positions: Array<{ node: Text; offset: number } | null> = [];
  let text = "";
  let block: Element | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("button, time, .message-meta, .msg-meta")) continue;
    const nextBlock = node.parentElement?.closest("p, li, pre, h1, h2, h3, blockquote") ?? null;
    if (text && block !== nextBlock && !text.endsWith(" ")) {
      text += " ";
      positions.push(null);
    }
    block = nextBlock;
    for (let offset = 0; offset < node.length; offset++) {
      const char = /\s/.test(node.data[offset]!) ? " " : node.data[offset]!;
      if (char === " " && text.endsWith(" ")) continue;
      text += char;
      positions.push({ node, offset });
    }
  }
  return { text, positions };
}

function matchRange(
  root: Element,
  positions: Array<{ node: Text; offset: number } | null>,
  start: number,
  length: number,
): Range | null {
  const first = positions[start];
  const last = positions[start + length - 1];
  if (!first || !last) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

export function passageRange(root: Element, quote: string, occurrence: number): Range | null {
  const needle = quote.replace(/\s+/g, " ").trim();
  const { text, positions } = normalizedText(root);
  let start = -1;
  let from = 0;
  for (let index = 0; needle && index <= occurrence; index++) {
    start = text.indexOf(needle, from);
    if (start < 0) break;
    from = start + 1;
  }
  return start < 0 ? null : matchRange(root, positions, start, needle.length);
}

export function passageOccurrence(root: Element, selected: Range, quote: string): number | null {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const { text, positions } = normalizedText(root);
  const rangeApi = root.ownerDocument.defaultView!.Range;
  let occurrence = 0;
  let from = 0;
  while (true) {
    const start = text.indexOf(needle, from);
    if (start < 0) return null;
    const range = matchRange(root, positions, start, needle.length);
    if (!range) return null;
    if (
      range.compareBoundaryPoints(rangeApi.START_TO_START, selected) >= 0 &&
      range.compareBoundaryPoints(rangeApi.END_TO_END, selected) <= 0
    )
      return occurrence;
    from = start + 1;
    occurrence++;
  }
}
