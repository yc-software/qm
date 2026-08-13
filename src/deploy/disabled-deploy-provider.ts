import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployProvider } from "./deploy-provider.ts";

const disabled = (): never => {
  throw new Error("Hosted app deployments are disabled for this QM runtime");
};

export function createDisabledDeployProvider(): DeployProvider {
  return {
    profile: { managedScaleToZero: true },
    async apply(_deployment: Deployment, _version: DeploymentVersion) {
      return disabled();
    },
    async destroy(_deployment: Deployment): Promise<void> {},
  };
}
