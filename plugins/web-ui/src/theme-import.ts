export type Rgb = { r: number; g: number; b: number };
type Rgba = Rgb & { a: number };

type SyntaxRole = "keyword" | "entity" | "constant" | "string" | "variable" | "comment" | "tag" | "heading" | "list";

export type Palette = {
  name: string;
  source: "iterm2" | "vscode";
  background: Rgb;
  foreground: Rgb;
  ansi: Array<Rgb | null>;
  link?: Rgb;
  cursor?: Rgb;
  selection?: Rgb;
  selectionForeground?: Rgb;
  sidebar?: Rgb;
  border?: Rgb;
  button?: Rgb;
  kind?: "light" | "dark";
  syntax?: Partial<Record<SyntaxRole, Rgb>>;
};

export type ThemeTokens = { dark: boolean; vars: Record<string, string>; selectionForeground?: string };

const ANSI_NAMES = [
  "Black",
  "Red",
  "Green",
  "Yellow",
  "Blue",
  "Magenta",
  "Cyan",
  "White",
  "BrightBlack",
  "BrightRed",
  "BrightGreen",
  "BrightYellow",
  "BrightBlue",
  "BrightMagenta",
  "BrightCyan",
  "BrightWhite",
] as const;

const ANSI = {
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  brightBlack: 8,
  brightBlue: 12,
} as const;

const MIN_TEXT_CONTRAST = 3;
const MAX_NAME_LENGTH = 60;

export function importTheme(fileName: string, text: string): Palette {
  const name = themeName(fileName.replace(/\.[^.]+$/, ""));
  const body = text.replace(/^\uFEFF/, "");
  const head = body.slice(0, 64);
  if (head.startsWith("bplist")) {
    throw new Error("This is a binary plist. In iTerm2, export the preset again to get the XML .itermcolors file.");
  }
  if (/<plist|<\?xml/.test(head) || /\.itermcolors$/i.test(fileName)) return parseItermColors(name, body);
  return parseVsCodeTheme(name, body);
}

function themeName(raw: string): string {
  const trimmed = raw.trim().slice(0, MAX_NAME_LENGTH).trim();
  return trimmed || "Imported theme";
}

const PLIST_COLOR_ENTRY = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
const PLIST_COMPONENT = /<key>(Red|Green|Blue) Component<\/key>\s*<(?:real|integer)>([-+\d.eE]+)<\/(?:real|integer)>/g;

function parseItermColors(name: string, xml: string): Palette {
  const colors = new Map<string, Rgb>();
  for (const entry of xml.matchAll(PLIST_COLOR_ENTRY)) {
    const parts: Partial<Record<"Red" | "Green" | "Blue", number>> = {};
    for (const component of entry[2].matchAll(PLIST_COMPONENT)) {
      parts[component[1] as "Red" | "Green" | "Blue"] = Number(component[2]);
    }
    const { Red, Green, Blue } = parts;
    if (![Red, Green, Blue].every((v) => v !== undefined && Number.isFinite(v))) continue;
    colors.set(entry[1].trim(), { r: unitToByte(Red), g: unitToByte(Green), b: unitToByte(Blue) });
  }
  const lookup = (key: string): Rgb | undefined =>
    colors.get(key) ?? colors.get(`${key} (Dark)`) ?? colors.get(`${key} (Light)`);
  const background = lookup("Background Color");
  const foreground = lookup("Foreground Color");
  if (!background || !foreground) {
    throw new Error("Expected an iTerm2 .itermcolors file with a Background Color and a Foreground Color.");
  }
  return {
    name,
    source: "iterm2",
    background,
    foreground,
    ansi: ANSI_NAMES.map((_, i) => lookup(`Ansi ${i} Color`) ?? null),
    link: lookup("Link Color"),
    cursor: lookup("Cursor Color"),
    selection: lookup("Selection Color"),
    selectionForeground: lookup("Selected Text Color"),
  };
}

