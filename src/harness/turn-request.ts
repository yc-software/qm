import type { DocumentInput } from "../core/document-inputs.ts";

export interface TurnRequestSettings {
  fast(): boolean | undefined;
  setFast(fast: boolean): void;
  effortLevel(): string | undefined;
  setEffortLevel(effortLevel: string): void;
  documents(): DocumentInput[] | undefined;
  addDocuments(documents: DocumentInput[]): void;
  documentsStubbed(): boolean;
  stubDocuments(): void;
}

export function createTurnRequestSettings(initialDocuments: DocumentInput[] | undefined): TurnRequestSettings {
  let fast: boolean | undefined;
  let effortLevel: string | undefined;
  let documents = initialDocuments;
  let stubbed = false;
  return {
    fast: () => fast,
    setFast: (next) => {
      fast = next;
    },
    effortLevel: () => effortLevel,
    setEffortLevel: (next) => {
      effortLevel = next;
    },
    documents: () => documents,
    addDocuments: (added) => {
      documents = [...(documents ?? []), ...added];
    },
    documentsStubbed: () => stubbed,
    stubDocuments: () => {
      stubbed = true;
    },
  };
}
