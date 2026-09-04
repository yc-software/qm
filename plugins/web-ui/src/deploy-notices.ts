export interface DeploymentNotices {
  list: string;
  detail: { id: string; text: string } | null;
}

export function withDeploymentListNotice(notices: DeploymentNotices, list: string): DeploymentNotices {
  return { ...notices, list };
}

export function withDeploymentDetailNotice(notices: DeploymentNotices, id: string, text: string): DeploymentNotices {
  return { ...notices, detail: { id, text } };
}

export function withoutDeploymentDetailNotice(notices: DeploymentNotices): DeploymentNotices {
  return { ...notices, detail: null };
}
