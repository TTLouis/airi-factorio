import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, LuaForce, LuaSurface } from 'factorio:runtime'
import type { ActorEntityBuildArgs, ActorMiningState, ActorShootingState, ActorStatusSnapshot, ActorWalkingState, ControlledActor } from './types'

declare const storage: {
  standalone_character_unit_number?: number
}

/**
 * A standalone `character` entity with no LuaPlayer behind it. Its unit_number
 * is persisted so the same NPC can be reacquired after save/load.
 */
export class StandaloneCharacterActor implements ControlledActor {
  private constructor(private readonly character_entity: LuaEntity) {}

  static create(surface: LuaSurface, force: LuaForce, position: MapPositionStruct): StandaloneCharacterActor | undefined {
    const entity = surface.create_entity({
      name: 'character',
      position,
      force,
    })

    if (!entity) {
      return undefined
    }

    storage.standalone_character_unit_number = entity.unit_number
    return new StandaloneCharacterActor(entity)
  }

  static reacquire(surface: LuaSurface): StandaloneCharacterActor | undefined {
    const unit_number = storage.standalone_character_unit_number
    if (unit_number === undefined) {
      return undefined
    }

    const entity = surface
      .find_entities_filtered({ name: 'character' })
      .find(candidate => candidate.unit_number === unit_number)

    if (!entity) {
      return undefined
    }

    return new StandaloneCharacterActor(entity)
  }

  get is_valid(): boolean {
    return this.character_entity.valid
  }

  get character() {
    return this.character_entity
  }

  get surface() {
    return this.character_entity.surface
  }

  get force() {
    return this.character_entity.force
  }

  get position() {
    return this.character_entity.position
  }

  get_main_inventory() {
    return this.character_entity.get_main_inventory()
  }

  update_selected_entity(position: MapPositionStruct) {
    // `character` entities inherit LuaControl, so selection works without a
    // LuaPlayer and is required for normal mining_state-driven mining.
    this.character_entity.update_selected_entity(position)
  }

  get_mining_state(): ActorMiningState {
    return this.character_entity.mining_state
  }

  set_mining_state(state: ActorMiningState) {
    this.character_entity.mining_state = state
  }

  set_walking_state(state: ActorWalkingState) {
    this.character_entity.walking_state = state
  }

  set_shooting_state(state: ActorShootingState) {
    this.character_entity.shooting_state = state
  }

  begin_crafting(params: { count: number, recipe: string }) {
    return this.character_entity.begin_crafting(params)
  }

  get_crafting_queue_count(recipe: string) {
    let count = 0
    for (const item of this.character_entity.crafting_queue ?? []) {
      if (item.recipe === recipe) {
        count += item.count
      }
    }
    return count
  }

  owns_player_index(_player_index: number): boolean {
    return false
  }

  entity_build_args(): ActorEntityBuildArgs {
    return { force: this.force }
  }

  status_snapshot(): ActorStatusSnapshot {
    return {
      kind: 'standalone_character',
      valid: this.character_entity.valid,
      name: 'AIRI',
      position: this.character_entity.position,
      has_character: true,
      actor_id: this.character_entity.unit_number,
    }
  }
}
