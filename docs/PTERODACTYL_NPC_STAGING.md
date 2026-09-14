# Pterodactyl NPC staging architecture

Working branch: `feat/npc-transition-work`.

This document defines the first deployable **staging** vertical slice for the standalone AIRI NPC. It is intentionally separate from a public/main release. Do not flip the repository default actor mode, publish a release/tag, or replace a production Pterodactyl server until the runtime gates in `NPC_RELIABILITY_WORK.md` and the deployment gates below pass.

## Why the current v7 payload cannot simply be pointed at the NPC branch

The current Pterodactyl payload was built around the original connected-player controller. It is not a neutral wrapper around Autorio:

- `payload-src/installer.sh` currently pins `AIRI_REF=78ef2acf788189981d82aa9e15e9c33b3dedb29c` rather than the NPC reliability branch.
- generated `patch-source.mjs` performs exact source rewriting against the old player-control implementation;
- that patch injects `guard.ts` and replaces Autorio remote interfaces with `airi_guarded_interface(...)`;
- `airi_guard_ready()` requires a configured `AIRI_PLAYER`, exactly one connected player, and that player's live character;
- the deployment status/authorization epoch is therefore a **player-control epoch**;
- the supervisor configures the mod with `airi_deployment.configure(player, session)` and refuses agent work when the configured human is absent;
- the embedded agent policy exposes the older `operationCommands` protocol and only the legacy inventory/recipe observation surface;
- the real installer smoke test explicitly checks that a zero-player Autorio operation is denied;
- documentation tells operators that AIRI controls the one named connected human.

Those assumptions conflict with the tested NPC architecture. Updating only `AIRI_REF` would either make the exact-string patch fail or, worse, recreate player-ownership semantics around code that now owns a standalone NPC.

## Staging target

The first staging deployment should prove this vertical slice:

```text
Pterodactyl starts Factorio
→ no human player is required
→ supervisor selects actor mode = npc
→ standalone AIRI body is created/reacquired
→ embedded agent observes the NPC through the native read tools
→ authorized human chat can request work, but the human body is never controlled
→ work continues if that human disconnects
→ bounded operations return explicit receipts
→ save/restart reconciles volatile task/control/native-craft ownership
→ body death recovers a replacement NPC
→ supervisor notices actor identity changes and invalidates stale model turns
→ graceful stop saves the world
```

Swarm/message-board execution is not part of this staging target.

## Configuration contract

### Actor ownership

Introduce an explicit deployment setting:

```text
AIRI_ACTOR_MODE=npc
```

Allowed values for the staged runtime should be `npc` and `player`. The public/default behavior must not change until the final release gate; the **staging egg** may set `npc` explicitly.

The setting is also represented as `actorMode` in `airi-config.json`, with the environment taking precedence, matching the existing config precedence rules.

### Chat authorization is separate

Do not reuse a human player name as actor ownership in NPC mode.

Preferred staged variable:

```text
AIRI_CHAT_PLAYER=<optional human name allowed to issue !airi chat requests>
```

Compatibility rule:

- in `player` mode, legacy `AIRI_PLAYER` retains its old controlled-player meaning;
- in `npc` mode, the actor is always the standalone NPC;
- `AIRI_CHAT_PLAYER` controls who may trigger `!airi ...` from game chat;
- a human disconnect must not invalidate or stop NPC ownership;
- multiple connected humans must not make the NPC actor invalid;
- no connected humans must not make the NPC actor invalid.

The staging implementation may accept `AIRI_PLAYER` as a deprecated chat-authorizer alias only if this is explicit and cannot be interpreted as NPC ownership.

## Supervisor startup protocol

The v8 supervisor should stop using a patched `airi_deployment.configure(player, session)` as the source of actor truth.

After authenticated loopback RCON is ready:

