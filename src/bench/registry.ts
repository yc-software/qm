import type { BenchTask, Fixture, Verifier } from "./core/types.ts";
import { gold as founderCrisisBriefGold, task as founderCrisisBrief } from "./tasks/founder-crisis-brief/task.ts";
import {
  gold as groundedAdviceEvidenceGold,
  task as groundedAdviceEvidence,
} from "./tasks/grounded-advice-evidence/task.ts";
import {
  gold as officeHoursMeetingBriefGold,
  task as officeHoursMeetingBrief,
} from "./tasks/office-hours-meeting-brief/task.ts";
import {
  gold as officeHoursCommitmentsGold,
  task as officeHoursCommitments,
} from "./tasks/office-hours-commitments/task.ts";
import {
  gold as portfolioUpdateRecordsGold,
  task as portfolioUpdateRecords,
} from "./tasks/portfolio-update-records/task.ts";
import {
  gold as portfolioTriageAttentionGold,
  task as portfolioTriageAttention,
} from "./tasks/portfolio-triage-attention/task.ts";
import { gold as networkFindPeersGold, task as networkFindPeers } from "./tasks/network-find-peers/task.ts";
import { gold as networkDraftIntroGold, task as networkDraftIntro } from "./tasks/network-draft-intro/task.ts";
import { gold as eventsAssignSessionsGold, task as eventsAssignSessions } from "./tasks/events-assign-sessions/task.ts";
import {
  gold as eventsHandleSchedulingChangesGold,
  task as eventsHandleSchedulingChanges,
} from "./tasks/events-handle-scheduling-changes/task.ts";
import {
  gold as financeConsolidateRecordsGold,
  task as financeConsolidateRecords,
} from "./tasks/finance-consolidate-records/task.ts";
import {
  gold as financeFlagExceptionsGold,
  task as financeFlagExceptions,
} from "./tasks/finance-flag-exceptions/task.ts";
import {
  gold as legalPacketCompletenessGold,
  task as legalPacketCompleteness,
} from "./tasks/legal-packet-completeness/task.ts";
import { gold as legalClauseChangesGold, task as legalClauseChanges } from "./tasks/legal-clause-changes/task.ts";
import {
  gold as knowledgeCaptureFactsGold,
  task as knowledgeCaptureFacts,
} from "./tasks/knowledge-capture-facts/task.ts";
import {
  gold as knowledgeRefreshStaleGold,
  task as knowledgeRefreshStale,
} from "./tasks/knowledge-refresh-stale/task.ts";

export function allTasks(): BenchTask[] {
  return [
    founderCrisisBrief(),
    groundedAdviceEvidence(),
    officeHoursMeetingBrief(),
    officeHoursCommitments(),
    portfolioUpdateRecords(),
    portfolioTriageAttention(),
    networkFindPeers(),
    networkDraftIntro(),
    eventsAssignSessions(),
    eventsHandleSchedulingChanges(),
    financeConsolidateRecords(),
    financeFlagExceptions(),
    legalPacketCompleteness(),
    legalClauseChanges(),
    knowledgeCaptureFacts(),
    knowledgeRefreshStale(),
  ];
}

type Gold = (fixture: Fixture<never>) => Record<string, string>;

const GOLD: Record<string, Gold> = {
  "founder-crisis-brief": founderCrisisBriefGold as Gold,
  "grounded-advice-evidence": groundedAdviceEvidenceGold as Gold,
  "office-hours-meeting-brief": officeHoursMeetingBriefGold as Gold,
  "office-hours-commitments": officeHoursCommitmentsGold as Gold,
  "portfolio-update-records": portfolioUpdateRecordsGold as Gold,
  "portfolio-triage-attention": portfolioTriageAttentionGold as Gold,
  "network-find-peers": networkFindPeersGold as Gold,
  "network-draft-intro": networkDraftIntroGold as Gold,
  "events-assign-sessions": eventsAssignSessionsGold as Gold,
  "events-handle-scheduling-changes": eventsHandleSchedulingChangesGold as Gold,
  "finance-consolidate-records": financeConsolidateRecordsGold as Gold,
  "finance-flag-exceptions": financeFlagExceptionsGold as Gold,
  "legal-packet-completeness": legalPacketCompletenessGold as Gold,
  "legal-clause-changes": legalClauseChangesGold as Gold,
  "knowledge-capture-facts": knowledgeCaptureFactsGold as Gold,
  "knowledge-refresh-stale": knowledgeRefreshStaleGold as Gold,
};

export function goldOutputs(task: BenchTask, fixture: Fixture<unknown>): Record<string, string> {
  const gold = GOLD[task.id];
  if (!gold) throw new Error(`no gold solution registered for ${task.id}`);
  return gold(fixture as Fixture<never>);
}

export function verifierFor(taskId: string): Verifier {
  const task = allTasks().find((t) => t.id === taskId);
  if (!task) throw new Error(`no verifier registered for task ${taskId}`);
  return task;
}
