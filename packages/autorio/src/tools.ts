import { create_actor_remote_interface, get_controlled_actor } from './actors/actor_controller'
import { get_actor_inventory_items } from './utils/inventory'

const MAX_NEARBY_RADIUS = 64
const MAX_NEARBY_RESULTS = 100

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
    get_nearby_entities: (radius: number = 20, name?: string, entity_type?: string, limit: number = 50) => {
      const actor = get_controlled_actor()
      if (!actor) {
        return {
          entities: [],
          truncated: false,
          error: 'no controlled actor',
        }
      }

      const bounded_radius = math.max(1, math.min(MAX_NEARBY_RADIUS, radius || 20))
      const bounded_limit = math.max(1, math.min(MAX_NEARBY_RESULTS, limit || 50))
      const filters: Record<string, unknown> = {
        position: actor.position,
        radius: bounded_radius,
      }
      if (name) {
        filters.name = name
      }
      if (entity_type) {
        filters.type = entity_type
      }

      const matches = actor.surface.find_entities_filtered(filters as any)
      const entities: Array<Record<string, unknown>> = []
      const returned = math.min(matches.length, bounded_limit)
      for (let i = 0; i < returned; i++) {
        const entity = matches[i]
        entities.push({
          name: entity.name,
          type: entity.type,
          position: entity.position,
          force: entity.force?.name,
          unit_number: entity.unit_number,
          amount: entity.type === 'resource' ? entity.amount : undefined,
        })
      }

      return {
        actor_position: actor.position,
        radius: bounded_radius,
        entities,
        matched_count: matches.length,
        returned_count: entities.length,
        truncated: matches.length > entities.length,
      }
    },
  })
}
