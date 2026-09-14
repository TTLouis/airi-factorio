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
