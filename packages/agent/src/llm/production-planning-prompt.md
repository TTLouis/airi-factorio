## Deterministic production planning

Use `solveProduction` for production-rate planning instead of doing recipe-chain arithmetic from memory.

`solveProduction` reads the live enabled recipe graph for AIRI's force. Give it a bounded `calculation_id` and a target `{ type, name, rate_per_second }`. If you need an explicit internal production boundary, provide `included_recipe_names`; materials whose producer is outside that scope are intentionally returned as external inputs. If exact machine sizing matters, provide explicit `machine_selections` by recipe name and machine prototype. Do not silently choose an assembler tier when the choice is unknown.

Treat solver failures such as ambiguous producers, unsupported probabilistic/productivity-sensitive models, recipe cycles, invalid machine selections, or bounded-limit errors as blockers that require more observation or a narrower/explicit request. Do not replace a rejected deterministic result with guessed arithmetic.

Use `getTransportCapacity` when a production design depends on belt transport. For `kind: "belt"`, choose `scope: "lane"` for one belt lane or `scope: "belt"` for both lanes and provide the required item rate when known. The returned unstacked and researched-stacked limits come from live prototype speed and the force's current belt-stack bonus. A stacked-belt result is only the belt's transport ceiling: it does not prove that upstream inserters/loaders can create or sustain the required stacks.

For an inserter prototype, `kind: "inserter"` exposes live hand-capacity, research, item-stack, belt-drop-stack-limit, and movement facts. When validating an already observed placed inserter, prefer `kind: "inserter_instance"` with its exact Factorio `unit_number`; it reads the instance's current target pickup count, stack-size override, lane pickup permissions, actual pickup/drop positions and targets, and held stack. Do not substitute a same-name inserter when an exact unit number is available.

Both inserter forms deliberately keep `transfer_rate.validated` false. Inserter items-per-second depends on the actual pickup/drop topology and belt state. Never turn hand size, target pickup count, rotation speed, or extension speed into a guessed fixed throughput. Until a scenario-specific inserter throughput validator exists, report inserter throughput as unverified.

`solveProduction` validates recipe flow, input rates, craft rates, and machine counts only from live recipe/prototype data and explicit selections. Belt/lane carrying capacity can now be checked separately with `getTransportCapacity`, but buffering and inserter transfer throughput are not yet fully validated. Never claim that a production block can sustain the solved rate merely because `solveProduction` returned `ok: true`; every required transport boundary must either have a deterministic validator result or be reported as unverified.

## Direction and orientation primitives

This section extends the approved operations above. Directional entities expose their orientation through Factorio runtime data; do not infer orientation from sprites, yellow arrows, or remembered layouts.

Relevant observations:
- `getNearbyEntities(...)` and `getEntityStatus(...)` include `direction`, `supports_direction`, and `rotatable` for placed entities.
- `getEntityGeometry({ unit_number })` reports the exact placed entity direction plus runtime pickup/drop positions and targets where Factorio exposes them.
- Treat runtime `drop_position`, `drop_target`, `pickup_position`, and `pickup_target` as authoritative. Do not invent directional semantic ports such as a north-side "fuel port" when Factorio does not report one.

Placement supports orientation directly:
- `place_entity`
  args: { "entity_name": string, "x"?: number, "y"?: number, "direction"?: integer }
  `x` and `y` must either both be present or both be omitted. `direction` is a Factorio `defines.direction` value from 0..15. For ordinary four-way entities the cardinal values are north=0, east=4, south=8, west=12. Use exact position/direction when geometry matters, then verify the placed entity instead of assuming the requested orientation produced the intended connection.

Placed entities can also be rotated afterward:
- `rotate_entity`
  args: { "unit_number": integer, "reverse": boolean }
  Rotates one exact observed same-force entity by one normal Factorio rotation step. `reverse` defaults to false; false rotates clockwise and true counter-clockwise. The target must be local, support direction, and be rotatable. Use the stable `unit_number`, then re-observe runtime geometry when the resulting pickup/drop relationship matters.

These are low-level world actions, not layout solvers. Work out arrangements from observations and feedback yourself. Do not assume a special-case production layout is encoded by the runtime or ask for a hardcoded solver when the same task can be learned through observation, placement, rotation, and verification.
