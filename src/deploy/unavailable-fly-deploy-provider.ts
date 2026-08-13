import type { DeployProvider } from "./deploy-provider.ts";

const unavailable = (): Error =>
  new Error(
    'application publishing is unavailable on Fly because qm has no Fly deploy provider — set DEPLOY_PROVIDER="aws" with its required AWS settings, or run core where Docker is available.',
  );

export function createUnavailableFlyDeployProvider(): DeployProvider {
  return {
    profile: { managedScaleToZero: false },
    apply: async () => {
      throw unavailable();
    },
    destroy: async () => {
      throw unavailable();
    },
  };
}
