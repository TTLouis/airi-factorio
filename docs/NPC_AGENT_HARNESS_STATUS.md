# AIRI Factorio — NPC Agent Harness Status

This file tracks implementation progress against `docs/NPC_AGENT_HARNESS_PLAN.md` on `feat/npc-transition-work`.

## Implemented

### NPC foundation

- Live control resolution goes through `ControlledActor`.
- Standalone NPC mode exists alongside the temporary player fallback.
- Standalone actor identity is persisted/reacquired by `unit_number`.
- Zero-player control-loop smoke harness exists in Docker.
- Docker runtime failures now dump useful Factorio/runner logs.

### Agent observation

The source agent now exposes the Stage A read tools:

- `getActorStatus()`
- `getTaskStatus()`
- `getInventoryItems()`
- `getRecipe(item)`

`getActorStatus()` and `getTaskStatus()` use existing read-only Autorio status interfaces.

Recipe tool input is validated and Lua-escaped before RCON execution.

### Structured operations

The production prompt now asks the model for structured operations rather than Lua strings.

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

The old `operationCommands` response field remains compatibility-only and is now whitelist validated rather than accepting arbitrary Lua.

### Planning contract

The prompt now explicitly teaches:

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

### Task observability groundwork

`task_manager` now has a bounded `get_status_snapshot()` containing:

- task state;
- queue-empty state;
- queue length;
- queued task types;
- a current-task summary without exposing raw runtime Lua objects.

Unit coverage exists for idle, queued, active-wait, and cancellation snapshots.

The richer task-manager snapshot is not yet wired into the public `autorio_operations.status()` response. The current LLM `getTaskStatus()` still reads the existing public status contract. Wire the richer snapshot after the real Factorio smoke confirms the public status path is healthy.

## Current runtime gate

The next real test remains:

```bash
pnpm test:npc
```

The harness must reach real Factorio and prove:

1. zero connected players;
2. valid standalone NPC;
3. stable actor identity;
4. actor diagnostics/status work;
5. normal wait task reaches `control.ts` on-tick processing;
6. wait task returns to idle;
7. same NPC remains selected.

Do not begin NPC-native mining/crafting completion until this gate passes.

## After that gate

Recommended order:

1. wire richer task-manager status into the public status response;
2. add canonical bounded runtime context to model turns;
3. add deterministic structured-agent scenarios;
4. add bounded nearby-entity perception;
5. run real movement scenario;
6. implement NPC-native mining completion;
7. implement NPC-native crafting completion;
8. continue placement/inventory/research/combat/persistence/death recovery.

Pterodactyl migration remains separate from this core NPC/harness work.
