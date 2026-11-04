import { html, nothing, type TemplateResult } from "lit";

export type GroupAvatarMember = { principalId: string; displayName: string; avatarUrl?: string };

/** Overlapping circular avatars for a Slack group DM: up to three faces, or two plus a "+N" chip. */
export function groupAvatarStackTpl(
  members: readonly GroupAvatarMember[],
  className = "",
): TemplateResult | typeof nothing {
  if (!members.length) return nothing;
  const shown = members.length > 3 ? members.slice(0, 2) : members;
  const overflow = members.length - shown.length;
  const everyone = members.map((member) => member.displayName).join(", ");
  return html`<span class=${`group-avatar-stack ${className}`.trim()} role="img" aria-label=${`With ${everyone}`}>
    ${shown.map((member) =>
      member.avatarUrl
        ? html`<img class="group-avatar" src=${member.avatarUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : html`<span class="group-avatar initial" aria-hidden="true"
            >${[...member.displayName.trim()][0]?.toUpperCase() ?? "?"}</span
          >`,
    )}
    ${overflow ? html`<span class="group-avatar more" aria-hidden="true">+${overflow}</span>` : nothing}
  </span>`;
}
