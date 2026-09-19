export const meta = {
  name: 'work-ticket-orchestrator',
  description: 'End-to-end fix: understand, plan, implement, ship. Accepts a Linear ticket id OR a free-text prompt (ticketless). Autonomous end-to-end.',
  phases: [
    { title: 'Understand' },
    { title: 'Build' },
  ],
}

// Run-stats: count every sub-agent this script spawns (including those inside
// parallel()/pipeline() thunks) so the MR's "Run stats" line can report scale.
// agent() is an injected global with no readable counter, so wrap it in place — zero
// call-site churn. If the sandbox forbids reassigning the global, flip the reliability
// flag so the stats omit a wrong figure rather than reporting 0. (Duplicated in the
// sibling work-ticket-*.js scripts: each runs in its own injected scope, so there is no
// shared module to import.)
let runStatsAgents = 0
let runStatsAgentsReliable = true
try {
  const _agentImpl = agent
  agent = (...callArgs) => { runStatsAgents++; return _agentImpl(...callArgs) }
} catch (_e) {
  runStatsAgentsReliable = false
}

// Aggregate this orchestrator's own agent count with those of the sub-workflows that
// actually ran (Understand and/or Build), so the wrapper/front-door can print one
// "Run stats" total. A sub-workflow that didn't run contributes nothing; the count is
// only "reliable" if every script that ran could wrap its agent() global.
// output_tokens (budget.spent(), the whole-run cumulative output) already rides on the
// Build result and is preserved by the spread. So do mr_iid/branch — the wrapper's BRANCH:/MR:
// contract (and the never-disown-a-shipped-MR invariant) depends on this spread passing them
// through; a rewrite that rebuilds the result object instead of spreading would silently drop
// them and disowned sessions would come back.
function finalizeRunStats(result, ranSubResults) {
  const parts = [{ agents: runStatsAgents, agents_reliable: runStatsAgentsReliable }, ...ranSubResults.filter(Boolean)]
  const agents_total = parts.reduce((n, p) => n + (Number(p.agents) || 0), 0)
  const agents_reliable = parts.every(p => p.agents_reliable !== false)
  log(`run-stats: agents_total=${agents_total} (reliable=${agents_reliable}) output_tokens=${result?.output_tokens ?? 'n/a'}`)
  return { ...result, agents_total, agents_reliable }
}

// Max times a run may kick back to Understand (re-analyze a wrong root cause) before it ships with
// open findings recorded. This orchestrator loop is the single budget authority across BOTH
// within-build kickbacks and cross-workflow re-analyses (the counter is threaded through Build).
// Kept byte-identical with the copy in work-ticket-build-and-ship.js (no shared module across scripts).
const KICKBACK_BUDGET = 3

