type ActorMode = 'player' | 'npc'
type Store = {
  airi_deployment_session?: string
  airi_deployment_mode?: ActorMode
  airi_deployment_actor_id?: number
  airi_deployment_actor_kind?: string
  airi_deployment_epoch?: number
}

declare const storage: Store

function state(): Store {
  return storage as unknown as Store
}

function actor_status() {
  return remote.call('autorio_actor', 'status') as {
    mode?: ActorMode
    actor?: {
      actor_id?: number
      kind?: string
      valid?: boolean
      has_character?: boolean
    }
    connected_players?: number
  }
}

function operation_status() {
  return remote.call('autorio_operations', 'status') as {
    task_state?: string
    queue_empty?: boolean
    queue_length?: number
  }
}

function current_matches_session() {
  const data = state()
  if (!data.airi_deployment_session || !data.airi_deployment_mode || data.airi_deployment_actor_id === undefined || !data.airi_deployment_actor_kind) {
    return false
  }
  const status = actor_status()
  const actor = status.actor
  if (!actor || actor.valid !== true || actor.has_character !== true) {
    return false
  }
  if (status.mode !== data.airi_deployment_mode || actor.actor_id !== data.airi_deployment_actor_id || actor.kind !== data.airi_deployment_actor_kind) {
    return false
  }
  if (data.airi_deployment_mode === 'npc') {
    return actor.kind === 'standalone_character'
  }
  return actor.kind === 'connected_player'
}

function cancel_tasks() {
  if (remote.interfaces.autorio_operations !== undefined) {
    remote.call('autorio_operations', 'cancel_all_tasks')
  }
}

function configure(mode: ActorMode, session: string) {
  log(`[AIRI-DEBUG] configure: received mode=${helpers.table_to_json(mode)} (type ${typeof mode}), session=${helpers.table_to_json(session)} (type ${typeof session}, length ${session ? session.length : -1})`)
  if ((mode !== 'npc' && mode !== 'player') || session === '') {
    log('[AIRI-DEBUG] configure: early-return, invalid mode or empty session')
    return false
  }

  cancel_tasks()
  const changed = remote.call('autorio_actor', 'set_mode', mode) as [boolean, unknown]
  log(`[AIRI-DEBUG] configure: set_mode returned changed=${helpers.table_to_json(changed)}`)
  if (!changed || changed[0] !== true) {
    return false
  }

  const status = actor_status()
  log(`[AIRI-DEBUG] configure: post-set_mode status=${helpers.table_to_json(status)}`)
  const actor = status.actor
  if (!actor || status.mode !== mode || actor.valid !== true || actor.has_character !== true || actor.actor_id === undefined) {
    log('[AIRI-DEBUG] configure: actor validity check failed')
    return false
  }
  if (mode === 'npc' && actor.kind !== 'standalone_character') {
    log(`[AIRI-DEBUG] configure: npc kind mismatch, actor.kind=${actor.kind}`)
    return false
  }
  if (mode === 'player' && actor.kind !== 'connected_player') {
    return false
  }

  const data = state()
  data.airi_deployment_mode = mode
  data.airi_deployment_session = session
  data.airi_deployment_actor_id = actor.actor_id
  data.airi_deployment_actor_kind = actor.kind
  data.airi_deployment_epoch = (data.airi_deployment_epoch ?? 0) + 1
  return session
}

remote.add_interface('airi_deployment', {
  configure,
  status: () => {
    const actor = actor_status()
    const tasks = operation_status()
    return {
      revision: 'airi-deploy-v8-npc-staging',
      session: state().airi_deployment_session ?? '',
      mode: state().airi_deployment_mode,
      actor_id: actor.actor?.actor_id,
      actor_kind: actor.actor?.kind,
      connected_players: actor.connected_players ?? 0,
      allowed: current_matches_session(),
      idle: tasks.task_state === 'idle' && tasks.queue_empty === true && tasks.queue_length === 0,
      epoch: state().airi_deployment_epoch ?? 0,
      tools: remote.interfaces.autorio_tools !== undefined,
      operations: remote.interfaces.autorio_operations !== undefined,
      actor_interface: remote.interfaces.autorio_actor !== undefined,
    }
  },
  authorize: (epoch: number) => current_matches_session() && epoch === (state().airi_deployment_epoch ?? 0),
  cancel: () => {
    cancel_tasks()
    state().airi_deployment_epoch = (state().airi_deployment_epoch ?? 0) + 1
    return true
  },
  disable: () => {
    cancel_tasks()
    state().airi_deployment_session = ''
    state().airi_deployment_epoch = (state().airi_deployment_epoch ?? 0) + 1
    return true
  },
})
