# NPC reliability work: section 4

Working branch: `feat/npc-transition-work`.

This is the active continuation of `NPC_AGENT_HARNESS_PLAN.md` and the historical checkpoints in `NPC_AGENT_HARNESS_STATUS.md`. The user requested fixing the whole remaining single-NPC reliability scope first, without rushing a release. The user runs the tests. Do not merge to `main`, change the default actor mode, publish a release, or ship a Pterodactyl migration merely because one additional scenario passes.

## Latest user-reported checkpoint

The latest combined Docker run reports:

- all deterministic Python runner regressions passed;
- real zero-player simulation continued at approximately 60 UPS;
- wait, movement, mining, native hand crafting, placement and both transfer directions passed;
- physical stop, queued wait, and movement/mining cancellation passed;
- native research completed through real labs while the NPC continued other work;
- bounded combat destroyed the exact bound small-biter with real character weapon behavior;
- combat no-target, no-ammo, dependent-queue cancellation, and approach-cancellation checks passed;
- an active movement plus queued wait was saved, the first Factorio server process stopped, and a second process loaded the same save;
- the restarted process reacquired the same `actor_id=1`, preserved force/inventory/world state, discarded volatile Autorio work, cleared serialized physical controls, showed no drift, and completed fresh movement;
- zero connected players were maintained throughout;
- the runtime script completed successfully.

This closes the bounded research, combat, and save/restart gates at their stated scope. It does not close repeatable/trigger research, death recovery, general navigation, crafting ownership/cancellation, cross-actor ownership, explicit outcome semantics, or end-to-end autonomous planning.

## Research request semantics — user-verified bounded gate

`research_technology` enters NPC task order. Admission acknowledges the NPC request, not Factorio acceptance or technology completion. Execution revalidates the technology and requesting actor/force before calling `LuaForce.add_research`.

Research is asynchronous force-wide work. The NPC is released after submission and can keep working while labs run. Unknown/disabled technologies, disabled force research, missing prerequisites, gameplay-trigger technology, and conflicting force research are rejected. Existing different research is never replaced. Duplicate active/queued work is not duplicated; already researched technology is idempotent. Deferred requests bind to actor ID, actor kind and force index. `getResearchStatus()` and `getTechnology({ name })` distinguish request/submission state from native completion.

The user-verified gate supplied prerequisites, labs, power and exact science as a bounded fixture. It proves native research behavior, not autonomous bootstrap.

## Bounded real combat — user verified

The bounded combat controller binds combat to actor/force identity and one target, uses the selected weapon's real `can_shoot` result, stops walking before firing, limits no-progress/total duration, reports explicit failure codes, cancels dependent queued work on failure, and completes only after the bound target is actually gone. Production setup no longer deletes enemies.

The real-engine gate verified target destruction, real ammunition consumption (including rounds from a partially used magazine), stable NPC identity, no-target failure, no-ammo failure without target damage, dependent-queue cancellation, and stopping an out-of-range approach without drift or target damage.

## Real save/restart persistence — user verified

Factorio persists the standalone character entity and `storage`, while ordinary Lua module locals are rebuilt when a save loads. Autorio's current task manager is module-local, so logical active/queued operations are intentionally not resumed across a load boundary. The character entity's walking/mining/shooting states are engine state and can survive in the save.

The verified persistence policy is fail-safe:

1. persist/reacquire the same standalone character via its stored unit number;
2. discard Autorio logical active/queued operations on load rather than pretending they resumed safely;
3. `script.on_load` only marks local reconciliation work; it does not access `game` or mutate `storage`;
4. on the first normal NPC resolution, stop walking, mining and shooting and clear stale path rendering;
5. expose the reconciliation policy/result through `autorio_actor.status`;
6. do not implicitly cancel/rewrite separate force-wide or native engine work here; crafting ownership and research follow-through remain separate workstreams.

The real gate saved an actively walking NPC with queued work, stopped the first Factorio server process, started a second process from that save, reacquired the same `actor_id=1`, preserved the expected inventory/force/target, observed an idle empty Autorio queue with released controls and no quiet-interval drift, then completed a fresh movement task on the same body.

## Current slice: bounded death recovery

Status: implemented for user testing; not yet engine-verified.

The pre-existing actor resolver could recreate a standalone character after the cached/persisted body disappeared, but there was no ownership boundary between the dead body and the replacement. An active or queued Autorio task could therefore continue against the replacement body. That is unsafe even when the operation later fails, because the replacement did not own the old task or its physical intent.

The death-recovery policy for this slice is:

