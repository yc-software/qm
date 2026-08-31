export const WORKFLOW_ARTIFACT_MIME = "application/vnd.qm.workflow-artifact+json;v=1";
export const WORKFLOW_ARTIFACT_SUFFIX = ".workflow.json";

export function workflowArtifactMime(value: string | undefined): typeof WORKFLOW_ARTIFACT_MIME | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === WORKFLOW_ARTIFACT_MIME || normalized === `${WORKFLOW_ARTIFACT_MIME}; charset=utf-8`) {
    return WORKFLOW_ARTIFACT_MIME;
  }
  return undefined;
}
