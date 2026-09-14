import type { MapPositionStruct } from 'factorio:prototype'

/**
 * Resolve a world-space vector to Factorio's eight walking directions.
 * Factorio map coordinates increase southward on +y, so atan2(dy, dx)
 * naturally orders the octants east -> southeast -> south -> ... .
 *
 * The previous formula used `start.x - end.x` and did not normalize the
 * +/-pi boundary, causing a target exactly due east to resolve southeast.
 */
export function direction_towards(start: MapPositionStruct, target: MapPositionStruct) {
  const dx = target.x - start.x
  const dy = target.y - start.y

  if (dx === 0 && dy === 0) {
    // Callers normally stop before asking for a direction at zero distance.
    // Returning a stable value avoids undefined boundary behavior.
    return defines.direction.north
  }

  const angle = math.atan2(dy, dx)
  const sector = math.floor((angle + math.pi / 8) / (math.pi / 4))

  if (sector <= -4 || sector >= 4) return defines.direction.west
  if (sector === -3) return defines.direction.northwest
  if (sector === -2) return defines.direction.north
  if (sector === -1) return defines.direction.northeast
  if (sector === 0) return defines.direction.east
  if (sector === 1) return defines.direction.southeast
  if (sector === 2) return defines.direction.south
  return defines.direction.southwest
}
