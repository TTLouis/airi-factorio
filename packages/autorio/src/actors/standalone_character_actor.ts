import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, LuaForce, LuaSurface } from 'factorio:runtime'
import type { ActorEntityBuildArgs, ActorMiningState, ActorShootingState, ActorStatusSnapshot, ActorWalkingState, ControlledActor } from './types'

// typed-factorio (targeting Factorio 2.0's runtime) doesn't predeclare the
// shape of `storage` — Factorio 2.0 replaced the old `global` table with it,
// and the project is expected to declare its own shape. This is the only
// file that touches storage today, so it's declared locally rather than as
// a wider ambient global.
declare const storage: {
  standalone_character_unit_number?: number
}

/**
 * A standalone `character` entity with no LuaPlayer behind it — the
 * accountless-NPC substrate the project's original design finding
 * identified. Not wired into control.ts's get_controlled_actor() yet: this
 * class exists and is unit-tested, but the live control path still
 * resolves to ConnectedPlayerActor. Persists its identity across
 * save/load via the entity's unit_number in `storage`.
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

  /**
   * Reacquires a previously-created standalone character by the
   * unit_number persisted in storage — for on_init/on_load. Returns
   * undefined if none was ever created, or if the persisted entity no
   * longer exists (e.g. it died and nothing replaced it).
   */
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

  update_selected_entity(_position: MapPositionStruct) {
    // No LuaPlayer selection cursor exists for a standalone character;
    // mining is driven entirely through set_mining_state below.
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
    this.character_entity.begin_crafting(params)
  }

  owns_player_index(_player_index: number): boolean {
    // No LuaPlayer exists behind a standalone character, so no
    // LuaPlayer-sourced event (on_player_crafted_item, etc.) can ever be
    // attributed to it.
    return false
  }

  entity_build_args(): ActorEntityBuildArgs {
    // No `player` field: placement attribution has nothing to borrow from
    // for a standalone character, unlike ConnectedPlayerActor.
    return { force: this.force }
  }

  status_snapshot(): ActorStatusSnapshot {
    return {
      kind: 'standalone_character',
      valid: this.character_entity.valid,
      name: 'AIRI',
      position: this.character_entity.position,
      has_character: true,
    }
  }
}
