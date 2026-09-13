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

This is the completed release gate that previously blocked NPC-native behavior work.

## Implemented

### NPC foundation

- Live control resolution goes through `ControlledActor`.
- Standalone NPC mode exists alongside the temporary player fallback.
- Standalone actor identity is persisted/reacquired by `unit_number`.
- Zero-player control-loop smoke harness exists in Docker.
- Docker runtime failures dump Factorio logs, runner errors, and an incremental RCON transcript.
- Factorio 2.0's first-Lua-command achievement confirmation is handled deterministically by the RCON runner.

### Agent observation

The source agent exposes the Stage A read tools:

- `getActorStatus()`
- `getTaskStatus()`
- `getInventoryItems()`
- `getRecipe(item)`

`getActorStatus()` and `getTaskStatus()` use read-only Autorio status interfaces.

Recipe tool input is validated and Lua-escaped before RCON execution.

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

Unit coverage exists for idle, queued, active-wait, and cancellation snapshots.

Now that the real public status path has passed the zero-player smoke, `autorio_operations.status()` includes this richer task snapshot while preserving the original `task_state`, `queue_empty`, and `actor` fields.

## Current runtime gate: real NPC movement

The Docker runner now extends the proven wait smoke with a deterministic movement scenario.

Test setup:

1. preserve AIRI's standalone character;
2. flatten a short corridor to landfill;
3. remove generated obstacles from that corridor;
4. create a unique `wooden-chest` at a known position;
5. call the real `walk_to_entity('wooden-chest', 50)` operation.

The movement gate must prove:

1. the operation returns to idle;
2. AIRI moves a meaningful distance from the starting point;
3. AIRI finishes within a bounded distance of the target;
4. `actor_id` stays unchanged;
5. connected-player count remains zero;
6. the richer task status remains compatible with the existing smoke assertions.

The test harness owns deterministic world setup through RCON. Production/model behavior still goes through Autorio's structured operation interface.

## Next implementation after movement passes

1. implement NPC-native mining completion based on actor/game state rather than `on_player_mined_entity`;
2. add a deterministic real-Factorio mining fixture and assert inventory delta + idle completion;
3. implement NPC-native crafting completion rather than relying on `on_player_crafted_item`;
4. add a deterministic real-Factorio crafting scenario;
5. add bounded nearby-entity perception and deterministic structured-agent scenarios;
6. continue placement/inventory/research/combat/persistence/death recovery.

For mining, the completion signal should come from standalone actor state such as mining state, target validity/depletion, requested remaining count, and inventory/resource deltas—not from any `LuaPlayer` event.

Pterodactyl migration remains separate from this core NPC/harness work.