1. query `autorio_actor.status()`;
2. if configured for NPC mode, call `autorio_actor.set_mode('npc')` through the native actor interface;
3. query `autorio_actor.status()` again and require:
   - `mode == 'npc'`;
   - actor exists and is valid;
   - actor kind is `standalone_character`;
   - actor has a concrete `actor_id`;
4. query `autorio_operations.status()` and require a valid bounded task snapshot;
5. inspect load reconciliation state before accepting model work;
6. only then start/enable the embedded agent.

The supervisor session owns the RCON credential and is the only component allowed to submit game-changing operation calls. The mod does not need to pretend a connected player is the security boundary.

## Actor epoch in NPC mode

Keep the useful epoch concept, but redefine it around **NPC identity**, not player connection state.

A staged actor epoch should include at least:

- actor mode;
- actor ID;
- actor kind;
- force identity/index when available.

Before each paid provider request and before each game-changing operation, compare the current actor snapshot to the epoch captured for the active model turn.

If the actor changes because of death recovery, mode change, force change, or invalidation:

- reject the stale operation;
- cancel/supersede the current model turn;
- observe the replacement/current actor;
- allow the next model turn to replan from fresh state.

A human join/leave by itself must not rotate an NPC actor epoch.

## Source/build policy

The staging payload should build the tested NPC source directly rather than replaying the legacy connected-player patch set.

Target migration:

1. pin `AIRI_REF` to the exact user-verified NPC staging candidate commit;
2. retire the legacy exact replacements in generated `patch-source.mjs` for that source;
3. preserve only build-time changes that are still truly required and can be asserted against the pinned source;
4. compile Autorio from the pinned source;
5. verify the resulting mod exposes at least:
   - `autorio_actor`;
   - `autorio_operations`;
   - `autorio_navigation`;
   - `autorio_crafting`;
   - `autorio_research`;
   - `autorio_combat`;
   - `autorio_tools`.

Do not silently fall back to applying the old player patch when the expected native NPC interfaces are missing. Installation must fail closed.

## Embedded agent protocol

The Pterodactyl payload currently embeds an older adapter that accepts model-produced `operationCommands`. The staging payload must align with the repository's tested native agent contract:

- model returns structured `operations` objects, never arbitrary Lua;
- the supervisor/adapter validates structured operation schemas before rendering commands;
- expose the current bounded observation set:
  - actor status;
  - task status;
  - inventory;
  - recipe;
  - nearby entities;
  - entity status;
  - navigation status;
  - crafting status;
  - research status;
  - technology status;
  - combat status;
- verify operation-specific receipts rather than treating generic idle as success;
- transport-belt displacement must not be interpreted as continued walking;
- keep provider/tool retries bounded and never automatically replay a game mutation whose acknowledgement is unknown.

Prefer importing/generating this contract from repository source when practical rather than maintaining two independent prompt/tool definitions indefinitely.

## Chat behavior

In NPC mode the human is a requester, not the controlled body.

Expected behavior:

```text
[CHAT] authorized-human: !airi build ...
→ supervisor forwards request to agent
→ agent controls standalone NPC
→ authorized-human may disconnect
→ NPC operation continues according to its own ownership/result semantics
```

`!airi stop` from the authorized chat identity should cancel the active Autorio batch and model turn. It should not freeze or otherwise mutate the human character.

A future message-board/swarm surface can provide non-chat triggering; it is not required for this single-NPC staging slice.

## Save/restart and graceful shutdown

The staged supervisor must respect the reliability policy already proven in the Factorio harness:

- volatile Autorio tasks are not resumed after load;
- serialized walking/mining/shooting controls are reconciled;
- a persisted Autorio-owned native crafting queue is cancelled on load instead of becoming orphaned work;
- unrelated native crafting must not be cancelled;
- shared native research is not silently rewritten as part of task reconciliation.

Before server shutdown:

1. stop accepting new model work;
2. cancel the active model turn;
3. explicitly cancel the active Autorio batch where safe;
4. request `/server-save` and require its acknowledgement;
5. terminate Factorio cleanly;
6. retain the existing forced-stop diagnostic path if graceful shutdown fails.

