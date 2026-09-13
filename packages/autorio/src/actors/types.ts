import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, LuaForce, LuaInventory, LuaPlayer, LuaSurface } from 'factorio:runtime'

export type ActorMiningState = LuaPlayer['mining_state']
export type ActorWalkingState = LuaPlayer['walking_state']

/**
 * Arguments to spread into `LuaSurface.create_entity` so a placed entity is
 * attributed to this actor's identity rather than to whichever LuaPlayer
 * happened to be passed around.
 */
export interface ActorEntityBuildArgs {
  force: LuaForce
  player?: LuaPlayer
}

export interface ActorStatusSnapshot {
  kind: string
  valid: boolean
  name: string
  position: MapPositionStruct
  has_character: boolean
}

/**
 * The physical actor AIRI's control logic drives. `ConnectedPlayerActor`
 * wraps today's single connected LuaPlayer unchanged; a future
 * StandaloneCharacterActor will wrap an owned `character` entity with no
 * LuaPlayer behind it at all. Nothing in control.ts should depend on
 * LuaPlayer once migrated onto this interface.
 */
export interface ControlledActor {
  readonly is_valid: boolean
  readonly character: LuaEntity | undefined
  readonly surface: LuaSurface
  readonly force: LuaForce
  readonly position: MapPositionStruct

  get_main_inventory: () => LuaInventory | undefined
  update_selected_entity: (position: MapPositionStruct) => void

  get_mining_state: () => ActorMiningState
  set_mining_state: (state: ActorMiningState) => void

  set_walking_state: (state: ActorWalkingState) => void

  begin_crafting: (params: { count: number, recipe: string }) => void

  entity_build_args: () => ActorEntityBuildArgs

  status_snapshot: () => ActorStatusSnapshot
}
