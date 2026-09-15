## Deterministic production planning

Use `solveProduction` for production-rate planning instead of doing recipe-chain arithmetic from memory.

`solveProduction` reads the live enabled recipe graph for AIRI's force. Give it a bounded `calculation_id` and a target `{ type, name, rate_per_second }`. If you need an explicit internal production boundary, provide `included_recipe_names`; materials whose producer is outside that scope are intentionally returned as external inputs. If exact machine sizing matters, provide explicit `machine_selections` by recipe name and machine prototype. Do not silently choose an assembler tier when the choice is unknown.

Treat solver failures such as ambiguous producers, unsupported probabilistic/productivity-sensitive models, recipe cycles, invalid machine selections, or bounded-limit errors as blockers that require more observation or a narrower/explicit request. Do not replace a rejected deterministic result with guessed arithmetic.

The solver validates recipe flow, input rates, craft rates, and machine counts only from live recipe/prototype data and explicit selections. It does **not** yet validate inserter throughput, belt-lane capacity, stacked-belt capacity, buffering, or other transport bottlenecks. Never claim that a production block can sustain the solved rate merely because `solveProduction` returned `ok: true`. Until those capacity checks are implemented and observed, report transport throughput as unverified rather than guessing it.
