import type { CapturedArtifact } from "../runner.ts";

export interface ContractInput {
  stdout: string;
  sourceKey: string;
  forge: "github" | "gitlab";
  publishProject: string;
}

function prUrl(forge: ContractInput["forge"], publishProject: string, mr: string): string {
  return forge === "github"
    ? `https://github.com/${publishProject}/pull/${mr}`
    : `https://gitlab.com/${publishProject.replace(/%2F/gi, "/")}/-/merge_requests/${mr}`;
}

export function parseFactoryContract(input: ContractInput): CapturedArtifact[] {
  let branch: string | undefined;
  let mr: string | undefined;
  let alreadyFixed = false;
  let commit: string | undefined;
  let evidence: string | undefined;

  for (const line of input.stdout.split(/\r?\n/)) {
    if (line === "ALREADY_FIXED:true") alreadyFixed = true;

    const branchMatch = /^BRANCH:\s*(.+?)\s*$/.exec(line);
    const branchValue = branchMatch?.[1]?.trim();
    if (branchValue) branch = branchValue;

    const mrMatch = /^MR:\s*!?(\d+)\s*$/.exec(line);
    if (mrMatch?.[1] !== undefined) mr = mrMatch[1];

    const commitMatch = /^ALREADY_FIXED_COMMIT:\s*([0-9a-f]{7,40})\s*$/i.exec(line);
    if (commitMatch?.[1] !== undefined) commit = commitMatch[1];

    const evidenceMatch = /^ALREADY_FIXED_EVIDENCE:\s*(.*)$/.exec(line);
    const evidenceValue = evidenceMatch?.[1]?.trim();
    if (evidenceValue) evidence = evidenceValue;
  }

  if (alreadyFixed) {
    const summary = evidence ?? (commit !== undefined ? `commit ${commit}` : undefined);
    return [
      {
        shipAction: "close_already_fixed",
        title: `${input.sourceKey}: already fixed`,
        capturedBy: "classifier",
        ...(summary !== undefined ? { summary } : {}),
        ...(mr !== undefined ? { externalRef: prUrl(input.forge, input.publishProject, mr) } : {}),
      },
    ];
  }

  if (branch !== undefined && mr !== undefined) {
    return [
      {
        shipAction: "open_pr",
        title: `${input.sourceKey}: pull request #${mr}`,
        label: branch,
        externalRef: prUrl(input.forge, input.publishProject, mr),
        capturedBy: "classifier",
      },
    ];
  }

  return [];
}
