import type { LuaPlayer } from 'factorio:runtime'
import type { ActorEntityBuildArgs, ActorMiningState, ActorShootingState, ActorStatusSnapshot, ActorWalkingState, ControlledActor } from './types'

/**
 * Wraps a connected LuaPlayer behind the ControlledActor interface,
 * reproducing today's single-player control behavior while the NPC path is
 * being introduced.
 */
export class ConnectedPlayerActor implements ControlledActor {
  constructor(private readonly player: LuaPlayer) {}

  get is_valid(): boolean {
    return this.player.valid
  }

  get character() {
    return this.player.character
  }

  get surface() {
    return this.player.surface
  }

  get force() {
    return this.player.force
  }

  get position() {
    return this.player.position
  }

  get_main_inventory() {
    return this.player.get_main_inventory()
  }

  update_selected_entity(position: Parameters<ControlledActor['update_selected_entity']>[0]) {
    this.player.update_selected_entity(position)
  }

  get_mining_state(): ActorMiningState {
    return this.player.mining_state
  }

  set_mining_state(state: ActorMiningState) {
    this.player.mining_state = state
  }

  set_walking_state(state: ActorWalkingState) {
    this.player.walking_state = state
  }

  set_shooting_state(state: ActorShootingState) {
    this.player.shooting_state = state
  }

  begin_crafting(params: { count: number, recipe: string }) {
    this.player.begin_crafting(params)
  }

  owns_player_index(player_index: number): boolean {
    return this.player.index === player_index
  }

  entity_build_args(): ActorEntityBuildArgs {
    return {
      force: this.player.force,
      player: this.player,
    }
  }

  status_snapshot(): ActorStatusSnapshot {
    return {
      kind: 'connected_player',
      valid: this.player.valid,
      name: this.player.name,
      position: this.player.position,
      has_character: this.player.character !== undefined,
      actor_id: this.player.index,
    }
  }
}