// args may arrive as a bare ticketId string, a JSON-stringified object, or an
// object — normalize all three.
let a = args
if (typeof a === 'string') {
  const s = a.trim()
  if (s.startsWith('{')) { try { a = JSON.parse(s) } catch (e) { a = { ticketId: s } } }
  else a = { ticketId: s }
}
a = a || {}
const ticketId = (a.ticketId || a.ticket_id || '').trim()
// A run is driven by EITHER a Linear ticket id OR a free-text prompt (ticketless).
let promptText = ((a.prompt || a.spec) || '').toString().trim()
// A large free-text prompt may be handed over BY FILE instead of inline: the headless `claude -p`
// that invokes this workflow was dropping/rewriting multi-KB inline args (see io-coding-agent-js.sh).
// The launcher writes the prompt to a file and passes only the path; read it back here via the same
// one-line shell agent pattern used for the plan.md probe (the sandbox has no direct fs access).
const promptFile = (a.promptFile || a.prompt_file || '').toString().trim()
if (!promptText && !ticketId && promptFile) {
  // promptFile reaches us through the headless `claude -p` tool call, and the spec that steers that
  // agent is attacker-influenceable (e.g. a Slack thread) — so treat the path as untrusted and never
  // let it shape the shell command. Accept ONLY the launcher's exact shape
  // (<dir>/io-agent-prompt-<slug>.txt, safe charset, no '..') and additionally single-quote it; the
  // allowlist already excludes quotes/metacharacters, so the quoting is belt-and-suspenders.
  const safePath = /^[A-Za-z0-9_./-]+\/io-agent-prompt-[A-Za-z0-9_.-]+\.txt$/.test(promptFile) && !promptFile.includes('..')
  if (!safePath) {
    log(`Refusing unexpected promptFile path: ${JSON.stringify(promptFile)}`)
    return { status: 'bad_input', error: 'invalid_prompt_file', ticket_id: null }
  }
  const loaded = await agent(`Run exactly: cat '${promptFile}'
    Report the file's exact contents verbatim in 'contents' (empty string if the file is missing or empty).`,
    { label: 'load-prompt-file', schema: { type: 'object', properties: { contents: { type: 'string' } }, required: ['contents'], additionalProperties: false } })
  promptText = (loaded?.contents || '').toString().trim()
}
// Optional reviewer feedback from a stopped attempt; woven into ticket.md downstream.
const feedback = (a.feedback || '').toString().trim()
if (ticketId && !/^[A-Za-z]+-\d+$/.test(ticketId)) {
  log(`Invalid ticket id: ${JSON.stringify(args)}`)
  return { status: 'bad_input', error: 'invalid_ticket_id', ticket_id: null }
}
if (!ticketId && !promptText) {
  log(`Provide a ticket id or a prompt: ${JSON.stringify(args)}`)
  return { status: 'bad_input', error: 'missing_ticket_or_prompt', ticket_id: null }
}
// Exactly one — mirror the Ruby tool's xor so a prompt isn't silently dropped when a
// ticketId is also passed.
if (ticketId && promptText) {
  log(`Provide a ticket id OR a prompt, not both: ${JSON.stringify(args)}`)
  return { status: 'bad_input', error: 'ticket_and_prompt', ticket_id: null }
}
// True only for ECS wrapper launches (io-coding-agent-js.sh sets it); gates build-and-ship's
// dirty-base auto-recovery, which must never fire where the dirt may be a human's work.
const orchestrated = a.orchestrated === true
const factoryControlPlaneDir = (a.factoryControlPlaneDir || a.factory_control_plane_dir || '').toString().trim()
const factoryControlPlaneSafe = !factoryControlPlaneDir || (
  /^\/[A-Za-z0-9._/-]+\/io-factory-control-plane\.[A-Za-z0-9]+$/.test(factoryControlPlaneDir)
  && !factoryControlPlaneDir.split('/').includes('..')
)
if (!factoryControlPlaneSafe) {
  log('Refusing malformed factory control-plane path')
  return { status: 'bad_input', error: 'invalid_control_plane', ticket_id: ticketId || null }
}
const workflowScript = (name) => factoryControlPlaneDir
  ? `${factoryControlPlaneDir}/${name}`
  : `.claude/workflows/${name}`
const childControlPlane = factoryControlPlaneDir ? { factoryControlPlaneDir } : {}
const factoryProtocol = Number(a.factoryProtocol || a.factory_protocol || 0)
const factorySessionId = Number(a.factorySessionId || a.factory_session_id || 0)
const factoryBranch = (a.factoryBranch || a.factory_branch || '').toString().trim()
const expectedFactoryBranch = `${ticketId ? ticketId.toLowerCase() : 'factory'}-s${factorySessionId}`
const factoryIdentityValid = factoryProtocol === 2
  && Number.isInteger(factorySessionId) && factorySessionId > 0
  && factoryBranch === expectedFactoryBranch
if (orchestrated && !factoryIdentityValid) {
  log('Refusing malformed factory run identity')
  return { status: 'bad_input', error: 'factory_protocol_mismatch', ticket_id: ticketId || null }
}
const childRunIdentity = factoryIdentityValid
  ? { factoryProtocol, factorySessionId, factoryBranch }
  : {}
