import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

const RADAR_NAME = 'airi-npc-awareness-radar'
const RADAR_CHUNK_RADIUS = 1

interface AwarenessChunkState {
  surface_index: number
  chunk_x: number
  chunk_y: number
}

declare const storage: {
  airi_awareness_chunk?: AwarenessChunkState
  airi_awareness_radar?: LuaEntity
}

function chunk_coordinate(value: number) {
  return math.floor(value / 32)
}

function destroy_radar() {
  const radar = storage.airi_awareness_radar
  if (radar?.valid) radar.destroy()
  storage.airi_awareness_radar = undefined
}

function ensure_radar(actor: ControlledActor) {
  let radar = storage.airi_awareness_radar
  if (radar?.valid && radar.surface.index !== actor.surface.index) {
    radar.destroy()
    radar = undefined
  }

  if (!radar?.valid) {
    radar = actor.surface.create_entity({
      name: RADAR_NAME,
      position: actor.position,
      force: actor.force,
    })
    if (!radar) return undefined
    radar.destructible = false
    radar.minable_flag = false
    radar.operable = false
    storage.airi_awareness_radar = radar
    return radar
  }

  radar.teleport(actor.position)
  return radar
}

export function new_awareness_controller() {
  function tick(actor: ControlledActor) {
    const identity = actor.status_snapshot()
    if (identity.kind !== 'standalone_character') {
      destroy_radar()
      storage.airi_awareness_chunk = undefined
      return false
    }

    ensure_radar(actor)

    const chunk_x = chunk_coordinate(actor.position.x)
    const chunk_y = chunk_coordinate(actor.position.y)
    const previous = storage.airi_awareness_chunk
    if (previous
      && previous.surface_index === actor.surface.index
      && previous.chunk_x === chunk_x
      && previous.chunk_y === chunk_y) {
      return false
    }

    // The hidden RadarPrototype handles the actual 3x3 fog-of-war visibility.
    // Chunk generation remains an explicit bounded safety net because a radar
    // cannot reveal terrain that does not exist yet, and standalone characters
    // do not get the normal LuaPlayer exploration/generation bubble.
    actor.surface.request_to_generate_chunks(actor.position, RADAR_CHUNK_RADIUS)
    actor.surface.force_generate_chunk_requests()

    storage.airi_awareness_chunk = {
      surface_index: actor.surface.index,
      chunk_x,
      chunk_y,
    }
    return true
  }

  return { tick }
}
