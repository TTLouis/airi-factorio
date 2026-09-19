import {
  decisionEnvelopeQuestions,
  parseDecisionEnvelope,
} from './jev-decision-taxonomy.mjs'
import { sanitizeStrategicProjectBoard } from './strategic-project-board.mjs'
import { evaluateSwarmOutcomeSnapshot } from './swarm-outcome-verdict.mjs'
import { summarizeSwarmConditionWait } from './swarm-condition-wait.mjs'
import {
  buildSwarmRecoveryCapsule,
  swarmRecoveryDecisionQuestions,
} from './swarm-recovery-route.mjs'

const MAX_ITEMS = 12
const MAX_TEXT = 240

function clean(value, max = MAX_TEXT) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function boundedList(value) {
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS) : []
}


function authoritativeCount(snapshot, key, fallback) {
  const value = snapshot?.counts?.[key]
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function summarizeRecords(records, idKeys = ['id']) {
  return boundedList(records).map((record) => {
    const id = idKeys.map(key => record?.[key]).find(value => value !== undefined && value !== null)
    return {
      id: clean(id, 100),
      status: clean(record?.status ?? record?.state, 80),
      priority: Number.isFinite(record?.priority) ? record.priority : undefined,
      summary: clean(record?.title ?? record?.description ?? record?.kind ?? '', MAX_TEXT),
    }
  })
}

export function swarmJevShadowQuestions() {
  return decisionEnvelopeQuestions()
}

export function swarmJevRecoveryShadowQuestions() {
  return swarmRecoveryDecisionQuestions()
}

export function buildSwarmJevShadowContext(snapshot = {}) {
  const missionSource = Array.isArray(snapshot.missions) ? snapshot.missions : []
  const objectiveSource = Array.isArray(snapshot.objectives) ? snapshot.objectives : []
  const projectSource = Array.isArray(snapshot.projects) ? snapshot.projects : []
  const requestSource = Array.isArray(snapshot.requests) ? snapshot.requests : []
  const workSource = Array.isArray(snapshot.work) ? snapshot.work : []
  const warningSource = Array.isArray(snapshot.warnings) ? snapshot.warnings : []
  const claimSource = Array.isArray(snapshot.claims) ? snapshot.claims : []
  const resultSource = Array.isArray(snapshot.results) ? snapshot.results : []
  const agentSource = Array.isArray(snapshot.agents) ? snapshot.agents : []
  const actorSource = Array.isArray(snapshot.actors) ? snapshot.actors : []
  const evidenceSource = Array.isArray(snapshot.evidence) ? snapshot.evidence : []
  const missions = boundedList(missionSource)
  const objectives = boundedList(objectiveSource)
  const projects = boundedList(projectSource)
  const requests = boundedList(requestSource)
  const work = boundedList(workSource)
  const warnings = boundedList(warningSource)
  const claims = boundedList(claimSource)
  const results = boundedList(resultSource)
  const agents = boundedList(agentSource)
  const actors = boundedList(actorSource)
  const evidence = boundedList(evidenceSource)
  const strategicBoard = snapshot.strategicBoard && typeof snapshot.strategicBoard === 'object'
    ? sanitizeStrategicProjectBoard(snapshot.strategicBoard)
    : undefined
  const outcomeSource = snapshot.outcome && typeof snapshot.outcome === 'object'
    ? snapshot.outcome
    : undefined
  const outcomeVerdict = outcomeSource
    ? evaluateSwarmOutcomeSnapshot({
        work: outcomeSource.work,
        objective: outcomeSource.objective,
        mission: outcomeSource.mission,
        objectives: outcomeSource.objectives,
        strategicBoard,
        strategicMilestoneVerification: outcomeSource.strategicMilestoneVerification,
      })
    : undefined
  const conditionWait = summarizeSwarmConditionWait(snapshot.conditionWait, {
    missions: missionSource,
    objectives: objectiveSource,
    projects: projectSource,
    requests: requestSource,
    work: workSource,
  })
  const recoverySource = snapshot.recovery && typeof snapshot.recovery === 'object'
    ? snapshot.recovery
    : undefined
  const recoveryCapsule = recoverySource
    ? buildSwarmRecoveryCapsule({
        reason: recoverySource.reason,
        reconciliationActions: recoverySource.reconciliationActions,
        runtime: recoverySource.runtime,
        outcome: recoverySource.outcome,
        observationBudgetAvailable: recoverySource.observationBudgetAvailable,
        blockerGrounded: recoverySource.blockerGrounded,
      })
    : undefined

  return {
    schema: 'swarm_jev_shadow_v1',
    strategic_project_board: strategicBoard
      ? {
          goal_id: strategicBoard.goal_id,
          title: strategicBoard.title,
          status: strategicBoard.status,
          current_milestone: strategicBoard.current_milestone
            ? {
                id: strategicBoard.current_milestone.id,
                title: strategicBoard.current_milestone.title,
              }
            : undefined,
          next_milestones: strategicBoard.next_milestones.map(item => ({
            id: item.id,
            title: item.title,
          })),
          development_direction: strategicBoard.development_direction,
          transition_state: strategicBoard.transition_state,
          revision: strategicBoard.revision,
        }
      : undefined,
    outcome_verdict: outcomeVerdict,
    condition_wait: conditionWait,
    recovery: recoveryCapsule,
    counts: {
      missions: authoritativeCount(snapshot, 'missions', missionSource.length),
      objectives: authoritativeCount(snapshot, 'objectives', objectiveSource.length),
      projects: authoritativeCount(snapshot, 'projects', projectSource.length),
      requests: authoritativeCount(snapshot, 'requests', requestSource.length),
      work: authoritativeCount(snapshot, 'work', workSource.length),
      warnings: authoritativeCount(snapshot, 'activeWarnings', warningSource.length),
      claims: authoritativeCount(snapshot, 'claims', claimSource.length),
      results: authoritativeCount(snapshot, 'results', resultSource.length),
      agents: authoritativeCount(snapshot, 'agents', agentSource.length),
      actors: authoritativeCount(snapshot, 'actors', actorSource.length),
      evidence: evidenceSource.length,
    },
    missions: summarizeRecords(missions),
    objectives: summarizeRecords(objectives),
    projects: summarizeRecords(projects),
    requests: summarizeRecords(requests),
    work: summarizeRecords(work),
    warnings: summarizeRecords(warnings),
    claims: summarizeRecords(claims, ['id', 'claimId']),
    results: summarizeRecords(results),
    agents: summarizeRecords(agents, ['id', 'agentId']),
    actors: summarizeRecords(actors, ['agentId', 'actorId', 'id']),
    runtime: snapshot.runtime && typeof snapshot.runtime === 'object'
      ? {
          healthy: snapshot.runtime.healthy === true,
          active: snapshot.runtime.active === true,
          blocked: snapshot.runtime.blocked === true,
          reason: clean(snapshot.runtime.reason, 240),
        }
      : undefined,
    evidence: evidence.map(item => ({
      kind: clean(item?.kind, 100),
      id: clean(item?.id ?? item?.ref, 100),
      summary: clean(item?.summary, MAX_TEXT),
    })),
  }
}

export function parseSwarmJevShadowDecision(response) {
  return {
    authority: 'shadow',
    decision: parseDecisionEnvelope(response),
    effects: [],
  }
}

export function validateSwarmJevShadowDecision(value) {
  return value?.authority === 'shadow'
    && Array.isArray(value.effects)
    && value.effects.length === 0
    && value?.decision
    && typeof value.decision === 'object'
}