// Forwarded unvalidated: build-and-ship is the only consumer that files, so it owns the refusal.
const followupsEnabledArg = a.followupsEnabled ?? a.followups_enabled
const childFollowupSettings = typeof followupsEnabledArg === 'boolean'
  ? {
      followupsEnabled: followupsEnabledArg === true,
      followupTeamId: a.followupTeamId ?? a.followup_team_id,
      followupStateId: a.followupStateId ?? a.followup_state_id,
      followupPriority: a.followupPriority ?? a.followup_priority,
    }
  : {}
const forceUnderstand = a.forceUnderstand === true
const initialKickbacksUsed = Number(a.kickbacksUsed || 0)
if (!Number.isInteger(initialKickbacksUsed) || initialKickbacksUsed < 0 || initialKickbacksUsed > KICKBACK_BUDGET) {
  log('Refusing malformed kickback counter')
  return { status: 'bad_input', error: 'invalid_kickback_count', ticket_id: ticketId || null }
}

// Resolve the work item. A given ticket is used as-is; a prompt runs ticketless, so a
// prompt from anyone in the company doesn't auto-pollute a team's board.
const effectiveTicketId = ticketId
const effectivePrompt = ticketId ? '' : promptText

const runLabel = effectiveTicketId || 'prompt run'
const ranResults = []

// FEEDBACK re-run (same workspace): only REVISE the prior work in place when the original run
// got far enough to have produced a plan. plan.md is written after ticket.md/root-cause.md and
// the branch rename, and BEFORE any code — so its presence guarantees every artifact the
// reviser path needs AND means real work exists to revise. Otherwise (stopped during Understand,
// before planning) there's nothing built to revise and no code to reset, so fall through to a
// fresh full run with the feedback folded into Understand (below, via work-ticket-understand.js → ticket.md).
if (feedback && !forceUnderstand) {
  const fbWorkDir = (a.workDir || a.work_dir || '').toString().trim()
    || (effectiveTicketId ? `.io-agent-${effectiveTicketId.toLowerCase()}` : '')
  // A ticketless (prompt) feedback re-run needs its workDir to locate the prior work — hashSlug
  // lives in work-ticket-understand.js so we can't recompute it here. Without it we can't tell revise-vs-
  // fresh, and a blind fall-through would re-run build-and-ship WITHOUT feedback and abort on
  // any prior code. Fail clearly. (Ticket re-runs resolve deterministically, so this only fires
  // for a prompt re-run that omitted workDir — the front-door always passes it.)
  if (!fbWorkDir) {
    log('Feedback re-run for a ticketless (prompt) run requires workDir — the .io-agent-prompt-* dir captured at the original launch.')
    return { status: 'bad_input', error: 'missing_workdir_for_prompt_feedback', ticket_id: null }
  }
  // The sandbox has no fs access, so probe plan.md via a one-line shell agent (like flushTrail).
  const planProbe = await agent(`Run exactly: test -f ${fbWorkDir}/plan.md && echo EXISTS || echo MISSING
    Report has_plan=true ONLY if it printed EXISTS.`,
    { label: 'feedback-plan-probe', schema: { type: 'object', properties: { has_plan: { type: 'boolean' } }, required: ['has_plan'], additionalProperties: false } })
  if (planProbe?.has_plan) {
    phase('Build')
    const fbResult = await workflow(
      { scriptPath: workflowScript('work-ticket-build-and-ship.js') },
      {
        ticketId: effectiveTicketId,
        prompt: effectivePrompt,
        workDir: fbWorkDir,
        feedback,
        orchestrated,
        notifySlack: a.notifySlack,
        slackThread: a.slackThread,
        ...childControlPlane,
        ...childRunIdentity,
        ...childFollowupSettings,
      },
    )
    return finalizeRunStats(fbResult, [...ranResults, fbResult])
  }
  // early stop (no plan.md) → fall through to the fresh full run below.
}