function unitToByte(value: number | undefined): number {
  if (value === undefined) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

const VSCODE_SYNTAX_SCOPES: Record<SyntaxRole, string[]> = {
  keyword: ["keyword", "storage.type", "storage.modifier"],
  entity: ["entity.name.function", "entity.name.type", "entity.name.class", "support.function"],
  constant: ["constant.numeric", "constant.language", "constant", "support.constant", "entity.other.attribute-name"],
  string: ["string"],
  variable: ["support.type", "support.class", "variable.other", "variable"],
  comment: ["comment"],
  tag: ["entity.name.tag"],
  heading: ["markup.heading", "entity.name.section"],
  list: ["markup.list", "punctuation.definition.list"],
};

type VsCodeTokenRule = { scope?: string | string[]; settings?: { foreground?: string } };

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const DEFAULT_EDITOR: Record<"dark" | "light", Rgba> = {
  dark: { r: 30, g: 30, b: 30, a: 1 },
  light: { r: 255, g: 255, b: 255, a: 1 },
};

function parseVsCodeTheme(name: string, jsonc: string): Palette {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(jsonc));
  } catch {
    throw new Error("Couldn't read that file. Expected an iTerm2 .itermcolors or a VS Code color theme .json.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Expected a VS Code color theme object.");
  const theme = parsed as { name?: unknown; type?: unknown; colors?: unknown; tokenColors?: unknown };
  const colors = (theme.colors && typeof theme.colors === "object" ? theme.colors : {}) as Record<string, unknown>;
  const kind = theme.type === "light" || theme.type === "dark" ? theme.type : undefined;
  const colorAt = (key: string): Rgba | undefined =>
    typeof colors[key] === "string" ? parseHex(colors[key]) : undefined;
  const backdrop = colorAt("editor.background") ?? (kind ? DEFAULT_EDITOR[kind] : undefined);
  if (!backdrop) throw new Error("Expected a VS Code color theme with an editor.background color.");
  const background = composite(backdrop, BLACK);
  const over = (color: Rgba | undefined): Rgb | undefined => (color ? composite(color, background) : undefined);
  const foreground =
    over(colorAt("editor.foreground") ?? colorAt("foreground")) ??
    (isDark(background) ? { r: 212, g: 212, b: 212 } : { r: 51, g: 51, b: 51 });
  const rules = Array.isArray(theme.tokenColors) ? (theme.tokenColors as VsCodeTokenRule[]) : [];
  const syntax: Partial<Record<SyntaxRole, Rgb>> = {};
  for (const role of Object.keys(VSCODE_SYNTAX_SCOPES) as SyntaxRole[]) {
    const found = tokenColorFor(rules, VSCODE_SYNTAX_SCOPES[role]);
    if (found) syntax[role] = composite(found, background);
  }
  return {
    name: typeof theme.name === "string" && theme.name.trim() ? themeName(theme.name) : name,
    source: "vscode",
    background,
    foreground,
    ansi: ANSI_NAMES.map((suffix) => over(colorAt(`terminal.ansi${suffix}`)) ?? null),
    link: over(colorAt("textLink.foreground")),
    cursor: over(colorAt("editorCursor.foreground")),
    selection: over(colorAt("editor.selectionBackground")),
    selectionForeground: over(colorAt("editor.selectionForeground")),
    sidebar: over(colorAt("sideBar.background")),
    border: over(colorAt("sideBar.border") ?? colorAt("panel.border") ?? colorAt("editorGroup.border")),
    button: over(colorAt("button.background")),
    kind,
    syntax,
  };
}

function tokenColorFor(rules: VsCodeTokenRule[], wanted: string[]): Rgba | undefined {
  for (const scope of wanted) {
    let best: { length: number; color: Rgba } | undefined;
    for (const rule of rules) {
      const foreground = rule?.settings?.foreground;
      if (typeof foreground !== "string") continue;
      for (const raw of scopeList(rule.scope)) {
        const candidate = raw.trim();
        if (!candidate || !(scope === candidate || scope.startsWith(`${candidate}.`))) continue;
        const color = parseHex(foreground);
        if (color && (!best || candidate.length >= best.length)) best = { length: candidate.length, color };
      }
    }
    if (best) return best.color;
  }
  return undefined;
}

function scopeList(scope: VsCodeTokenRule["scope"]): string[] {
  if (typeof scope === "string") return scope.split(",");
  return Array.isArray(scope) ? scope.filter((s): s is string => typeof s === "string") : [];
}

export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function stringEnd(text: string, openQuote: number): number {
  let j = openQuote + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return Math.min(text.length, j + 1);
}

export function parseHex(value: string): Rgba | undefined {
  const m = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!m) return undefined;
  let digits = m[1];
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map((d) => d + d).join("");
  if (digits.length !== 6 && digits.length !== 8) return undefined;
  const byte = (at: number) => parseInt(digits.slice(at, at + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) / 255 : 1 };
}

function composite(color: Rgba, under: Rgba | Rgb): Rgb {
  return mix(under, color, color.a);
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = Math.min(1, Math.max(0, amount));
  const channel = (a: number, b: number) => Math.round(a + (b - a) * t);
  return { r: channel(from.r, to.r), g: channel(from.g, to.g), b: channel(from.b, to.b) };
}

