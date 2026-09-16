Temporary implementation contract for the precise navigation work in this branch. The runtime implementation follows in the next commit.

- walk_to_entity(name, radius): nearest matching entity convenience.
- walk_to_entity_exact(unit_number, reach_distance): stable exact entity target.
- walk_to_position(x, y, reach_distance): pathfind to a world coordinate without binding to an entity.
- All three share the existing bounded pathfinder, stuck detection, recovery, and natural-obstacle policy.
- Precise movement primitives do not select a resource patch, layout, or best destination for the model.
