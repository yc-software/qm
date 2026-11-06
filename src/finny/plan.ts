import { createHash } from "node:crypto";
import type { FinnyPlanPresentation } from "./types.ts";

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Finny plan ${label} is invalid`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Finny plan ${label} is invalid`);
  return value.map((item) => text(item, label));
}

export function validateFinnyPlanPresentation(value: FinnyPlanPresentation): FinnyPlanPresentation {
  if (!value || typeof value !== "object") throw new Error("Finny plan presentation is invalid");
  if (!Array.isArray(value.phases) || !value.phases.length) throw new Error("Finny plan phases are invalid");
  if (!Array.isArray(value.clarifications)) throw new Error("Finny plan clarifications are invalid");
  const validated: FinnyPlanPresentation = {
    title: text(value.title, "title"),
    ...(value.summary === undefined ? {} : { summary: text(value.summary, "summary") }),
    phases: value.phases.map((phase) =>
      Object.freeze({
        name: text(phase?.name, "phase name"),
        owner: text(phase?.owner, "phase owner"),
        dependencies: Object.freeze(stringArray(phase?.dependencies, "phase dependencies")) as string[],
      }),
    ),
    certification: text(value.certification, "certification"),
    deliverable: text(value.deliverable, "deliverable"),
    destination: text(value.destination, "destination"),
    clarifications: value.clarifications.map((clarification) =>
      Object.freeze({
        question: text(clarification?.question, "clarification question"),
        answer: text(clarification?.answer, "clarification answer"),
      }),
    ),
  };
  Object.freeze(validated.phases);
  Object.freeze(validated.clarifications);
  return Object.freeze(validated);
}

export function canonicalFinnyPlanDigest(plan: FinnyPlanPresentation): string {
  const validated = validateFinnyPlanPresentation(plan);
  return createHash("sha256").update(JSON.stringify(validated)).digest("base64url");
}
