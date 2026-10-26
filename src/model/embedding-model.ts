export interface EmbeddingModel {
  kind: "embedding";
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
}

export function isEmbeddingModel(model: object): model is EmbeddingModel {
  return "kind" in model && model.kind === "embedding";
}
