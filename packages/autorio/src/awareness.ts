import type { ControlledActor } from './actors/types'

const CHUNK_SIZE = 32
const RADAR_CHUNK_RADIUS = 1

interface AwarenessChunkState {
  surface_index: number
  chunk_x: number
  chunk_y: number
}

declare const storage: {
  airi_awareness_chunk?: AwarenessChunkState
}

function chunk_coordinate(value: number) {
  return math.floor(value / CHUNK_SIZE)
}

export function new_awareness_controller() {
  function tick(actor: ControlledActor) {
    const identity = actor.status_snapshot()
    if (identity.kind !== 'standalone_character') return false

    const chunk_x = chunk_coordinate(actor.position.x)
    const chunk_y = chunk_coordinate(actor.position.y)
    const previous = storage.airi_awareness_chunk
    if (previous
      && previous.surface_index === actor.surface.index
      && previous.chunk_x === chunk_x
      && previous.chunk_y === chunk_y) {
      return false
    }

    // A standalone character does not get the normal player exploration bubble.
    // Keep a 3x3 chunk generation/chart window centered on AIRI's current chunk
    // so the pathfinder has terrain ahead and humans can see where AIRI went.
    actor.surface.request_to_generate_chunks(actor.position, RADAR_CHUNK_RADIUS)
    actor.force.chart(actor.surface, {
      left_top: {
        x: (chunk_x - RADAR_CHUNK_RADIUS) * CHUNK_SIZE,
        y: (chunk_y - RADAR_CHUNK_RADIUS) * CHUNK_SIZE,
      },
      right_bottom: {
        x: (chunk_x + RADAR_CHUNK_RADIUS + 1) * CHUNK_SIZE,
        y: (chunk_y + RADAR_CHUNK_RADIUS + 1) * CHUNK_SIZE,
      },
    })

    storage.airi_awareness_chunk = {
      surface_index: actor.surface.index,
      chunk_x,
      chunk_y,
    }
    return true
  }

  return { tick }
}
