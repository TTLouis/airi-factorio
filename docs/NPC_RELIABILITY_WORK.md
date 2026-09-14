# NPC reliability work: section 4

Working branch: `feat/npc-transition-work`.

This is the active continuation of `NPC_AGENT_HARNESS_PLAN.md` and the historical checkpoints in `NPC_AGENT_HARNESS_STATUS.md`. The user requested fixing the whole remaining single-NPC reliability scope first, without rushing a release. The user runs the tests. Do not merge to `main`, change the default actor mode, publish a release, or ship a Pterodactyl migration merely because one additional scenario passes.

## Latest user-reported checkpoint

The latest combined Docker run reports:

- real zero-player simulation continued at approximately 60 UPS;
- wait, movement, mining, native hand crafting, placement and both transfer directions passed;
- physical stop and cancellation semantics passed;
- native research completed through real labs while the NPC continued other work;
- bounded combat and its no-target/no-ammo/cancellation cases passed;
- an actively walking NPC plus queued work survived a real save/process restart as a world entity, while volatile Autorio work was deliberately discarded and serialized controls were reconciled;
- the restarted process reacquired the same `actor_id=1`, preserved force/inventory/world state, showed no post-load drift, and completed fresh work;
- killing that body invalidated stale active/queued work, created a different empty replacement `actor_id=18` on the same force, and the replacement completed fresh movement;
- zero connected players were maintained throughout;
- the runtime smoke completed successfully.

This closes the bounded research, combat, save/restart, and death-recovery gates at their stated scopes. It does not close repeatable/trigger research, general navigation, crafting ownership/cancellation, generalized cross-actor ownership, explicit outcome semantics, or end-to-end autonomous planning.

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

## Bounded death recovery — user verified

A missing persisted NPC is an ownership boundary, not permission to continue its old task on a replacement body.

The verified recovery behavior is:

1. detect that the persisted standalone `unit_number` no longer resolves to a live character;
2. invalidate active and queued Autorio work before creating a replacement;
3. perform that logical invalidation without resolving or controlling an actor, avoiding recursive replacement creation through cancellation cleanup;
4. clear stale path rendering at the ownership boundary;
5. create a new standalone character on the same force using normal spawn/non-colliding placement;
6. do **not** copy the dead character's inventory into the replacement (`inventory_policy: no_transfer`), preventing recovery duplication;
7. persist/expose a recovery receipt binding old/new actor IDs, force, tick, reason and inventory policy;
8. require the replacement to remain idle/stationary until fresh work is submitted.

The real engine gate killed the active `actor_id=1` while it was physically walking with a queued wait. The old work disappeared, the old target remained alive, a corpse was observed, replacement `actor_id=18` was created on the same force without copying deterministic marker inventory, the replacement did not drift, and fresh post-recovery movement completed at approximately 60 UPS.

## Current slice: bounded navigation reliability

Status: implemented for user testing; not yet engine-verified.

The historical `walk_to_entity` path had release blockers:

- `LuaSurface.request_path()` returned an asynchronous request ID, but Autorio discarded it;
- any later `on_script_path_request_finished` event could mutate whichever walking task happened to be active;
- a cancelled/replaced/timed-out request therefore had no stale-result protection;
- pathfinder failure switched to `WALKING_DIRECT`, which could blindly push the character into the obstacle that made pathfinding fail;
- path calculation had no timeout/retry bound;
- path following had no bounded no-progress detection/repath/failure;
- moving targets kept stale coordinates;
- an absent/unreachable target could become generic idle rather than an explicit failure receipt.

The new bounded navigation controller:

