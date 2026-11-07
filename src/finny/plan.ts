import { createHash } from "node:crypto";
import type { FinnyMaterialClarification, FinnyPlanPresentation } from "./types.ts";

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

export function validateFinnyMaterialClarification(value: FinnyMaterialClarification): FinnyMaterialClarification {
  const question = text(value?.question, "material clarification question");
  if (!Array.isArray(value?.options) || value.options.length < 2 || value.options.length > 5)
    throw new Error("Finny material clarification must have 2 to 5 options");
  const optionIds = new Set<string>();
  const options = value.options.map((option) => {
    const id = text(option?.id, "material clarification option ID");
    if (id.length > 228) throw new Error("Finny material clarification option ID exceeds Slack limits");
    if (optionIds.has(id)) throw new Error("Finny material clarification option IDs must be unique");
    optionIds.add(id);
    return Object.freeze({
      id,
      label: text(option?.label, "material clarification option label"),
      ...(option.description === undefined
        ? {}
        : { description: text(option.description, "material clarification option description") }),
    });
  });
  const recommendedOptionId = text(value.recommendedOptionId, "material clarification recommendation");
  if (!optionIds.has(recommendedOptionId)) throw new Error("Finny material clarification recommendation is invalid");
  return Object.freeze({ question, options: Object.freeze(options) as typeof options, recommendedOptionId });
}

export function assertFinnyMaterialClarificationMatchesPlan(
  plan: FinnyPlanPresentation,
  clarification: FinnyMaterialClarification,
): void {
  const validated = validateFinnyMaterialClarification(clarification);
  const recommended = validated.options.find((option) => option.id === validated.recommendedOptionId);
  const answers = plan.clarifications.filter((answer) => answer.question === validated.question);
  if (answers.length !== 1 || answers[0]?.answer !== recommended?.label)
    throw new Error("Finny clarification does not unambiguously match the immutable plan");
}
