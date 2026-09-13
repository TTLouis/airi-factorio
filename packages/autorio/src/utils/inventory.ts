import type { ControlledActor } from '../actors/types'

export interface InventoryItem {
  name: string
  count: number
}

export function get_actor_inventory_items(actor: ControlledActor): InventoryItem[] {
  const main_inventory = actor.get_main_inventory()
  if (!main_inventory) {
    return []
  }

  return main_inventory.get_contents().map(({ name, count }) => ({ name, count }))
}

/**
 * Legacy player-indexed adapter retained while player mode remains available.
 * NPC-capable call sites should use get_actor_inventory_items instead.
 */
export function get_inventory_items(player_id: number): InventoryItem[] {
  log(`[AUTORIO] Getting inventory items for player: ${player_id}`)

  const player = game.connected_players[player_id - 1]
  if (!player) {
    return []
  }

  return get_actor_inventory_items({
    get_main_inventory: () => player.get_main_inventory(),
  } as ControlledActor)
}
