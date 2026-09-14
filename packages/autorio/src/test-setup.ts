import { event_handlers, set_load_handler } from './test-event-registry'

// Minimal stand-ins for the Factorio/Lua globals that control.ts touches at module
// load time (remote.add_interface, script lifecycle registration, the closing log()
// call) plus the Lua `math` stdlib used by pure logic like get_direction. This lets
// vitest import production modules under Node without a real Factorio runtime; it
// does not attempt to emulate game state.
(globalThis as any).log = () => {}

;(globalThis as any).remote = {
  add_interface: () => {},
}

;(globalThis as any).script = {
  on_event: (event_key: unknown, handler: (event: any) => void) => {
    event_handlers.set(event_key, handler)
  },
  on_load: (handler: (() => void) | undefined) => {
    set_load_handler(handler)
  },
}

;(globalThis as any).game = {
  connected_players: [],
  surfaces: {
    1: { find_entities_filtered: () => [] },
  },
  print: () => {},
  tick: 0,
}

;(globalThis as any).rendering = {
  clear: () => {},
  draw_line: () => {},
}

;(globalThis as any).serpent = {
  line: (value: unknown) => String(value),
  block: (value: unknown) => String(value),
}

// Factorio 2.0's per-save persistence table. Real shape is declared locally
// by whichever file uses it (see standalone_character_actor.ts); tests just
// need the binding to exist so `storage.foo` doesn't throw ReferenceError.
;(globalThis as any).storage = {}

;(globalThis as any).defines = {
  events: {
    on_selected_entity_changed: 'on_selected_entity_changed',
    on_script_path_request_finished: 'on_script_path_request_finished',
    on_player_mined_entity: 'on_player_mined_entity',
    on_tick: 'on_tick',
    on_player_crafted_item: 'on_player_crafted_item',
    on_research_finished: 'on_research_finished',
  },
  direction: {
    north: 'north',
    northeast: 'northeast',
    east: 'east',
    southeast: 'southeast',
    south: 'south',
    southwest: 'southwest',
    west: 'west',
    northwest: 'northwest',
  },
  shooting: {
    not_shooting: 'not_shooting',
    shooting_enemies: 'shooting_enemies',
    shooting_selected: 'shooting_selected',
  },
  inventory: {
    character_guns: 'character_guns',
    character_ammo: 'character_ammo',
  },
}

;(globalThis as any).math = {
  sqrt: Math.sqrt,
  pow: Math.pow,
  atan2: Math.atan2,
  pi: Math.PI,
  huge: Number.POSITIVE_INFINITY,
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
}
