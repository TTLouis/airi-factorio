import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, LuaForce, LuaSurface } from 'factorio:runtime'
import type { ActorCraftingQueueItem, ActorEntityBuildArgs, ActorMiningState, ActorShootingState, ActorStatusSnapshot, ActorWalkingState, ControlledActor } from './types'

export interface StandaloneNpcIdentity {
  id: string
  name: string
}

declare const storage: {
  standalone_character_unit_number?: number
  standalone_npc_identity?: StandaloneNpcIdentity
  standalone_npc_identity_serial?: number
}

const NPC_NAMES = [
  'Aster',
  'Cinder',
  'Ember',
  'Kite',
  'Luma',
  'Mira',
  'Nova',
  'Piper',
  'Rook',
  'Vale',
]

export function allocate_standalone_npc_identity(): StandaloneNpcIdentity {
  const serial = storage.standalone_npc_identity_serial ?? 1
  storage.standalone_npc_identity_serial = serial + 1
  const index = math.random(1, NPC_NAMES.length) - 1
  return {
    id: `npc-${serial}`,
    name: `${NPC_NAMES[index]}-${serial}`,
  }
}

function ensure_identity(): StandaloneNpcIdentity {
  if (storage.standalone_npc_identity) return storage.standalone_npc_identity
  const identity = allocate_standalone_npc_identity()
  storage.standalone_npc_identity = identity
  return identity
}

/**
 * A standalone `character` entity with no LuaPlayer behind it. Its unit_number
 * is persisted so the same physical body can be reacquired after save/load.
 * A separate logical NPC identity is persisted across body death/replacement.
 *
 * The legacy create/reacquire helpers remain the authoritative single-NPC path.
 * Swarm registry code may additionally wrap other standalone character bodies
 * with explicit persisted identities without mutating the legacy primary-body
 * storage keys.
 */
export class StandaloneCharacterActor implements ControlledActor {
  private constructor(
    private readonly character_entity: LuaEntity,
    private readonly identity: StandaloneNpcIdentity,
  ) {}

  static create(surface: LuaSurface, force: LuaForce, position: MapPositionStruct): StandaloneCharacterActor | undefined {
    const entity = surface.create_entity({
      name: 'character',
      position,
      force,
    })

    if (!entity) return undefined

    const identity = ensure_identity()
    storage.standalone_character_unit_number = entity.unit_number
    return new StandaloneCharacterActor(entity, identity)
  }

  static create_registered(
    surface: LuaSurface,
    force: LuaForce,
    position: MapPositionStruct,
    identity: StandaloneNpcIdentity,
  ): StandaloneCharacterActor | undefined {
    const entity = surface.create_entity({
      name: 'character',
      position,
      force,
    })
    if (!entity) return undefined
    return new StandaloneCharacterActor(entity, identity)
  }

  static from_registered_entity(entity: LuaEntity, identity: StandaloneNpcIdentity): StandaloneCharacterActor | undefined {
    if (!entity.valid || entity.name !== 'character') return undefined
    return new StandaloneCharacterActor(entity, identity)
  }

  static reacquire(surface: LuaSurface): StandaloneCharacterActor | undefined {
    const unit_number = storage.standalone_character_unit_number
    if (unit_number === undefined) return undefined

    const entity = surface
      .find_entities_filtered({ name: 'character' })
      .find(candidate => candidate.unit_number === unit_number)

    if (!entity) return undefined

    return new StandaloneCharacterActor(entity, ensure_identity())
  }

  /**
   * Read-only lookup for UI and diagnostics. Unlike `reacquire` it never
   * allocates an identity, so it can run on every multiplayer peer without
   * writing `storage` or drawing from the synced map RNG.
   */
  static peek(surface: LuaSurface): StandaloneCharacterActor | undefined {
    const unit_number = storage.standalone_character_unit_number
    const identity = storage.standalone_npc_identity
    if (unit_number === undefined || identity === undefined) return undefined

    const entity = surface
      .find_entities_filtered({ name: 'character' })
      .find(candidate => candidate.unit_number === unit_number)

    if (!entity) return undefined

    return StandaloneCharacterActor.from_registered_entity(entity, identity)
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
    this.character_entity.update_selected_entity(position)
  }

  get_mining_state(): ActorMiningState {
    const state = this.character_entity.mining_state
    if (state.mining && !this.character_entity.selected) {
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
      if (item.recipe === recipe) count += item.count
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
      name: this.identity.name,
      npc_id: this.identity.id,
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
