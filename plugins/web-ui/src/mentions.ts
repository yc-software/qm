export interface MentionMark {
  start: number;
  end: number;
  wire: string;
}

const BEFORE = " \n\t([{\"'";
const NAME_CHAR = /[\p{L}\p{N}_]/u;

export class MentionBook {
  private entries = new Map<string, string>();

  add(label: string, wire: string): void {
    this.entries.set(label, wire);
  }

  clear(): void {
    this.entries.clear();
  }

  scan(text: string): MentionMark[] {
    if (!this.entries.size || !text.includes("@")) return [];
    const labels = [...this.entries.keys()].sort((a, b) => b.length - a.length);
    const marks: MentionMark[] = [];
    let at = text.indexOf("@");
    while (at >= 0) {
      const label =
        at === 0 || BEFORE.includes(text[at - 1]!)
          ? labels.find((l) => text.startsWith(l, at + 1) && !NAME_CHAR.test(text[at + 1 + l.length] ?? ""))
          : undefined;
      if (label) marks.push({ start: at, end: at + 1 + label.length, wire: this.entries.get(label)! });
      at = text.indexOf("@", label ? at + 1 + label.length : at + 1);
    }
    return marks;
  }

  toWire(text: string): string {
    let out = "";
    let cursor = 0;
    for (const mark of this.scan(text)) {
      out += text.slice(cursor, mark.start) + mark.wire;
      cursor = mark.end;
    }
    return out + text.slice(cursor);
  }
}
