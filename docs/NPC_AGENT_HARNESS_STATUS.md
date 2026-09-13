# AIRI Factorio — NPC Agent Harness Status

This file tracks implementation progress against `docs/NPC_AGENT_HARNESS_PLAN.md` on `feat/npc-transition-work`.

## Proven in real Factorio

### NPC foundation / passes 1–2

The zero-player Docker integration gate passed against Factorio 2.0.77.

Proven in the real engine:

1. deterministic save creation;
2. Autorio loads successfully;
3. headless server reaches `InGame`;
4. RCON connects and the Factorio 2.0 Lua-console confirmation handshake succeeds;
5. actor mode switches from the migration-safe `player` default to `npc`;
6. a standalone `character` is created with no connected players;
7. the actor has a stable `unit_number` identity (`actor_id`);
8. repeated actor resolution returns the same NPC;
9. actor diagnostics work without a `LuaPlayer`;
10. a real `wait(3)` task reaches the `control.ts` on-tick dispatcher;
11. the task returns to idle;
12. actor identity stays stable and connected-player count remains zero.

### NPC movement / pass 3A

The deterministic movement scenario also passed in the real engine.

Proven:

1. the harness creates a clear deterministic corridor;
2. a unique `wooden-chest` target is created at a known position;
3. `walk_to_entity('wooden-chest', 50)` reaches the real path-request/on-tick movement path;
4. AIRI moves a meaningful distance;
5. AIRI finishes within the bounded target distance;
6. the operation returns to idle;
7. `actor_id` remains stable and connected-player count remains zero.

Observed passing endpoint: AIRI moved from the origin to approximately `{x=8.90, y=0.53}` for a target at `{x=10, y=0}`.

## Implemented

### NPC foundation

- Live control resolution goes through `ControlledActor`.
- Standalone NPC mode exists alongside the temporary player fallback.
- Standalone actor identity is persisted/reacquired by `unit_number`.
- Zero-player control-loop smoke harness exists in Docker.
- Docker runtime failures dump Factorio logs, runner errors, and an incremental RCON transcript.
- Factorio 2.0's first-Lua-command achievement confirmation is handled deterministically by the RCON runner.

### Agent observation

The source agent exposes bounded read tools:

- `getActorStatus()`
- `getTaskStatus()`
- `getInventoryItems()`
- `getRecipe(item)`
- `getNearbyEntities({ radius?, name?, type?, limit? })`
- `getEntityStatus({ name, radius? })`

`getNearbyEntities` is bounded to a 64-tile radius and 100 returned entities. It supports exact prototype-name and entity-type filters and returns compact summaries rather than raw Lua objects or a whole-map dump.

`getEntityStatus` is bounded to a 32-tile radius. It selects the nearest local entity with the requested exact prototype name and returns compact identity/position data plus bounded inventory summaries: at most eight entity inventories and at most fifty returned item records total. Inventory contents use Factorio 2.x `{name, quality, count}` records.

The production prompt tells AIRI to observe the local area before assuming that a resource, chest, machine, or other world target exists nearby, and to verify placement/item-transfer results before depending on them.

Recipe, nearby-entity, and entity-status tool inputs are validated and Lua-escaped before RCON execution.

### Structured operations

The production prompt asks the model for structured operations rather than Lua strings.

Example:

```json
{
  "name": "mine_entity",
  "args": {
    "entity_name": "iron-ore",
    "count": 8
  }
}
```

The harness:

1. validates operation names and argument shapes with Zod;
2. bounds operation batch size;
3. applies defaults for optional operation arguments;
4. renders only approved operations into Autorio `remote.call(...)` commands;
5. preserves the model's original structured JSON in conversation history.

The old `operationCommands` response field remains compatibility-only and is whitelist validated rather than accepting arbitrary Lua.

### Planning contract

The prompt explicitly teaches:

```text
understand
→ observe
→ plan
→ execute a bounded step
→ wait
→ verify
→ advance or replan
```

The response parser validates:

- chat message size;
- bounded plan length;
- valid `currentStep` indexing;
- exactly one action format;
- bounded/approved structured operations.

### Task observability

`task_manager.get_status_snapshot()` exposes a bounded status containing:

- task state;
- queue-empty state;
- queue length;
- queued task types;
- a current-task summary without exposing raw runtime Lua objects.

`autorio_operations.status()` includes this richer task snapshot while preserving the original `task_state`, `queue_empty`, and `actor` fields.

Crafting status includes the requested/started craft count and compact queued-craft count. Mining status includes remaining requested cycles, current target position, and the last observed resource amount.

### NPC-native mining / pass 3B — implemented, awaiting user real-engine gate

Standalone mining no longer depends on `on_player_mined_entity` for completion.

The NPC path now:

