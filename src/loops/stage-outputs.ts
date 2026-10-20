import { Type, type Static, type TObject } from "typebox";
import { Check } from "typebox/value";
import type { StageOutputDeclaration } from "../types.ts";
import { REPLY_DRAFT_SCHEMA } from "./sources/adapter.ts";
import { LOOP_ITEM_PRIORITIES } from "./triage.ts";

const required = (description: string) => Type.String({ pattern: "\\S", description });

const optional = (description: string) => Type.Optional(Type.String({ description }));

const outputs = Type.Array(
  Type.Object({
    shipAction: required("The declared ship action."),
    title: required("One line."),
    label: optional("Optional grouping label."),
    externalRef: optional("URL or id, if any."),
    summary: optional("One line."),
  }),
);

const outcome = Type.Enum(["met", "continue", "park"]);

const reason = required("One line.");

const checks = Type.Array(
  Type.Object({
    command: Type.String({ description: "The exact declared check." }),
    passed: Type.Boolean(),
    detail: optional("Short result."),
  }),
);

interface StageOutput<S extends TObject> {
  declaration: StageOutputDeclaration;
  accepts: S;
}

const json = (schema: TObject) => schema as unknown as Record<string, unknown>;

const stage = <S extends TObject>(description: string, accepts: S, advertised: TObject = accepts): StageOutput<S> => ({
  declaration: { description, schema: json(advertised), ...(advertised === accepts ? {} : { accept: json(accepts) }) },
  accepts,
});

const ITEM_DESCRIPTION =
  "Submit this stage's result. Work stage: outputs, every externally-reviewable artifact you prepared (empty when the item needed none). Judge stage: outcome and reason (both required), plus checks.";

const REPLY_ITEM_DESCRIPTION =
  "Submit this stage's result. Work stage: proposal, the draft reply (omit it when no reply is needed), and outputs (empty). Judge stage: outcome and reason (both required), plus checks.";

const verdict = { outcome: Type.Optional(outcome), reason: Type.Optional(reason), checks: Type.Optional(checks) };

const itemSchema = Type.Object({ outputs: Type.Optional(outputs), ...verdict });

const replyItemSchema = Type.Object({
  proposal: Type.Optional(REPLY_DRAFT_SCHEMA),
  outputs: Type.Optional(outputs),
  ...verdict,
});

export const INTAKE_OUTPUT = stage(
  "Submit the candidate work items this intake stage found. An empty items list is a fine answer.",
  Type.Object({
    items: Type.Array(
      Type.Object({ sourceKey: required("Stable unique id for the candidate."), sourceSummary: optional("One line.") }),
    ),
  }),
);

export const TRIAGE_OUTPUT = stage(
  "Submit a triage decision for every item marked new.",
  Type.Object({
    items: Type.Array(
      Type.Object({
        id: required("Id of an item marked new."),
        priority: Type.Optional(Type.Enum([...LOOP_ITEM_PRIORITIES])),
        reason: optional("One line."),
        groupWith: optional("Id of the listed item this one belongs with."),
      }),
    ),
  }),
);

const judgeAccepts = Type.Object({ outcome, reason, checks: Type.Optional(checks) });

export const WORK_OUTPUT = stage(ITEM_DESCRIPTION, Type.Object({ outputs }), itemSchema);

export const JUDGE_OUTPUT = stage(ITEM_DESCRIPTION, judgeAccepts, itemSchema);

export const REPLY_WORK_OUTPUT = stage(
  REPLY_ITEM_DESCRIPTION,
  Type.Object({ proposal: Type.Optional(REPLY_DRAFT_SCHEMA), outputs }),
  replyItemSchema,
);

export const REPLY_JUDGE_OUTPUT = stage(REPLY_ITEM_DESCRIPTION, judgeAccepts, replyItemSchema);

const FOLLOW_UP_DESCRIPTION =
  "Submit the complete revised proposal when the person asked you to change it without sending. Do not call this when the proposal is unchanged or the reply was sent.";

export const REPLY_PROPOSAL_OUTPUT = stage(FOLLOW_UP_DESCRIPTION, Type.Object({ proposal: REPLY_DRAFT_SCHEMA }));

export const PROPOSAL_OUTPUT = stage(
  FOLLOW_UP_DESCRIPTION,
  Type.Object({ proposal: Type.Record(Type.String(), Type.Unknown()) }),
);

export function submitted<S extends TObject>(output: StageOutput<S>, value: unknown): Static<S> | undefined {
  return value !== undefined && Check(output.accepts, value) ? value : undefined;
}