phase('Understand')
const rca = await workflow(
  { scriptPath: workflowScript('work-ticket-understand.js') },
  {
    ticketId: effectiveTicketId,
    prompt: effectivePrompt,
    feedback,
    slackThread: a.slackThread,
    ...childControlPlane,
    ...childRunIdentity,
  },
)
ranResults.push(rca)

if (rca?.already_fixed) {
  log(`${runLabel} already fixed on master`)
  return rca
}

// Propagate the inner workflow's precise early-exit (fetch_failed, bad_input,
// …) instead of collapsing every miss into a generic 'understand_failed'.
if (rca?.status || rca?.error) {
  log(`Understand phase aborted: ${rca.status || rca.error}`)
  return rca
}

if (!rca?.approaches?.length) {
  log('Understand phase failed: no approaches generated')
  return { status: 'understand_failed', error: 'understand_failed', ticket_id: effectiveTicketId || null }
}

const rootCauseConcerns = Array.isArray(rca.root_cause_concerns) ? rca.root_cause_concerns : []
if (rca.root_cause_confirmed === false) {
  log(`⚠️ ${runLabel}: root cause not confirmed — Build must resolve ${rootCauseConcerns.length} concern(s) with evidence`)
}

const approach = rca.approaches.find(x => x.recommended)?.name
  || rca.approaches[0]?.name
  || 'Fix the root cause as described in root-cause.md'
log(`Auto-selected approach: ${approach}`)

phase('Build')
let kickbacksUsed = initialKickbacksUsed
let result = await workflow(
  { scriptPath: workflowScript('work-ticket-build-and-ship.js') },
  {
    ticketId: effectiveTicketId,
    prompt: effectivePrompt,
    approach,
    workDir: rca.work_dir,
    rootCauseConcerns,
    orchestrated,
    notifySlack: a.notifySlack,
    slackThread: a.slackThread,
    kickbacksUsed,
    ...childControlPlane,
    ...childRunIdentity,
    ...childFollowupSettings,
  },
)
ranResults.push(result)

// Cross-workflow kickback: the pre-MR review judged the root cause wrong. Re-run Understand
// within this same session-owned branch before Ship creates any MR.
while (result?.kickback === 'understand' && kickbacksUsed < KICKBACK_BUDGET) {
  kickbacksUsed = Number(result.kickbacks_used) || (kickbacksUsed + 1)
  const kbFeedback = Array.isArray(result.feedback) ? result.feedback.join('\n') : String(result.feedback || '')
  log(`Root-cause kickback ${kickbacksUsed}/${KICKBACK_BUDGET}: re-running Understand with the final review's feedback`)
  const reRca = await workflow(
    { scriptPath: workflowScript('work-ticket-understand.js') },
    {
      ticketId: effectiveTicketId,
      prompt: effectivePrompt,
      feedback: kbFeedback,
      slackThread: a.slackThread,
      ...childControlPlane,
      ...childRunIdentity,
    },
  )
  ranResults.push(reRca)
  if (reRca?.already_fixed || reRca?.status || reRca?.error || !reRca?.approaches?.length) { result = reRca; break }
  const reApproach = reRca.approaches.find(x => x.recommended)?.name || reRca.approaches[0]?.name
    || 'Fix the root cause as described in root-cause.md'
  const reRootCauseConcerns = Array.isArray(reRca.root_cause_concerns) ? reRca.root_cause_concerns : []
  result = await workflow(
    { scriptPath: workflowScript('work-ticket-build-and-ship.js') },
    {
      ticketId: effectiveTicketId,
      prompt: effectivePrompt,
      approach: reApproach,
      workDir: reRca.work_dir,
      rootCauseConcerns: reRootCauseConcerns,
      orchestrated,
      notifySlack: a.notifySlack,
      slackThread: a.slackThread,
      kickbacksUsed,
      ...childControlPlane,
      ...childRunIdentity,
      ...childFollowupSettings,
    },
  )
  ranResults.push(result)
}

return finalizeRunStats(result, ranResults)
