import { html, nothing, type TemplateResult } from "lit";
import type { CoreContext } from "./core-bridge";
import { tip } from "./tooltip";
import { avatarTpl } from "./ui";

type GroupAvatarMember = NonNullable<CoreContext["groupMembers"]>[number];

export function groupAvatarStackTpl(
  members: readonly GroupAvatarMember[],
  className = "",
): TemplateResult | typeof nothing {
  if (!members.length) return nothing;
  const shown = members.length > 3 ? members.slice(0, 2) : members;
  const rest = members.slice(shown.length);
  const everyone = members.map((member) => member.displayName).join(", ");
  return html`<span class=${`group-avatar-stack ${className}`.trim()} role="img" aria-label=${`With ${everyone}`}>
    ${shown.map((member) =>
      avatarTpl({ key: member.principalId, name: member.displayName, avatarUrl: member.avatarUrl }),
    )}
    ${
      rest.length
        ? html`<span
            class="inbox-avatar more"
            ${tip(rest.map((member) => member.displayName).join(", "))}
            aria-hidden="true"
            >+${rest.length}</span
          >`
        : nothing
    }
  </span>`;
}
