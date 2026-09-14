import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, LuaForce, LuaSurface } from 'factorio:runtime'
import type { ActorCraftingQueueItem, ActorEntityBuildArgs, ActorMiningState, ActorShootingState, ActorStatusSnapshot, ActorWalkingState, ControlledActor } from './types'

declare const storage: {
  standalone_character_unit_number?: number
}

/**
 * A standalone `character` entity with no LuaPlayer behind it. The legacy
 * singleton helpers persist one unit_number; swarm callers use the untracked
 * helpers and persist logical->physical identity in swarm storage instead.
 */
export class StandaloneCharacterActor implements ControlledActor {
  private constructor(private readonly character_entity: LuaEntity) {}

  static create_untracked(surface: LuaSurface, force: LuaForce, position: MapPositionStruct): StandaloneCharacterActor | undefined {
    const entity = surface.create_entity({
      name: 'character',
      position,
      force,
    })

    if (!entity) {
      return undefined
    }

    return new StandaloneCharacterActor(entity)
  }

  static create(surface: LuaSurface, force: LuaForce, position: MapPositionStruct): StandaloneCharacterActor | undefined {
    const actor = StandaloneCharacterActor.create_untracked(surface, force, position)
    if (!actor) {
      return undefined
    }

    storage.standalone_character_unit_number = actor.character_entity.unit_number
    return actor
  }

  static reacquire_unit(surface: LuaSurface, unit_number: number): StandaloneCharacterActor | undefined {
    const entity = surface
      .find_entities_filtered({ name: 'character' })
      .find(candidate => candidate.unit_number === unit_number)

    if (!entity) {
      return undefined
    }

    return new StandaloneCharacterActor(entity)
  }

  static reacquire(surface: LuaSurface): StandaloneCharacterActor | undefined {
    const unit_number = storage.standalone_character_unit_number
    if (unit_number === undefined) {
      return undefined
    }

    return StandaloneCharacterActor.reacquire_unit(surface, unit_number)
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
    const state = this.character_entity.mining_state

    // Factorio mines the currently selected entity. A standalone scripted
    // character can retain `mining_state.mining = true` after a resource cycle
    // while its selection has been cleared or its real character mining
    // progress has fallen back to zero. In Factorio 2.0.x, LuaEntity's generic
    // `mining_progress` field is mining-drill-only; character progress is
    // exposed through the inherited LuaControl `character_mining_progress`.
    // Treat either stopped condition as effectively idle so control.ts can
    // reselect the persisted target and start the next requested cycle.
    if (state.mining && (!this.character_entity.selected || this.character_entity.character_mining_progress === 0)) {
      return { mining: false }
    }

    return state
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

  get_craftable_count(recipe: string) {
    return this.character_entity.get_craftable_count(recipe)
  }

  begin_crafting(params: { count: number, recipe: string }) {
    return this.character_entity.begin_crafting(params)
  }

  cancel_crafting(params: { index: number, count: number }) {
    this.character_entity.cancel_crafting(params)
  }

  get_crafting_queue(): ActorCraftingQueueItem[] {
    const result: ActorCraftingQueueItem[] = []
    for (const item of this.character_entity.crafting_queue ?? []) {
      result.push({
        index: item.index,
        recipe: item.recipe,
        count: item.count,
        prerequisite: item.prerequisite,
      })
    }
    return result
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
    const selected = this.character_entity.selected

    return {
      kind: 'standalone_character',
      valid: this.character_entity.valid,
      name: 'AIRI',
      position: this.character_entity.position,
      has_character: true,
      actor_id: this.character_entity.unit_number,
      selected_entity: selected
        ? {
            name: selected.name,
            position: selected.position,
          }
        : undefined,
      mining_state: this.character_entity.mining_state,
      mining_progress: this.character_entity.character_mining_progress,
    }
  }
}
