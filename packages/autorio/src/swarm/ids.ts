export type AgentId = `npc-${number}`
export type ActorId = number
export type WorkId = `work-${number}`
export type MissionId = `mission-${number}`
export type ObjectiveId = `objective-${number}`
export type ProjectId = `project-${number}`
export type ClaimId = `claim-${number}`
export type ResultId = `result-${number}`
export type RequestId = `request-${number}`
export type EventId = `event-${number}`

function positive_serial(value: number, label: string) {
  if (typeof value !== 'number' || value !== math.floor(value) || value < 1 || value > 9007199254740991) {
    error(`${label} must be a positive safe integer`)
  }
  return value
}

export function agent_id(serial: number): AgentId {
  return `npc-${positive_serial(serial, 'agent serial')}` as AgentId
}

export function work_id(serial: number): WorkId {
  return `work-${positive_serial(serial, 'work serial')}` as WorkId
}

export function mission_id(serial: number): MissionId {
  return `mission-${positive_serial(serial, 'mission serial')}` as MissionId
}

export function objective_id(serial: number): ObjectiveId {
  return `objective-${positive_serial(serial, 'objective serial')}` as ObjectiveId
}

export function project_id(serial: number): ProjectId {
  return `project-${positive_serial(serial, 'project serial')}` as ProjectId
}

export function claim_id(serial: number): ClaimId {
  return `claim-${positive_serial(serial, 'claim serial')}` as ClaimId
}

export function result_id(serial: number): ResultId {
  return `result-${positive_serial(serial, 'result serial')}` as ResultId
}

export function request_id(serial: number): RequestId {
  return `request-${positive_serial(serial, 'request serial')}` as RequestId
}

export function event_id(serial: number): EventId {
  return `event-${positive_serial(serial, 'event serial')}` as EventId
}
