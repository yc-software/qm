import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { createElement, type IconNode } from "lucide";

const CLAUDE_MARK =
  "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z";

const OPENAI_MARK =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

const CODEX_FRAME =
  "M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z";

const CODEX_MARK =
  "M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z";

const PI_GLYPH = "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z";

const PI_DOT = "M517.36 400H634.72V634.72H517.36Z";

const OPENCODE_FRAME = "M180 60H60V240H180V60ZM240 300H0V0H240V300Z";

const OPENCODE_SCREEN = "M180 240H60V120H180V240Z";

const MARK_KEYS: Record<string, "claude" | "codex" | "pi" | "opencode" | "gemini" | "openai"> = {
  anthropic: "claude",
  google: "gemini",
  gemini: "gemini",
  opencode: "opencode",
  pi: "pi",
  claude: "claude",
  openai: "openai",
  codex: "codex",
};

export function modelMark(key: string, size = 16): TemplateResult | null {
  const mark = MARK_KEYS[key.toLocaleLowerCase()];
  if (!mark) return null;
  if (mark === "openai")
    return html`<svg
      class="model-mark"
      width=${size}
      height=${size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="OpenAI"
      focusable="false"
    >
      <path fill="currentColor" d=${OPENAI_MARK} />
    </svg>`;
  if (mark === "gemini")
    return html`<svg
      class="model-mark"
      width=${size}
      height=${size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Gemini"
      focusable="false"
    >
      <path
        fill="#4285f4"
        d="M12 1C10.5 8.5 8.5 10.5 1 12c7.5 1.5 9.5 3.5 11 11 1.5-7.5 3.5-9.5 11-11C15.5 10.5 13.5 8.5 12 1Z"
      />
    </svg>`;
  if (mark === "opencode")
    return html`<svg
      class="model-mark"
      width=${size}
      height=${size}
      viewBox="-30 0 300 300"
      role="img"
      aria-label="OpenCode"
      focusable="false"
    >
      <path fill="currentColor" opacity="0.45" d=${OPENCODE_SCREEN} />
      <path fill="currentColor" d=${OPENCODE_FRAME} />
    </svg>`;
  if (mark === "pi")
    return html`<svg
      class="model-mark"
      width=${size}
      height=${size}
      viewBox="0 0 800 800"
      role="img"
      aria-label="Pi"
      focusable="false"
    >
      <rect width="800" height="800" rx="170" fill="#5b74e8" />
      <path fill="#fff" fill-rule="evenodd" d=${PI_GLYPH} />
      <path fill="#fff" d=${PI_DOT} />
    </svg>`;
  if (mark === "claude")
    return html`<svg
      class="model-mark"
      width=${size}
      height=${size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Claude"
      focusable="false"
    >
      <path clip-rule="evenodd" fill-rule="evenodd" fill="#d97757" d=${CLAUDE_MARK} />
    </svg>`;
  return html`<svg
    class="model-mark"
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    role="img"
    aria-label="Codex"
    focusable="false"
  >
    <defs>
      <linearGradient id="model-mark-codex" gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="3" y2="21">
        <stop stop-color="#b1a7ff" />
        <stop offset=".5" stop-color="#7a9dff" />
        <stop offset="1" stop-color="#3941ff" />
      </linearGradient>
    </defs>
    <path fill="var(--background, #fff)" d=${CODEX_FRAME} />
    <path fill="url(#model-mark-codex)" d=${CODEX_MARK} />
  </svg>`;
}

const iconTemplates = new WeakMap<IconNode, Map<number, TemplateResult>>();

export function icon(node: IconNode, size = 18): TemplateResult {
  let sizes = iconTemplates.get(node);
  if (!sizes) iconTemplates.set(node, (sizes = new Map()));
  const cached = sizes.get(size);
  if (cached) return cached;
  const template = html`${unsafeSVG(iconElement(node, size).outerHTML)}`;
  sizes.set(size, template);
  return template;
}

export function iconElement(node: IconNode, size: number): SVGElement {
  return createElement(node, {
    class: "icon",
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
    "stroke-width": 1.9,
  });
}