- validates movement search radius at 1..256 tiles and aligns the structured agent schema to the same limit;
- binds each navigation task to actor ID, actor kind and force index;
- binds one nearest matching entity rather than repeatedly retargeting;
- stores the exact `uint32` returned by `LuaSurface.request_path()` and accepts only the completion event with the matching `event.id`;
- ignores late/stale path results after retry, cancellation, replacement or other request supersession;
- treats `try_again_later` as a bounded delayed retry rather than completion;
- bounds path calculation waits, total navigation duration, path attempts and no-progress time;
- removes the old path-failure-to-blind-direct-walking fallback;
- repaths when the bound target materially moves;
- tracks actual character movement before refreshing its progress deadline;
- completes only when the character is within the controller's arrival distance of the current bound target;
- reports explicit results including `reached`, `no_target`, `target_gone`, `unreachable`, `path_busy`, `path_timeout`, `stuck`, `timeout`, and `actor_changed`;
- cancels dependent queued operations on navigation failure;
- exposes the bound target, current path request/attempt state, and last result through read-only `getNavigationStatus()` / `autorio_navigation.status`;
- teaches the agent that idle is not navigation success and that `reached` must be verified.

### Navigation acceptance gate

The combined Docker path now continues after the verified death-recovery stage using the replacement actor.

The real-engine gate has three cases:

1. **Obstacle route** — put a solid stone-wall barrier across the direct lane to a steel chest, while leaving open space around the wall. AIRI must use a real Factorio path to reach the exact chest and stop physically.
2. **Moving target** — start toward a wooden chest, wait until an actual path has been accepted, teleport that exact chest eight tiles off its old goal, then require at least one repath and arrival at the new coordinate without silent retargeting.
3. **Unreachable target** — put an iron chest on a landfill island inside a wide water moat, queue a dependent wait behind movement, and require explicit `unreachable`, an empty dependent queue, the target still alive, stopped controls, and no quiet-interval drift. This specifically rejects the old direct-walking fallback.

Deterministic controller tests also cover exact request-ID correlation, stale-result rejection, bounded pathfinder-busy retries, request timeout replacement, late old-result rejection, moving-target repath, stuck bounds, and arrival verification. The Python acceptance assertions reject idle-only false positives, wrong actor/target, active controls, connected humans, paused simulation, missing repath evidence, and unreachable results that leave dependent work queued.

Expected success line:

```text
PASS: zero-player NPC bounded navigation routed obstacles, repathed moving target, and failed unreachable target with actor_id=<replacement id>
```

The assistant has not executed this new build or real navigation gate. Do not treat navigation as proven until the user's Docker run reports it.

## Remaining section-4 work

| Workstream | Acceptance still required |
| --- | --- |
| Research follow-through | Interrupted/stalled research recovery through the real agent; gameplay-trigger and repeatable research scenarios; request/result correlation beyond one last-result record. |
| Combat | Bounded real combat gate is user-verified. Obstacle/unreachable navigation is now covered by the current navigation slice; broader combat/terrain interactions should consume navigation outcomes rather than invent separate success. |
| Save/restart | Real stop/restart gate is user-verified. Native crafting/research persistence interactions remain part of later ownership/follow-through work. |
| Death recovery | Real body-loss/replacement gate is user-verified. Additional recovery cases exposed by crafting or mode/force ownership should fail closed rather than inherit stale work. |
| Navigation | User-run bounded navigation gate above; after it passes, evaluate remaining reach/collision edge cases rather than preserving the old direct fallback. |
| Crafting and cancellation | Cancel owned native queue work correctly; preserve unrelated crafts; verify actual outputs rather than queue disappearance alone; partial queues, full inventory, unavailable recipes, quantities/quality. |
| Cross-actor ownership | Mode/force/body changes cannot carry arbitrary old operations or controls into another actor; human actions cannot satisfy an NPC task. Body loss and navigation ownership are covered, but mode/force transitions and remaining operations still need generalized ownership. |
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
- [LuaSurface request_path](https://lua-api.factorio.com/latest/classes/LuaSurface.html#request_path)
- [on_script_path_request_finished](https://lua-api.factorio.com/latest/events.html#on_script_path_request_finished)