## Installation/update transaction

Keep the strong v7 transactional behavior:

- do not execute network-fetched shell code;
- verify Node and Factorio downloads;
- stage releases under `.airi`;
- back up the selected save/config/mod list before activation;
- load-test a copy of the user save before activating a new Factorio binary/mod build;
- use atomic release/state swaps;
- never overwrite an existing save during save creation;
- keep rollback metadata for the previous completed release.

The NPC staging change must not weaken any of those properties.

## Required staging smoke gates

The installer/runtime tests should be changed from the old `zeroPlayerGuard` expectation to the following minimum gates.

### Disposable install smoke

On a private disposable save:

1. zero connected players;
2. set actor mode to NPC;
3. observe one valid standalone actor;
4. run a bounded wait and verify explicit completion;
5. run one movement fixture and verify `reached` rather than idle;
6. verify a connected test human, if introduced by fixture/mock, is not used as the controlled actor;
7. stop cleanly with a save acknowledgement.

The installer smoke does not need to duplicate the complete repository `npc-test` matrix; it must prove the packaged artifact and supervisor wiring use the same actor contract.

### Existing-save upgrade smoke

Using a copy of an existing save/configuration:

1. create backup and record hash;
2. start the candidate packaged mod in NPC mode;
3. require load reconciliation to finish;
4. require original save world state still exists;
5. require no human player is needed;
6. run one fresh NPC operation;
7. save and stop cleanly;
8. verify rollback can restore the previous app release and untouched backup copy.

### Repository runtime gate

Before pinning a candidate into the Pterodactyl payload, the combined `tests/factorio` gate must be green for that exact commit.

## File-by-file migration checklist

`deploy/pterodactyl/payload-src/installer.sh`

- bump installer/revision only when staging implementation is coherent;
- pin the exact NPC candidate SHA;
- seed/validate actor mode and separate chat authorization;
- replace legacy source patching with native-NPC interface verification/build;
- update embedded policy/tools/prompt;
- update supervisor startup/epoch/chat semantics;
- update real smoke tests from zero-player denial to zero-player NPC success.

`deploy/pterodactyl/build-payload.mjs`

- retain source-of-truth checks;
- regenerate payload only after `payload-src/installer.sh` tests pass.

`deploy/pterodactyl/install.sh`

- generated artifact only; never hand-edit payload bytes/checksums.

`deploy/pterodactyl/egg-airi-factorio-server.json`

- generated install script must remain byte-identical to `install.sh`;
- add staged actor/chat variables to the egg variable set;
- keep secrets hidden and API key environment-only.

`deploy/pterodactyl/README.md`

- replace connected-player ownership language for the NPC staging/release path;
- document chat authorization separately;
- document clean install, existing-save upgrade, backup and rollback.

## Staging readiness gate

A Pterodactyl **staging** deployment is allowed when all of these are true for the same pinned commit:

- combined runtime harness green;
- crafting + crafting restart green;
- generalized basic-operation ownership/outcomes green;
- research follow-through gate green enough for the chosen vertical scenario;
- scripted end-to-end agent scenario green;
- payload source tests green;
- generated payload/egg consistency green;
- disposable clean install smoke green;
- existing-save upgrade smoke green;
- rollback path verified.

This is the staging threshold, not the final public release threshold.

## Still blocked from staging today

At the time this document was added:

- navigation, combat, persistence and death recovery have user-verified engine evidence;
- crafting/crafting-restart is implemented but still awaiting a green combined build/runtime run;
- basic mine/place/move/wait ownership/outcomes are the next executor reliability slice;
- research follow-through and the end-to-end agent recovery scenario remain open;
- the existing Pterodactyl v7 connected-player guard/policy has not yet been migrated.

Do not deploy the v7 payload merely by changing its source SHA. The source patch, supervisor authorization model, prompt/tool contract and smoke expectations must migrate together.