1. selects the target through the standalone character's inherited LuaControl selection API;
2. drives normal `mining_state` so Factorio performs real character mining;
3. polls the current target/resource state on ticks;
4. detects resource amount decreases or target disappearance as completed mining cycles;
5. decrements the requested remaining count;
6. stops mining and advances the task queue when the requested count is satisfied.

The real-engine failure captured on 2026-09-13 showed the first ore unit completing while the standalone character remained selected on the same resource. The restart detector incorrectly read `LuaEntity.mining_progress`, which is not the standalone character's mining-progress field. `StandaloneCharacterActor` now uses Factorio's `character_mining_progress`, allowing the controller to recognize the zero-progress boundary and restart the next requested mining cycle even when selection remains on the resource.

Regression coverage now includes both real-engine behaviors:

- selection remains on the resource while `character_mining_progress` resets;
- Factorio clears selection after a mining cycle.

Connected-player mining remains event-driven. Its previous final-count off-by-one was also corrected so a one-count task finishes on the first successful mining event rather than waiting for an extra event.

The Docker runner creates deterministic `iron-ore` within AIRI's reach, requests three mining cycles, and verifies both resource depletion and AIRI inventory growth before accepting idle completion.

### NPC-native crafting / pass 3C — implemented, awaiting user real-engine gate

Standalone crafting no longer depends on `on_player_crafted_item` for completion.

`ControlledActor.begin_crafting` returns the number of crafts Factorio actually queued, and actors expose a bounded count of queued crafts for a recipe. The task manager records the pre-task queue baseline and the number actually started. The standalone on-tick path then polls its own crafting queue and completes the task when AIRI's newly queued crafts drain.

Connected players retain their existing event-driven crafting completion path.

The Docker runner seeds four deterministic iron plates, requests two `iron-gear-wheel` crafts, and verifies output inventory, ingredient consumption, an empty crafting queue, idle task state, stable actor identity, and zero connected players.

### Placement + inventory transfer — acceptance added, awaiting user real-engine gate

The next documented gameplay slice is now included in the authoritative Docker path.

After the core wait → movement → mining → crafting runner passes, a second zero-player runner:

1. keeps the already-running Factorio world and the same standalone AIRI actor;
2. seeds one `wooden-chest` and five `iron-plate` items into AIRI's own inventory as deterministic test setup;
3. calls the normal `place_entity('wooden-chest')` Autorio operation;
4. verifies a nearby player-force wooden chest exists and exactly one chest item was consumed;
5. calls `move_items('iron-plate', 'wooden-chest', 3, true)`;
6. verifies three plates leave AIRI and enter the placed chest;
7. calls `move_items('iron-plate', 'wooden-chest', 2, false)`;
8. verifies two plates return to AIRI and leave the chest;
9. verifies the same `actor_id` survives the sequence and connected-player count remains zero.

Expected success prefix for this stage:

```text
PASS: zero-player NPC completed placement + inventory transfer
```

### Docker validation scope

The Docker build now runs, in order:

1. locked workspace dependency install;
2. agent prompt/tool/structured-response contract tests;
3. TSTL plugin build;
4. Autorio unit tests, including NPC mining/crafting completion regressions;
5. Autorio TSTL typecheck;
6. Autorio mod build;
7. real Factorio 2.0.77 wait + movement + mining + crafting integration;
8. real Factorio placement + bidirectional inventory-transfer integration in the same zero-player world.

The Docker path remains the authoritative validation route without requiring host pnpm/node setup. The user is performing the real-engine Docker runs for this branch; implementation status should not be relabeled as proven until those results are reported.

## Current runtime gate

The next user-run combined Docker gate should prove all of the following in one zero-player session:

1. wait returns to idle;
2. deterministic movement reaches the target area;
3. standalone mining consumes at least three resource units and adds at least three ore to AIRI's own inventory;
4. the mining task returns to idle and mining state is stopped;
5. standalone crafting consumes four seeded iron plates and creates at least two iron gears;
6. AIRI's crafting queue drains and the crafting task returns to idle;
7. AIRI places a wooden chest from its own inventory;
8. AIRI transfers three iron plates into that chest;
9. AIRI retrieves two iron plates from that chest;
10. the same `actor_id` survives the complete wait → movement → mining → crafting → placement → transfer sequence;
11. connected-player count remains zero.

Expected success lines include:

```text
PASS: zero-player NPC completed wait + movement + mining + crafting
PASS: zero-player NPC completed placement + inventory transfer
```

## After this gate

Next implementation targets remain aligned with the roadmap:

1. research/combat acceptance scenarios;
2. save/restart persistence and same-NPC reacquisition;
3. death detection/replacement actor recovery and a post-recovery task;
4. deterministic structured-agent scenarios combining observation, structured operations, verification, and replanning;
5. only after the single NPC is persistent/reliable, begin swarm/message-board architecture.

Pterodactyl migration remains separate from this core NPC/harness work.