import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, PathfinderWaypoint } from 'factorio:runtime'

export enum TaskStates {
  IDLE = 'idle',
  WALKING_TO_ENTITY = 'walking_to_entity',
  MINING = 'mining',
  PLACING = 'placing',
  PLACING_IN_CHEST = 'placing_in_chest',
  PICKING_UP = 'picking_up',
  CRAFTING = 'crafting',
  RESEARCHING = 'researching',
  WALKING_DIRECT = 'walking_direct',
  MOVING_ITEMS = 'moving_items',
  ATTACKING = 'attacking',
  WAITING = 'waiting',
}

export interface PlayerParametersWalkToEntity {
  type: TaskStates.WALKING_TO_ENTITY
  entity_name: string
  search_radius: number
  /** When set, navigation binds this exact connected player's character instead
   * of searching for a generic character prototype. */
  target_player_name?: string
  path: PathfinderWaypoint[] | null
  path_drawn: boolean
  path_index: number
  calculating_path: boolean
  target_position: MapPositionStruct | null
  target?: LuaEntity | null
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  target_unit_number?: number
  path_request_id?: number
  path_requested_tick?: number
  path_attempts?: number
  next_retry_tick?: number
  started_tick?: number
  last_progress_tick?: number
  /** Best observed distance to the current waypoint. Environmental motion such
   * as transport belts must not count as progress unless it actually reduces
   * this distance. */
  last_waypoint_distance?: number
}

export interface PlayerParametersWalkingDirect {
  type: TaskStates.WALKING_DIRECT
  target_position: MapPositionStruct | null
}

export interface PlayerParametersMineEntity {
  type: TaskStates.MINING
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  entity_name: string
  /** Remaining mining cycles requested by the operation. */
  count: number
  /** Original requested cycle count, retained while count is decremented. */
  requested_count?: number
  /** Current target position while a mining cycle is active. */
  position?: MapPositionStruct
  /** Resource amount seen on the previous tick for standalone-NPC polling. */
  last_target_amount?: number
}

export interface PlayerParametersPlaceEntity {
  type: TaskStates.PLACING
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  entity_name: string
  /** Exact requested placement position. When omitted the runtime finds a local valid position. */
  position?: MapPositionStruct
  /** Factorio direction value (0..15) for precise placement. */
  direction?: number
}

export interface PlayerParametersMoveItems {
  type: TaskStates.MOVING_ITEMS
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  item_name: string
  /** Entity prototype target for legacy nearby entity transfers. */
  entity_name?: string
  /** Stable Factorio entity identity for an exact entity transfer. */
  target_unit_number?: number
  /** Exact connected player target for player transfers. */
  player_name?: string
  max_count: number
  to_entity?: boolean
  to_player?: boolean
}

export interface PlayerParametersCraftItem {
  type: TaskStates.CRAFTING
  item_name: string
  count: number
  crafted: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  started?: number
  started_tick?: number
  output_count_before?: number
  expected_output_delta?: number
  owns_native_queue?: boolean
}

export interface PlayerParametersAttackNearestEnemy {
  type: TaskStates.ATTACKING
  search_radius: number
  /** One-shot preserves the original behavior; clear_area keeps reacquiring
   * enemies until the bounded origin area is clear. */
  combat_mode?: 'single' | 'clear_area'
  origin_position?: MapPositionStruct
  target: LuaEntity | null
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  target_name?: string
  target_unit_number?: number
  target_initial_health?: number
  started_tick?: number
  last_progress_tick?: number
  last_distance?: number
  targets_destroyed?: number
  turrets_placed?: number
  last_turret_position?: MapPositionStruct
  last_turret_unit_number?: number
  turret_ammo_name?: string
  last_turret_ammo_loaded?: number
}

export interface PlayerParametersResearchTechnology {
  type: TaskStates.RESEARCHING
  technology_name: string
  /** Monotonic Autorio request identifier used to correlate asynchronous native research. */
  request_id?: number
  /** Technology level observed when the request was admitted. Repeatable technologies
   * are complete only after a later native completion advances beyond this level. */
  requested_level?: number
  /** Bind deferred research submission to the requesting actor and force. */
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
}

export interface PlayerParametersWaiting {
  type: TaskStates.WAITING
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  remaining_ticks: number
  requested_ticks?: number
}

export type PlayerParameters
  = | PlayerParametersWalkToEntity
    | PlayerParametersWalkingDirect
    | PlayerParametersMineEntity
    | PlayerParametersPlaceEntity
    | PlayerParametersMoveItems
    | PlayerParametersCraftItem
    | PlayerParametersAttackNearestEnemy
    | PlayerParametersResearchTechnology
    | PlayerParametersWaiting

export interface PlayerState {
  task_state: TaskStates
  parameters_walk_to_entity?: PlayerParametersWalkToEntity
  parameters_walking_direct?: PlayerParametersWalkingDirect
  parameters_mine_entity?: PlayerParametersMineEntity
  parameters_place_entity?: PlayerParametersPlaceEntity
  parameters_move_items?: PlayerParametersMoveItems
  parameters_craft_item?: PlayerParametersCraftItem
  parameters_attack_nearest_enemy?: PlayerParametersAttackNearestEnemy
  parameters_research_technology?: PlayerParametersResearchTechnology
  parameters_waiting?: PlayerParametersWaiting
}
