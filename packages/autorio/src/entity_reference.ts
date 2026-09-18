import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, LuaSurface, UnitNumber } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

export interface EntityReferenceHint {
  name: string
  surface_index: LuaSurface['index']
  force_index: number
  position: MapPositionStruct
  observed_tick: number
}

declare const storage: {
  airi_entity_reference_hints?: Record<number, EntityReferenceHint>
}

function hints() {
  storage.airi_entity_reference_hints ??= {}
  return storage.airi_entity_reference_hints
}

export function remember_entity_reference(entity: LuaEntity | undefined) {
  if (!entity || !entity.valid || entity.unit_number === undefined) return
  hints()[entity.unit_number] = {
    name: entity.name,
    surface_index: entity.surface.index,
    force_index: entity.force.index,
    position: { x: entity.position.x, y: entity.position.y },
    observed_tick: game.tick,
  }
}

export function entity_reference_hint(unit_number: number) {
  const hint = hints()[unit_number]
  if (!hint) return undefined
  return {
    ...hint,
    position: { x: hint.position.x, y: hint.position.y },
  }
}

export function resolve_exact_entity(actor: ControlledActor, unit_number: number) {
  const direct = game.get_entity_by_unit_number(unit_number as UnitNumber)
  if (direct && direct.valid) {
    remember_entity_reference(direct)
    return direct
  }

  // Some live entities observed through the actor surface are not returned by
  // game.get_entity_by_unit_number() immediately. The observation hint is only
  // a lookup aid for the *same* identity: never substitute a replacement that
  // merely has the same name and position.
  const hint = hints()[unit_number]
  if (!hint) return undefined
  if (hint.surface_index !== actor.surface.index || hint.force_index !== actor.force.index) return undefined

  const candidates = actor.surface.find_entities_filtered({
    position: hint.position,
    radius: 0.25,
    name: hint.name,
    force: actor.force,
  })
  for (const candidate of candidates) {
    if (!candidate.valid || candidate.unit_number !== unit_number) continue
    remember_entity_reference(candidate)
    return candidate
  }
  return undefined
}
