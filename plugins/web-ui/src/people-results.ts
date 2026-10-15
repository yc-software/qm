import { html, type TemplateResult } from "lit";
import { Plus } from "lucide";
import { avatarTpl } from "./ui";
import { icon } from "./icons";

export interface DirectoryMatch {
  principalId: string;
  displayName: string;
  type: string;
  avatarUrl?: string;
}

export function peopleResults(
  matches: DirectoryMatch[],
  busy: boolean,
  select: (person: DirectoryMatch) => void,
): TemplateResult {
  return html`<div class="project-member-results">
    ${matches.map(
      (person) =>
        html` <button class="project-member-result" type="button" ?disabled=${busy} @click=${() => select(person)}>
          ${avatarTpl({ key: person.principalId, name: person.displayName, avatarUrl: person.avatarUrl })}
          <span class="project-member-name" dir="auto">${person.displayName}</span>${icon(Plus, 15)}
        </button>`,
    )}
  </div>`;
}
