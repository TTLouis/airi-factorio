# NPC reliability work: section 4

Working branch: `feat/npc-transition-work`.

This is the active continuation of `NPC_AGENT_HARNESS_PLAN.md` and the historical checkpoints in `NPC_AGENT_HARNESS_STATUS.md`. The user requested fixing the whole remaining single-NPC reliability scope first, without rushing a release. The user runs the tests. Do not merge to `main`, change the default actor mode, publish a release, or ship a Pterodactyl migration merely because one additional scenario passes.

## Latest user-reported checkpoint

The latest combined Docker run reports:

- all 37 deterministic Python runner regressions passed;
- real zero-player simulation continued at approximately 60 UPS;
- wait, movement, mining, native hand crafting, placement and both transfer directions passed;
- physical stop, queued wait, and movement/mining cancellation passed;
- native research completed through real labs while the NPC continued other work;
- bounded combat destroyed the exact bound small-biter with real character weapon behavior;
- combat no-target, no-ammo, dependent-queue cancellation, and approach-cancellation checks passed;
- the full run retained `actor_id=1` and zero connected players;
- the runtime script completed successfully.

This closes the bounded research and combat gates at their stated scope. It does not close repeatable/trigger research, persistence, death recovery, general navigation, crafting ownership/cancellation, cross-actor ownership, explicit outcome semantics, or end-to-end autonomous planning.

## Research request semantics — user-verified bounded gate

`research_technology` enters NPC task order. Admission acknowledges the NPC request, not Factorio acceptance or technology completion. Execution revalidates the technology and requesting actor/force before calling `LuaForce.add_research`.

Research is asynchronous force-wide work. The NPC is released after submission and can keep working while labs run. Unknown/disabled technologies, disabled force research, missing prerequisites, gameplay-trigger technology, and conflicting force research are rejected. Existing different research is never replaced. Duplicate active/queued work is not duplicated; already researched technology is idempotent. Deferred requests bind to actor ID, actor kind and force index. `getResearchStatus()` and `getTechnology({ name })` distinguish request/submission state from native completion.

The user-verified gate supplied prerequisites, labs, power and exact science as a bounded fixture. It proves native research behavior, not autonomous bootstrap.

## Bounded real combat — user verified

The bounded combat controller now binds combat to actor/force identity and one target, uses the selected weapon's real `can_shoot` result, stops walking before firing, limits no-progress/total duration, reports explicit failure codes, cancels dependent queued work on failure, and completes only after the bound target is actually gone. Production setup no longer deletes enemies.

The real-engine gate verified target destruction, real ammunition consumption (including rounds from a partially used magazine), stable NPC identity, no-target failure, no-ammo failure without target damage, dependent-queue cancellation, and stopping an out-of-range approach without drift or target damage.

## Current slice: real save/restart persistence

Status: implemented for user testing; not yet engine-verified.

Factorio persists the standalone character entity and `storage`, while ordinary Lua module locals are rebuilt when a save loads. Autorio's current task manager is module-local, so logical active/queued operations are intentionally not resumed across a load boundary. The character entity's walking/mining/shooting states are engine state and can survive in the save. Without reconciliation, a freshly loaded NPC could therefore continue a physical action after the logical task that owned it disappeared.

The persistence policy for this slice is explicit and fail-safe:

1. persist/reacquire the same standalone character via its stored unit number;
2. discard Autorio logical active/queued operations on load rather than pretending they resumed safely;
3. `script.on_load` only marks local reconciliation work; it does not access `game` or mutate `storage`;
4. on the first normal NPC resolution, stop walking, mining and shooting and clear stale path rendering;
5. expose the reconciliation policy/result through `autorio_actor.status`;
6. do not implicitly cancel/rewrite separate force-wide or native engine work here; crafting ownership and research follow-through remain separate workstreams.

### Save/restart acceptance gate

The Docker path now continues after combat by creating a deterministic persisted inventory marker and unique steel-chest target, starting movement with queued work, forcing a real server save, stopping the first Factorio process, and starting a second process from the same save.

The restarted process must prove:

- the same actor unit number, force and deterministic inventory marker;
- zero connected players;
- idle/empty Autorio task state;
- stopped walking/mining/shooting and completed load reconciliation;
- no position drift over a quiet interval;
- the persisted target still exists;
- the same reacquired NPC can complete a fresh movement task after restart.

Expected success line:

```text
PASS: zero-player NPC save/restart reacquired same body and cleared stale controls with actor_id=1
```

The assistant has not executed this new build or real restart gate. Do not treat persistence as proven until the user's Docker run reports it.

## Remaining section-4 work

| Workstream | Acceptance still required |
| --- | --- |
| Research follow-through | Interrupted/stalled research recovery through the real agent; gameplay-trigger and repeatable research scenarios; request/result correlation beyond one last-result record. |
| Combat | Bounded real combat gate is user-verified. Obstacle/unreachable and moving-target edge behavior belongs with navigation work. |
| Save/restart | User-run real stop/restart gate above; then resolve native crafting/research persistence interactions exposed by later ownership work. |
| Death recovery | Detect invalid body, invalidate stale work, create/reacquire replacement deliberately, do not duplicate inventory, then complete a post-recovery task. |
| Navigation | Correlate path request IDs; ignore stale path results after cancellation/replacement; proper collision/reach checks; bounded stuck detection/repath/failure; obstacles/water/unreachable/moving targets. |
| Crafting and cancellation | Cancel owned native queue work correctly; preserve unrelated crafts; verify actual outputs rather than queue disappearance alone; partial queues, full inventory, unavailable recipes, quantities/quality. |
| Cross-actor ownership | Mode/force/body changes cannot carry arbitrary old operations or controls into another actor; human actions cannot satisfy an NPC task. Research/combat binding alone does not fix other operations. |
| Outcome semantics | Explicit success/failure for all operation types; no generic "completed" on silent failure; stop dependent batches appropriately, including immediate rejection during submission. |
| End-to-end agent | Durable operational goal/step state, bounded runtime context, real prompt/tool/executor/Factorio loop with scripted model boundary, missing-material and changed-world recovery, verification before advancing, bounded provider/tool retries. |

Work in reviewable slices and keep previously passing scenarios in every combined run. Swarm/message-board execution remains out of scope until the single NPC is reliable. The new swarm architecture document is planning material only and does not change this release gate.

## Later main and Pterodactyl migration (blocked)

The user requested a coordinated main/NPC/deployment update only after the single-NPC work is genuinely ready. The later deployment candidate must update installer source, generated installer payload, egg installation script, environment variables, startup/runtime behavior and deployment documentation together. Test clean install and update of an existing save/configuration; preserve backups and rollback. Separate chat authorization from NPC ownership; do not require a connected human or hard-coded player index.

No `main` merge, release/tag, default-NPC flip, or Pterodactyl installer/egg change is included in these reliability slices.

## API references

- [LuaForce 2.0.77](https://lua-api.factorio.com/2.0.77/classes/LuaForce.html)
- [LuaTechnology 2.0.77](https://lua-api.factorio.com/2.0.77/classes/LuaTechnology.html)
- [LuaEntity 2.0.77](https://lua-api.factorio.com/2.0.77/classes/LuaEntity.html)
- [LuaBootstrap 2.0.77 on_load](https://lua-api.factorio.com/2.0.77/classes/LuaBootstrap.html)
- [LuaGameScript 2.0.77 server_save](https://lua-api.factorio.com/2.0.77/classes/LuaGameScript.html)
