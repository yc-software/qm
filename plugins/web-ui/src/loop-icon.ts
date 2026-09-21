import { html, type TemplateResult } from "lit";
import {
  Repeat,
  Mail,
  Zap,
  Code,
  Bug,
  Shield,
  Calendar,
  MessageSquare,
  ChartNoAxesCombined,
  CheckCircle2,
  BookOpen,
  Rocket,
  Globe,
  Heart,
  Wrench,
} from "lucide";
import { icon, slackMark } from "./ui";

export const LOOP_ICONS = [
  { id: "repeat", label: "Loop", glyph: Repeat },
  { id: "mail", label: "Email", glyph: Mail },
  { id: "slack", label: "Slack", glyph: MessageSquare },
  { id: "zap", label: "Lightning", glyph: Zap },
  { id: "code", label: "Code", glyph: Code },
  { id: "bug", label: "Bug", glyph: Bug },
  { id: "shield", label: "Shield", glyph: Shield },
  { id: "calendar", label: "Calendar", glyph: Calendar },
  { id: "message", label: "Message", glyph: MessageSquare },
  { id: "chart", label: "Chart", glyph: ChartNoAxesCombined },
  { id: "check", label: "Check", glyph: CheckCircle2 },
  { id: "book", label: "Book", glyph: BookOpen },
  { id: "rocket", label: "Rocket", glyph: Rocket },
  { id: "globe", label: "Globe", glyph: Globe },
  { id: "heart", label: "Heart", glyph: Heart },
  { id: "wrench", label: "Wrench", glyph: Wrench },
];

export function loopIcon(loop: { icon?: string; source?: string; sources?: string[] }, size = 16): TemplateResult {
  if (loop.icon?.startsWith("data:image/png;base64,")) {
    return html`<span class="loop-icon" aria-hidden="true"
      ><img src=${loop.icon} width=${size} height=${size} alt=""
    /></span>`;
  }
  const source = loop.source ?? loop.sources?.[0];
  const fallback = ({ gmail: "mail", slack: "slack" } as Record<string, string>)[source ?? ""] ?? "repeat";
  const choice =
    LOOP_ICONS.find((entry) => entry.id === (loop.icon ?? fallback)) ??
    LOOP_ICONS.find((entry) => entry.id === fallback)!;
  return html`<span class="loop-icon" aria-hidden="true"
    >${choice.id === "slack" ? slackMark(size) : icon(choice.glyph, size)}</span
  >`;
}

export async function readLoopIcon(file: File): Promise<string> {
  if (file.size > 2 * 1024 * 1024) throw new Error("Choose an image smaller than 2 MB.");
  if (!["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(file.type))
    throw new Error("Choose a PNG, JPEG, WebP, GIF, or SVG image.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("This image has no visible size.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image uploads are unavailable in this browser.");
    const scale = Math.min(96 / image.naturalWidth, 96 / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, (96 - width) / 2, (96 - height) / 2, width, height);
    const value = canvas.toDataURL("image/png");
    if (value.length > 65_536) throw new Error("This image is too complex. Choose a simpler image.");
    return value;
  } finally {
    URL.revokeObjectURL(url);
  }
}
