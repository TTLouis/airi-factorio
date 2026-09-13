import { create_actor_remote_interface, get_controlled_actor } from './actors/actor_controller'
import { get_actor_inventory_items } from './utils/inventory'

export function create_tools_remote_interface() {
  create_actor_remote_interface()

  remote.add_interface('autorio_tools', {
    get_inventory_items: () => {
      const actor = get_controlled_actor()
      if (!actor) {
        rcon.print('no controlled actor')
        return false
      }

      rcon.print(serpent.block(get_actor_inventory_items(actor)))
      return true
    },
    get_recipe: (item_name: string) => {
      const actor = get_controlled_actor()
      if (!actor) {
        rcon.print('no controlled actor')
        return false
      }

      const recipe = actor.force.recipes[item_name]
      if (!recipe) {
        rcon.print('no such recipe')
        return false
      }

      if (!recipe.enabled) {
        rcon.print('recipe locked')
        return false
      }

      const ingredients = recipe.ingredients.map((ingredient) => {
        return {
          name: ingredient.name,
          count: ingredient.amount,
        }
      })

      rcon.print(serpent.block(ingredients))
      return true
    },
  })
}
