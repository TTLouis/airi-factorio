# NPC reliability work: section 4

Working branch: `feat/npc-transition-work`.

This is the active continuation of `NPC_AGENT_HARNESS_PLAN.md` and the historical
checkpoints in `NPC_AGENT_HARNESS_STATUS.md`. The user requested fixing the whole
remaining single-NPC reliability scope first, without rushing a release. The user
runs the tests. Do not merge to `main`, change the default actor mode, publish a
release, or ship a Pterodactyl migration merely because one additional scenario
passes.

## Latest user-reported checkpoint

The latest combined Docker run reports:

- all 31 deterministic Python runner regressions passed;
- real zero-player simulation advanced 121 ticks in 2.02 seconds at approximately 60 UPS;
- wait, movement, mining, native hand crafting, placement and both transfer directions passed;
- physical stop, queued wait, and movement/mining cancellation passed;
- research request ordering/rejection/idempotency checks passed;
- AIRI continued normal NPC work while native labs researched;
- real native labs consumed supplied automation science and unlocked the target technology/recipe;
- the full run retained `actor_id=1` and zero connected players;
- the runtime script completed successfully.

Observed research progress advanced through the real engine (approximately
0.290 -> 0.493 -> 0.695 -> 0.849 -> 0.954) before the target completed. The
research pass therefore proves more than an accepted request or an idle NPC.
It remains a bounded fixture: prerequisites, labs, power and exact science packs
were test setup, not autonomous bootstrap from raw resources.

This closes the implemented research request/native-lab gate at its stated scope.
It does not close repeatable/trigger research, interrupted/stalled research through
the real agent, combat, persistence, death recovery, general navigation, or
end-to-end autonomous planning.

## Research request semantics — user-verified bounded gate

`research_technology` enters NPC task order. Admission returns
`[true, 'Research request queued; verify technology completion separately']`.
This acknowledges the NPC request, not acceptance by Factorio or completion of
the technology. Execution revalidates the technology and requesting actor/force,
then calls `LuaForce.add_research` only when appropriate.

Research is asynchronous force-wide work. The NPC is released after the request
is submitted, so it can deliver science, build infrastructure, or do other work
while labs run.

Safety and outcome rules now include:

- unknown/disabled technology, disabled force research, missing prerequisites,
  gameplay-trigger technology, and conflicting force research are rejected;
- existing different force research is never replaced, cancelled, or silently
  appended to; `force_busy` requires observation/wait/replanning;
- an already active/queued technology is not duplicated; an already researched
  technology is an idempotent no-op;
- deferred requests bind to actor ID, actor kind, and force index;
- a deferred rejection clears remaining queued NPC work and emits an error;
- cancellation removes requests still in the NPC queue but does not cancel
  already-started shared force research;
- `getResearchStatus()` and `getTechnology({ name })` expose bounded current state
  so the agent can distinguish submission from actual completion.

The latest user run exercised these semantics plus native lab completion.

## Current slice: bounded real combat

Status: implemented for user testing; not yet engine-verified.

The old combat loop had several release blockers: it could retarget indefinitely
after a kill, used a fixed guessed engage distance instead of the selected
weapon's actual shootability, could keep walking while firing, had no bounded
stuck/timeout outcome, and production `setup()` deleted every enemy on the
surface before AIRI could interact with it.

The new combat controller:

- queues combat in normal NPC task order and binds it to actor ID, actor kind,
  and force index;
- accepts a bounded search radius of 1..256 tiles;
- selects one nearest enemy and keeps that target instead of silently chaining
  through all enemies;
- records target identity and starting health;
- requires a selected weapon and ammunition;
- uses the character's real `can_shoot(target, position)` result rather than a
  hard-coded weapon range;
- stops walking before firing and uses `shooting_selected` on the bound target;
- follows the target while distance is improving;
- fails after ten simulation seconds without chase progress or one simulation
  minute total, cancelling dependent queued work;
- completes only after the bound target becomes invalid/dead;
- exposes `getCombatStatus()` with the current bounded target plus a persisted
  last-result code such as `target_destroyed`, `no_target`, `no_weapon_or_ammo`,
  `actor_changed`, `stuck`, or `timeout`;
- releases walking/shooting through the existing task lifecycle on completion,
  failure and cancellation;
- no longer removes enemies in production setup.