function hex(color: Rgb): string {
  return `#${[color.r, color.g, color.b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function luminance(color: Rgb): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function isDark(color: Rgb): boolean {
  return luminance(color) < 0.4;
}

function legible(color: Rgb, background: Rgb, foreground: Rgb, minimum = MIN_TEXT_CONTRAST): Rgb {
  let out = color;
  for (let step = 0; step < 12 && contrast(out, background) < minimum; step++) out = mix(out, foreground, 0.15);
  return out;
}

function textOn(color: Rgb): Rgb {
  return isDark(color) ? { r: 250, g: 250, b: 250 } : { r: 20, g: 20, b: 20 };
}

export function themeTokens(palette: Palette): ThemeTokens {
  const bg = palette.background;
  const fg = palette.foreground;
  const dark = palette.kind ? palette.kind === "dark" : isDark(bg);
  const step = (amountDark: number, amountLight: number) => mix(bg, fg, dark ? amountDark : amountLight);
  const readable = (color: Rgb) => legible(color, bg, fg);
  const ansi = (index: number): Rgb | undefined => palette.ansi[index] ?? undefined;
  const ansiOrBright = (index: number): Rgb | undefined => ansi(index) ?? ansi(index + 8);

  const action = readable(palette.button ?? palette.link ?? ansi(ANSI.blue) ?? ansi(ANSI.brightBlue) ?? fg);
  const link = readable(palette.link ?? action);
  const destructive = readable(ansiOrBright(ANSI.red) ?? { r: 192, g: 57, b: 43 });
  const syntax = (role: SyntaxRole, fallback: Rgb | undefined, last: Rgb) =>
    readable(palette.syntax?.[role] ?? fallback ?? last);
  const green = ansiOrBright(ANSI.green);
  const red = ansiOrBright(ANSI.red);
  const border = palette.border ?? step(0.12, 0.1);
  const mutedForeground = mix(fg, bg, 0.32);
  const comment = syntax("comment", ansi(ANSI.brightBlack), mutedForeground);

  const vars: Record<string, Rgb> = {
    "--background": bg,
    "--foreground": fg,
    "--card": step(0.05, 0.025),
    "--card-foreground": fg,
    "--popover": step(0.1, 0),
    "--popover-foreground": fg,
    "--primary": action,
    "--primary-foreground": textOn(action),
    "--secondary": step(0.09, 0.04),
    "--secondary-foreground": fg,
    "--muted": step(0.09, 0.04),
    "--muted-foreground": mutedForeground,
    "--accent": step(0.2, 0.07),
    "--accent-foreground": link,
    "--destructive": destructive,
    "--destructive-foreground": textOn(destructive),
    "--border": border,
    "--input": step(0.17, 0.1),
    "--ring": action,
    "--sidebar": palette.sidebar ?? step(0.05, 0.02),
    "--sidebar-foreground": fg,
    "--sidebar-primary": action,
    "--sidebar-primary-foreground": textOn(action),
    "--sidebar-accent": step(0.09, 0.04),
    "--sidebar-accent-foreground": fg,
    "--sidebar-border": border,
    "--sidebar-ring": action,
    "--cta": action,
    "--cta-hover": mix(action, fg, 0.15),
    "--cta-foreground": textOn(action),
    "--success": readable(green ?? action),
    "--warning": readable(ansiOrBright(ANSI.yellow) ?? action),
    "--selection": palette.selection ?? mix(bg, action, 0.35),
    "--scrim": mix(bg, BLACK, 0.82),
    "--working-dot": readable(ansiOrBright(ANSI.blue) ?? action),
    "--awaiting-dot": readable(ansiOrBright(ANSI.yellow) ?? action),
    "--syntax-keyword": syntax("keyword", ansiOrBright(ANSI.magenta), fg),
    "--syntax-entity": syntax("entity", ansiOrBright(ANSI.blue), fg),
    "--syntax-constant": syntax("constant", ansiOrBright(ANSI.cyan), fg),
    "--syntax-string": syntax("string", green, fg),
    "--syntax-variable": syntax("variable", ansiOrBright(ANSI.yellow), fg),
    "--syntax-comment": comment,
    "--syntax-tag": syntax("tag", red, fg),
    "--syntax-heading": syntax("heading", ansiOrBright(ANSI.blue), fg),
    "--syntax-list": syntax("list", ansiOrBright(ANSI.yellow), fg),
    "--syntax-addition-fg": readable(green ?? fg),
    "--syntax-addition-bg": mix(bg, green ?? fg, 0.15),
    "--syntax-deletion-fg": readable(red ?? fg),
    "--syntax-deletion-bg": mix(bg, red ?? fg, 0.15),
  };
  return {
    dark,
    vars: Object.fromEntries(Object.entries(vars).map(([name, color]) => [name, hex(color)])),
    selectionForeground: palette.selectionForeground ? hex(palette.selectionForeground) : undefined,
  };
}

export function themeCss(tokens: ThemeTokens): string {
  const body = Object.entries(tokens.vars)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  const scheme = `color-scheme:${tokens.dark ? "dark" : "light"};`;
  const selectionText = tokens.selectionForeground ? `color:${tokens.selectionForeground};` : "";
  return `html:root{${body}${scheme}}::selection{background:var(--selection);${selectionText}}`;
}

export function isPalette(value: unknown): value is Palette {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<Palette>;
  return (
    typeof p.name === "string" &&
    (p.source === "iterm2" || p.source === "vscode") &&
    isRgb(p.background) &&
    isRgb(p.foreground) &&
    Array.isArray(p.ansi) &&
    p.ansi.length === 16 &&
    p.ansi.every((c) => c === null || isRgb(c))
  );
}

function isRgb(value: unknown): value is Rgb {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<Rgb>;
  return [c.r, c.g, c.b].every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255);
}
