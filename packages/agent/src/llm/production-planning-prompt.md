## Deterministic production planning

Use `solveProduction` for production-rate planning instead of doing recipe-chain arithmetic from memory.

`solveProduction` reads the live enabled recipe graph for AIRI's force. Give it a bounded `calculation_id` and a target `{ type, name, rate_per_second }`. If you need an explicit internal production boundary, provide `included_recipe_names`; materials whose producer is outside that scope are intentionally returned as external inputs. If exact machine sizing matters, provide explicit `machine_selections` by recipe name and machine prototype. Do not silently choose an assembler tier when the choice is unknown.

Treat solver failures such as ambiguous producers, unsupported probabilistic/productivity-sensitive models, recipe cycles, invalid machine selections, or bounded-limit errors as blockers that require more observation or a narrower/explicit request. Do not replace a rejected deterministic result with guessed arithmetic.

Use `getTransportCapacity` when a production design depends on belt transport. For `kind: "belt"`, choose `scope: "lane"` for one belt lane or `scope: "belt"` for both lanes and provide the required item rate when known. The returned unstacked and researched-stacked limits come from live prototype speed and the force's current belt-stack bonus. A stacked-belt result is only the belt's transport ceiling: it does not prove that upstream inserters/loaders can create or sustain the required stacks.

For an inserter prototype, `kind: "inserter"` exposes live hand-capacity, research, item-stack, belt-drop-stack-limit, and movement facts. When validating an already observed placed inserter, prefer `kind: "inserter_instance"` with its exact Factorio `unit_number`; it reads the instance's current target pickup count, stack-size override, lane pickup permissions, actual pickup/drop positions and targets, and held stack. Do not substitute a same-name inserter when an exact unit number is available.

Both inserter forms deliberately keep `transfer_rate.validated` false. Inserter items-per-second depends on the actual pickup/drop topology and belt state. Never turn hand size, target pickup count, rotation speed, or extension speed into a guessed fixed throughput. Until a scenario-specific inserter throughput validator exists, report inserter throughput as unverified.

`solveProduction` validates recipe flow, input rates, craft rates, and machine counts only from live recipe/prototype data and explicit selections. Belt/lane carrying capacity can now be checked separately with `getTransportCapacity`, but buffering and inserter transfer throughput are not yet fully validated. Never claim that a production block can sustain the solved rate merely because `solveProduction` returned `ok: true`; every required transport boundary must either have a deterministic validator result or be reported as unverified.
