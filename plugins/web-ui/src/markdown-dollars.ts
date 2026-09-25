import { fenceDelimiter } from "./streaming-markdown.ts";

const CODE_SENTINEL = "\u0000";
const LIST_ITEM_LINE = /^([ \t]*(?:[-*+]|\d{1,9}[.)])([ \t]+))/;

function indentColumns(prefix: string): number {
  let columns = 0;
  for (const ch of prefix) {
    if (ch === " ") columns++;
    else if (ch === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}
const BACKTICK_CODE = /```[\s\S]*?```|`[^`\n]+`/g;

export function escapeLoneDollars(text: string): string {
  const stash: string[] = [];
  const masked = text.replace(BACKTICK_CODE, (m) => `${CODE_SENTINEL}${stash.push(m) - 1}${CODE_SENTINEL}`);
  let inFence = false;
  let fenceChar = "";
  let inIndentedCode = false;
  let prevBlank = true;
  let listContentIndent: number | null = null;
  const escaped = masked
    .split("\n")
    .map((line) => {
      if (inFence) {
        if (fenceDelimiter(line) === fenceChar) inFence = false;
        prevBlank = false;
        return line;
      }
      const fence = fenceDelimiter(line);
      if (fence) {
        inFence = true;
        fenceChar = fence;
        prevBlank = false;
        inIndentedCode = false;
        return line;
      }
      if (line.trim() === "") {
        prevBlank = true;
        return line;
      }
      const indent = indentColumns(line);
      const markerMax = listContentIndent === null ? 3 : listContentIndent + 3;
      const listItem = indent <= markerMax ? LIST_ITEM_LINE.exec(line) : null;
      const prefixCols = listItem ? indentColumns(listItem[1]!.replace(/[^ \t]/g, " ")) : 0;
      const markerEnd = listItem
        ? indentColumns(listItem[1]!.slice(0, listItem[1]!.length - listItem[2]!.length).replace(/[^ \t]/g, " "))
        : 0;
      const markerGap = prefixCols - markerEnd;
      if (listItem) listContentIndent = markerGap >= 5 ? markerEnd + 1 : prefixCols;
      else if (listContentIndent !== null && indent < listContentIndent) listContentIndent = null;
      const codeIndent = listContentIndent === null ? 4 : listContentIndent + 4;
      const indented = indent >= codeIndent || (listItem !== null && markerGap >= 5);
      inIndentedCode = indented && (prevBlank || inIndentedCode || listItem !== null);
      prevBlank = false;
      return inIndentedCode ? line : line.replace(/(?<!\$)\$(?!\$)/g, "&#36;");
    })
    .join("\n");
  return escaped.replace(
    new RegExp(`${CODE_SENTINEL}(\\d+)${CODE_SENTINEL}`, "g"),
    (_, i: string) => stash[Number(i)] ?? "",
  );
}