1. detect that the persisted standalone `unit_number` no longer resolves to a live character;
2. invalidate all active/queued Autorio work before creating the replacement;
3. logical invalidation must not resolve or control an actor, avoiding recursive replacement creation through normal cancellation cleanup;
4. clear stale path rendering at the ownership boundary;
5. create a new standalone character on the same force using the normal spawn/non-colliding placement path;
6. do **not** copy the dead character's inventory into the replacement (`inventory_policy: no_transfer`), so recovery cannot duplicate inventory;
7. persist a bounded recovery receipt containing old actor ID, replacement actor ID, force, tick, reason and inventory policy;
8. expose that receipt through `autorio_actor.status().death_recovery`;
9. require the replacement to remain idle/stationary until fresh work is submitted.

### Death-recovery acceptance gate

The combined Docker path now continues after the verified restart stage. The fixture gives the active NPC deterministic marker inventory, starts real movement toward a unique target, queues a wait behind it, proves the old body is physically walking, then calls the engine's normal `LuaEntity.die()` path. `die()` is used rather than `destroy()` so Factorio executes entity-death behavior and produces a corpse.

The gate requires:

- the old body is actually dead/invalid and a character corpse exists;
- a different standalone character ID is created on the same force;
- zero human players remain connected;
- stale active and queued Autorio work is gone;
- the replacement is not walking, mining, or shooting and does not drift over a quiet interval;
- the old movement target remains alive, proving recovery did not reinterpret task completion;
- deterministic marker items are **not** copied into the replacement inventory;
- the recovery receipt binds the exact old/new actor IDs and records `inventory_policy: no_transfer`;
- exactly one live standalone character remains;
- fresh movement submitted after recovery completes successfully on the replacement body.

Expected success line:

```text
PASS: zero-player NPC death recovery invalidated stale work and created replacement old_actor_id=1, replacement_actor_id=<new id>
```

The assistant has not executed this new TypeScript/build/Factorio death gate. Do not treat death recovery as proven until the user's Docker run reports it.

## Remaining section-4 work

| Workstream | Acceptance still required |
| --- | --- |
| Research follow-through | Interrupted/stalled research recovery through the real agent; gameplay-trigger and repeatable research scenarios; request/result correlation beyond one last-result record. |
| Combat | Bounded real combat gate is user-verified. Obstacle/unreachable and moving-target edge behavior belongs with navigation work. |
| Save/restart | Real stop/restart gate is user-verified. Native crafting/research persistence interactions remain part of later ownership/follow-through work. |
| Death recovery | User-run gate above; then integrate any recovery edge cases exposed by navigation/crafting ownership rather than silently carrying old work. |
| Navigation | Correlate path request IDs; ignore stale path results after cancellation/replacement; proper collision/reach checks; bounded stuck detection/repath/failure; obstacles/water/unreachable/moving targets. |
| Crafting and cancellation | Cancel owned native queue work correctly; preserve unrelated crafts; verify actual outputs rather than queue disappearance alone; partial queues, full inventory, unavailable recipes, quantities/quality. |
| Cross-actor ownership | Mode/force/body changes cannot carry arbitrary old operations or controls into another actor; human actions cannot satisfy an NPC task. Body-loss invalidation is now covered, but mode/force transitions and the remaining operations still need generalized ownership. |
| Outcome semantics | Explicit success/failure for all operation types; no generic "completed" on silent failure; stop dependent batches appropriately, including immediate rejection during submission. |
| End-to-end agent | Durable operational goal/step state, bounded runtime context, real prompt/tool/executor/Factorio loop with scripted model boundary, missing-material and changed-world recovery, verification before advancing, bounded provider/tool retries. |

Work in reviewable slices and keep previously passing scenarios in every combined run. Swarm/message-board execution remains out of scope until the single NPC is reliable. The swarm architecture document is planning material only and does not change this release gate.

## Later main and Pterodactyl migration (blocked)

The user requested a coordinated main/NPC/deployment update only after the single-NPC work is genuinely ready. The later deployment candidate must update installer source, generated installer payload, egg installation script, environment variables, startup/runtime behavior and deployment documentation together. Test clean install and update of an existing save/configuration; preserve backups and rollback. Separate chat authorization from NPC ownership; do not require a connected human or hard-coded player index.

No `main` merge, release/tag, default-NPC flip, or Pterodactyl installer/egg change is included in these reliability slices.

## API references

- [LuaForce 2.0.77](https://lua-api.factorio.com/2.0.77/classes/LuaForce.html)
- [LuaTechnology 2.0.77](https://lua-api.factorio.com/2.0.77/classes/LuaTechnology.html)
- [LuaEntity 2.0.77](https://lua-api.factorio.com/2.0.77/classes/LuaEntity.html)
- [LuaBootstrap 2.0.77 on_load](https://lua-api.factorio.com/2.0.77/classes/LuaBootstrap.html)
- [LuaGameScript 2.0.77 server_save](https://lua-api.factorio.com/2.0.77/classes/LuaGameScript.html)
