// Minimal stand-ins for the Factorio/Lua globals that control.ts touches at module
// load time (remote.add_interface, script.on_event registration, the closing log()
// call) plus the Lua `math` stdlib used by pure logic like get_direction. This lets
// vitest import control.ts under Node without a real Factorio runtime; it does not
// attempt to emulate game state.
(globalThis as any).log = () => {}

;(globalThis as any).remote = {
  add_interface: () => {},
}

;(globalThis as any).script = {
  on_event: () => {},
}

;(globalThis as any).defines = {
  events: {},
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
