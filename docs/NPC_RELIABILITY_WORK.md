# NPC reliability work: section 4

Working branch: `feat/npc-transition-work`.

This is the active continuation of `NPC_AGENT_HARNESS_PLAN.md` and the historical
checkpoints in `NPC_AGENT_HARNESS_STATUS.md`. The user requested fixing the whole
remaining single-NPC reliability scope first, without rushing a release. The user
runs the tests. Do not merge to `main`, change the default actor mode, publish a
release, or ship a Pterodactyl migration merely because one additional scenario
passes.

## Latest user-reported checkpoint

After the `b1b2a5a` handoff, the user supplied a successful combined runtime log:

- all 23 Python runner regressions passed;
- real zero-player simulation: 121 ticks in 2.02 seconds, approximately 60 UPS;
- wait, movement, mining, native hand crafting, placement and both transfer directions passed;
- core endpoint: x=8.60546875, y=0.52734375 (the earlier uncontrolled drift is no longer present in this run);
- physical stop, queued wait, and movement/mining cancellation stage passed;
- actor_id remained 1 and the runtime script completed successfully.

The previous status document's pending lifecycle entry is superseded by this
user-supplied result. The log does not independently attest a Git revision or
new build-time test results. These are bounded scenario results, not exhaustive
navigation/combat, persistence, or live-model acceptance.

## Current slice: research requests and native lab verification

Status: implemented for user testing, not yet engine-verified.

`research_technology` now enters NPC task order. Admission returns
`[true, 'Research request queued; verify technology completion separately']`.
This acknowledges the NPC request, not acceptance by Factorio or completion of
the technology. Execution revalidates the technology and requesting actor/force,
then calls `LuaForce.add_research` only when appropriate.

Research is asynchronous force-wide work. The NPC is released after the request
is submitted, so it can deliver science, build infrastructure, or do other work
while labs run. A blocking task that waits for all research to complete would
prevent the NPC from supplying the very labs needed to finish it.

Safety and outcome rules:

- unknown/disabled technology, disabled force research, missing prerequisites,
  gameplay-trigger technology, and conflicting force research are rejected;
- existing different force research is never replaced, cancelled, or silently
  appended to; `force_busy` requires observation/wait/replanning;
- an already active/queued technology is not duplicated; an already researched
  technology is an idempotent no-op;
- deferred requests bind to actor ID, actor kind, and force index; changed owners
  cannot inherit the request;
- a deferred rejection clears remaining queued NPC work and emits an error,
  not the normal successful-batch notification;
- cancellation removes requests still in the NPC queue. It does NOT cancel
  already-started shared force research. There is no force-research cancellation
  operation in this patch;
- a bounded, persisted last request result reports `started`, `already_queued`,
  `already_researched`, or a rejection code. It is historical submission evidence,
  never a replacement for the current technology state.

Two bounded agent tools expose the actual state:

- `getResearchStatus()`: current research/progress, at most 10 queue entries,
  queue length/truncation, and the last request result for the current force;
- `getTechnology({ name })`: exact technology, current level/researched state,
  request blocker, science requirements, and at most 20 prerequisites and 20
  ingredient records with truncation flags.

The prompt distinguishes request acceptance, NPC task completion, and actual
technology completion. Repeatable technology requires checking level as well as
researched state; repeatable-research engine acceptance remains separate work.

### New test coverage

TypeScript regressions cover deferred dispatch, busy queues, engine rejection,
idempotency, disabled/unknown/trigger technologies, owner changes, cancellation,
allowing subsequent NPC work, and bounded observations. Agent tool/prompt tests
are included in the existing `test:prompt` route.

The Docker runtime adds `research.py` AFTER all previously passing stages. It
checks real rejection cases, deferred dispatch, cancelling pending research,
idempotent submission, preserving shared research, and normal lab completion.
The same original NPC remains in the world.

Fixture scope is explicit: the test sets up the three early prerequisites
(`steam-power`, `electronics`, `automation-science-pack`), four normal labs,
electric power, and the exact required science packs. It does not prove the NPC
can bootstrap those prerequisites, power, labs, or science from raw resources.
The target technology (`automation`) starts unresearched and its target recipe
locked. Neither target research state/progress nor game/lab speed/productivity
is set to force a pass. Real labs must consume the science and unlock
`assembling-machine-1`; an idle NPC or accepted request alone cannot pass.

Expected new line:

```text
PASS: zero-player NPC research submission + native lab completion
```

The assistant performed source/diff inspection and syntax parsing only. No new
unit suite, build/typecheck, or Factorio scenario is claimed to have passed until
the user supplies results.

## Remaining section-4 work (all still open)

| Workstream | Acceptance still required |
| --- | --- |
| Research follow-through | User-run gate above; interrupted/stalled research recovery through the real agent; gameplay-trigger and repeatable research scenarios; request/result correlation beyond one last-result record. |
| Combat | Real weapon/ammo use, actual target damage/death, range/movement transitions, stopping/cancellation, no-ammo/no-target/unreachable failures, bounded attempts. Do not remove enemies as production setup. |
| Save/restart | Persist/reacquire the same body, inventory and force; defined active/queued-task behavior; no uncontrolled stale inputs after loading; task execution after restart. |
| Death recovery | Detect invalid body, invalidate stale work, create/reacquire replacement deliberately, do not duplicate inventory, then complete a post-recovery task. |
| Navigation | Correlate request IDs; ignore stale path results after cancellation/replacement; proper collision/reach checks; bounded stuck detection/repath/failure; obstacles/water/unreachable/moving targets. |
| Crafting and cancellation | Cancel owned native queue work correctly; preserve unrelated crafts; verify actual outputs rather than queue disappearance alone; partial queues, full inventory, unavailable recipes, quantities/quality. |
| Cross-actor ownership | Mode/force/body changes cannot carry arbitrary old operations or controls into another actor; human actions cannot satisfy an NPC task. Research binding alone does not fix the other operations. |
| Outcome semantics | Explicit success/failure for all operation types; no generic "completed" on silent failure; stop dependent batches appropriately, including immediate rejection during submission. |
| End-to-end agent | Durable operational goal/step state, bounded runtime context, real prompt/tool/executor/Factorio loop with scripted model boundary, missing-material and changed-world recovery, verification before advancing, bounded provider/tool retries. |

Work in reviewable slices and keep previously passing scenarios in every combined
run. A passing simple research scenario does not close this table. Swarm/message
board execution remains out of scope until the single NPC is reliable.

## Later main and Pterodactyl migration (blocked)

The user requested a coordinated main/NPC/deployment update only AFTER the
single-NPC work is genuinely ready. The later deployment candidate must update
the installer source, generated installer payload, egg installation script,
environment variables, startup/runtime behavior, and deployment documentation
together. Test clean install AND update of an existing save/configuration;
preserve backups and a rollback route. Separate chat authorization from NPC
ownership; do not require a connected human or a hard-coded player index.

No `main` merge, release/tag, default-NPC flip, or Pterodactyl installer/egg change
is included in this research slice. Readiness comes from completed acceptance
criteria and the user's test results, not a deadline or a guessed percentage.

## API references (engine version used by the harness)

- [LuaForce 2.0.77: add_research, current_research, research_queue](https://lua-api.factorio.com/2.0.77/classes/LuaForce.html)
- [LuaTechnology 2.0.77: researched, level, prerequisites, research units](https://lua-api.factorio.com/2.0.77/classes/LuaTechnology.html)
- [Factorio 2.0.77 base technology definitions](https://github.com/wube/factorio-data/blob/2.0.77/base/prototypes/technology.lua)
