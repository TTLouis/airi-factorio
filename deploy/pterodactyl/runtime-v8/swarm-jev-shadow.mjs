import {
  decisionEnvelopeQuestions,
  parseDecisionEnvelope,
} from './jev-decision-taxonomy.mjs'

const MAX_ITEMS = 12
const MAX_TEXT = 240

function clean(value, max = MAX_TEXT) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function boundedList(value) {
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS) : []
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

export function buildSwarmJevShadowContext(snapshot = {}) {
  const missions = boundedList(snapshot.missions)
  const requests = boundedList(snapshot.requests)
  const work = boundedList(snapshot.work)
  const claims = boundedList(snapshot.claims)
  const actors = boundedList(snapshot.actors)
  const evidence = boundedList(snapshot.evidence)

  return {
    schema: 'swarm_jev_shadow_v1',
    project: snapshot.project && typeof snapshot.project === 'object'
      ? {
          id: clean(snapshot.project.id ?? snapshot.project.project_id, 100),
          title: clean(snapshot.project.title ?? snapshot.project.objective, 500),
          status: clean(snapshot.project.status, 80),
          milestone: clean(snapshot.project.current_milestone?.title ?? snapshot.project.milestone, 500),
          development_direction: clean(snapshot.project.development_direction, 80),
        }
      : undefined,
    counts: {
      missions: missions.length,
      requests: requests.length,
      work: work.length,
      claims: claims.length,
      actors: actors.length,
      evidence: evidence.length,
    },
    missions: summarizeRecords(missions),
    requests: summarizeRecords(requests),
    work: summarizeRecords(work),
    claims: summarizeRecords(claims, ['id', 'claimId']),
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
