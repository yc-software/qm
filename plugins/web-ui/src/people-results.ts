import { html, type TemplateResult } from "lit";
import { Plus } from "lucide";
import { icon, initials } from "./ui";

export interface DirectoryMatch {
  principalId: string;
  displayName: string;
  type: string;
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
          <span class="project-member-avatar" aria-hidden="true">${initials(person.displayName)}</span>
          <span class="project-member-name" dir="auto">${person.displayName}</span>${icon(Plus, 15)}
        </button>`,
    )}
  </div>`;
}