The agent prompt now requires combat-result verification; an idle task is not a
kill. The structured operation schema uses the same 256-tile maximum as the
runtime controller.

### New combat gate

The Docker path now appends `combat.py` after the already-passing research stage.
It uses the same original NPC and normal character inventories/weapon behavior.
The fixture creates an open arena, gives AIRI a pistol and firearm magazines,
and creates explicit small-biter targets. It does not directly damage targets,
force health to zero, alter weapon damage/range, accelerate game speed, or mark
combat complete.

The gate requires:

1. AIRI consumes real ammunition and destroys the bound enemy;
2. `getCombatStatus()` reports that exact target as `target_destroyed`;
3. actor identity remains stable and AIRI remains alive;
4. no-target returns an explicit `no_target` failure;
5. a live enemy with no ammo remains alive and returns `no_weapon_or_ammo`;
6. dependent queued work is cleared on combat failure;
7. cancelling an out-of-range approach stops movement/shooting and leaves the
   target undamaged across a quiet interval;
8. zero human players remain connected.

Expected new success line:

```text
PASS: zero-player NPC bounded combat + failure/cancellation semantics
```

The assistant has not executed the new TypeScript/build/Factorio combat gate.
Do not treat this combat slice as proven until the user's Docker run reports it.

## Remaining section-4 work

| Workstream | Acceptance still required |
| --- | --- |
| Research follow-through | Interrupted/stalled research recovery through the real agent; gameplay-trigger and repeatable research scenarios; request/result correlation beyond one last-result record. |
| Combat | User-run gate above; then obstacle/unreachable and moving-target behavior can be folded into the navigation work rather than hidden as combat success. |
| Save/restart | Persist/reacquire the same body, inventory and force; defined active/queued-task behavior; no uncontrolled stale inputs after loading; task execution after restart. |
| Death recovery | Detect invalid body, invalidate stale work, create/reacquire replacement deliberately, do not duplicate inventory, then complete a post-recovery task. |
| Navigation | Correlate path request IDs; ignore stale path results after cancellation/replacement; proper collision/reach checks; bounded stuck detection/repath/failure; obstacles/water/unreachable/moving targets. |
| Crafting and cancellation | Cancel owned native queue work correctly; preserve unrelated crafts; verify actual outputs rather than queue disappearance alone; partial queues, full inventory, unavailable recipes, quantities/quality. |
| Cross-actor ownership | Mode/force/body changes cannot carry arbitrary old operations or controls into another actor; human actions cannot satisfy an NPC task. Research/combat binding alone does not fix the other operations. |
| Outcome semantics | Explicit success/failure for all operation types; no generic "completed" on silent failure; stop dependent batches appropriately, including immediate rejection during submission. |
| End-to-end agent | Durable operational goal/step state, bounded runtime context, real prompt/tool/executor/Factorio loop with scripted model boundary, missing-material and changed-world recovery, verification before advancing, bounded provider/tool retries. |

Work in reviewable slices and keep previously passing scenarios in every combined
run. A passing combat fixture will not close persistence/navigation/agent work.
Swarm/message-board execution remains out of scope until the single NPC is reliable.

## Later main and Pterodactyl migration (blocked)

The user requested a coordinated main/NPC/deployment update only AFTER the
single-NPC work is genuinely ready. The later deployment candidate must update
the installer source, generated installer payload, egg installation script,
environment variables, startup/runtime behavior, and deployment documentation
together. Test clean install AND update of an existing save/configuration;
preserve backups and a rollback route. Separate chat authorization from NPC
ownership; do not require a connected human or a hard-coded player index.

No `main` merge, release/tag, default-NPC flip, or Pterodactyl installer/egg change
is included in these reliability slices. Readiness comes from completed acceptance
criteria and the user's test results, not a deadline or a guessed percentage.

## API references (engine version used by the harness)

- [LuaForce 2.0.77: add_research, current_research, research_queue](https://lua-api.factorio.com/2.0.77/classes/LuaForce.html)
- [LuaTechnology 2.0.77: researched, level, prerequisites, research units](https://lua-api.factorio.com/2.0.77/classes/LuaTechnology.html)
- [LuaEntity/LuaControl combat APIs: selected_gun_index, can_shoot, shooting_state](https://lua-api.factorio.com/latest/classes/LuaEntity.html)
- [Factorio inventory definitions: character_guns and character_ammo](https://lua-api.factorio.com/latest/defines.html)
