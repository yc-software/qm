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
  const source = loop.source ?? loop.sources?.[0];
  const fallback = ({ gmail: "mail", slack: "slack" } as Record<string, string>)[source ?? ""] ?? "repeat";
  const choice =
    LOOP_ICONS.find((entry) => entry.id === (loop.icon ?? fallback)) ??
    LOOP_ICONS.find((entry) => entry.id === fallback)!;
  return html`<span class="loop-icon" aria-hidden="true"
    >${choice.id === "slack" ? slackMark(size) : icon(choice.glyph, size)}</span
  >`;
}
