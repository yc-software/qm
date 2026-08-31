import {
  WORKFLOW_ARTIFACT_CARD_RENDERER,
  WORKFLOW_ARTIFACT_MIME,
  safeWorkflowArtifactHref,
  validateWorkflowArtifactCard,
  validateWorkflowArtifactEnvelope,
  type WorkflowArtifactCard,
  type WorkflowArtifactEnvelope,
} from "../../chassis/src/workflow-artifact-card.ts";

export {
  WORKFLOW_ARTIFACT_CARD_RENDERER,
  WORKFLOW_ARTIFACT_MIME,
  safeWorkflowArtifactHref,
  validateWorkflowArtifactCard,
  validateWorkflowArtifactEnvelope,
};
export type { WorkflowArtifactCard, WorkflowArtifactEnvelope };

const RENDERER_NAME = /^[a-z0-9](?:[a-z0-9._/-]{0,62}[a-z0-9])?$/;

export interface WorkflowArtifactRenderer<T> {
  type: string;
  decode(payload: unknown): T;
  toCard(value: T): WorkflowArtifactCard;
}

export class WorkflowArtifactRegistry {
  readonly #renderers = new Map<string, WorkflowArtifactRenderer<unknown>>();

  register<T>(renderer: WorkflowArtifactRenderer<T>): () => void {
    if (
      !renderer ||
      typeof renderer.type !== "string" ||
      renderer.type.length > 64 ||
      !RENDERER_NAME.test(renderer.type)
    ) {
      throw new Error("invalid workflow artifact renderer");
    }
    if (typeof renderer.decode !== "function" || typeof renderer.toCard !== "function") {
      throw new Error("invalid workflow artifact renderer");
    }
    if (this.#renderers.has(renderer.type))
      throw new Error(`workflow artifact renderer already registered: ${renderer.type}`);
    const type = renderer.type;
    const stored: WorkflowArtifactRenderer<unknown> = {
      type,
      decode: renderer.decode.bind(renderer),
      toCard: renderer.toCard.bind(renderer) as (value: unknown) => WorkflowArtifactCard,
    };
    this.#renderers.set(type, stored);
    return () => {
      if (this.#renderers.get(type) === stored) this.#renderers.delete(type);
    };
  }

  has(type: string): boolean {
    return this.#renderers.has(type);
  }

  render(envelope: WorkflowArtifactEnvelope, baseUrl: string): WorkflowArtifactCard {
    const renderer = this.#renderers.get(envelope.renderer);
    if (!renderer) throw new Error("unknown workflow artifact renderer");
    return validateWorkflowArtifactCard(renderer.toCard(renderer.decode(envelope.payload)), baseUrl);
  }
}

export function createDefaultWorkflowArtifactRegistry(): WorkflowArtifactRegistry {
  const registry = new WorkflowArtifactRegistry();
  registry.register({
    type: WORKFLOW_ARTIFACT_CARD_RENDERER,
    decode: (payload: unknown) => payload,
    toCard: (payload: unknown) => payload as WorkflowArtifactCard,
  });
  return registry;
}
