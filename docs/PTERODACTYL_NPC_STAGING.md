# Pterodactyl NPC staging architecture

Working branch: `feat/npc-transition-work`.

`main` now contains the last **user-verified zero-player NPC runtime baseline**. The feature branch remains the integration/testing branch for Pterodactyl v8 and later agent/swarm work.

The full repository Factorio gate has passed in parallel for `core`, `research-combat`, and `resilience`, including real process restarts, death recovery, navigation, native crafting ownership/reconciliation, research follow-through, combat, actor-mode boundaries, and explicit basic-operation failure receipts. The remaining staging work is therefore deployment/package integration, not proving the basic standalone-NPC runtime again.

## Why the checked-in v7 payload cannot simply be repointed

The currently generated Pterodactyl package is still built around connected-player ownership:

- `payload-src/installer.sh` pins the old connected-player source revision;
- generated `patch-source.mjs` rewrites Autorio around a named human player;
- its guard requires `AIRI_PLAYER`, exactly one connected player, and that player's live character;
- supervisor authorization is a player-control epoch;
- the embedded model contract uses legacy `operationCommands`;
- zero connected players are treated as a denial condition.

Those assumptions directly conflict with the validated NPC architecture. The old package must not be made to look current by changing only `AIRI_REF` or by regenerating its checksums.

`build-payload.mjs` now deliberately refuses to regenerate the canonical `install.sh`/egg while those v7 markers remain in the payload source.

## v8 staging target

```text
Pterodactyl starts Factorio
→ zero humans is valid
→ supervisor configures actor mode = npc
→ standalone AIRI body is created/reacquired
→ guard captures actor ID + kind + deployment epoch
→ model observes only through bounded actor-aware tools
→ authorized chat requests work without transferring human-body ownership
→ one structured model operation list is admitted atomically
→ Autorio executes owned work asynchronously with explicit receipts
→ save/restart/death recovery invalidate stale work safely
→ supervisor cancels stale model continuations when actor epoch changes
→ graceful stop saves the world
```

Swarm/message-board execution is intentionally outside this first staging vertical.

## Configuration contract

### Actor ownership

```text
AIRI_ACTOR_MODE=npc
```

Allowed staged values are `npc` and `player`. In NPC mode, connected-player count is not an ownership condition.

### Chat authorization

```text
AIRI_CHAT_PLAYERS=<blank or * = everyone, "none" = disabled, or a comma-separated exact-name allowlist>
```

The named humans are requesters, not AIRI's body. `AIRI_CHAT_PLAYER` (singular) and `AIRI_PLAYER` may remain only as explicit compatibility fallbacks while older eggs are being migrated; neither must ever become NPC ownership.

Expected NPC behavior:

- zero humans: NPC remains valid;
- one or many humans: NPC ownership is unchanged;
- authorized chat player disconnects: already-owned NPC work is not invalidated;
- NPC death/replacement: actor epoch changes and stale model continuation is rejected.

## Native source promotion

`deploy/pterodactyl/staging/source-preparer.mjs` is the replacement for the old connected-player `patch-source.mjs` behavior.

It requires the pinned Autorio source to already contain the native actor-aware runtime:

- `autorio_actor` wired through `create_actor_remote_interface()`;
- native `autorio_operations`;
- bounded navigation, crafting, research and combat controllers;
- real standalone-NPC selection/creation;
- the expected TSTL control bundle.

It then injects only the v8 `airi_deployment` guard import and guard source. It explicitly refuses legacy `airi_guarded_interface` / `airi_guard_ready` markers and reports `patchedGameplaySemantics: false`.

The source-preparer tests copy the repository's **real Autorio source** into a temporary tree, verify guard-only idempotent preparation, and fail closed on legacy/non-NPC source.

## Deployment guard and actor epoch

The staged `airi_deployment` guard configures native actor mode and binds a session to:

- actor mode;
- stable actor ID;
- actor kind;
- monotonically rotated deployment epoch.

For NPC mode it requires `standalone_character`. Connected-human count is reported diagnostically but does not authorize ownership.

Before paid provider calls, observations and mutations, the Node agent loop rechecks the current deployment status against the captured epoch. Death recovery or mode/actor replacement cancels the stale model turn; human join/leave alone does not.

## Structured model contract

The old free-form `operationCommands` surface is retired in v8. The model returns exactly:

```json
{
  "chatMessage": "...",
  "plan": ["..."],
  "currentStep": 0,
  "operations": [
    { "name": "wait", "args": { "ticks": 60 } }
  ]
}
```

Approved operations are bounded forms of:

- movement;
- mining;
- placement;
- item transfer;
- native hand crafting;
- combat;
- research request submission;
- wait.

No model-generated Lua, console commands, shell commands, or arbitrary `remote.call(...)` strings are accepted.

The bounded read-only tool surface includes:

- actor status;
- task status;
- inventory;
- recipe;
- nearby entities;
- one nearby entity status;
- navigation status;
- crafting status;
- research status;
- **exact research request/follow-through lookup by `request_id`**;
- technology status;
- combat status.

## Atomic dependency-batch admission

A real Factorio test exposed an important RCON boundary: Factorio can advance simulation ticks between separate RCON commands.

If a model intends:

1. `mine_entity`;
2. dependent `wait`;

and those admissions are sent separately, mining can fail before the wait has entered Autorio's queue. The runtime then has no dependent work to cancel.

v8 therefore treats one model `operations` array as one admission transaction:

1. validate and render the complete operation list before mutation;
2. recheck actor epoch;
3. send one RCON/Lua command;
4. authorize that epoch once inside the command;
5. call each approved `autorio_operations` method synchronously in order so all accepted work enters the logical queue before Factorio can tick;
6. preserve each native Autorio return shape — either a boolean or a tuple-table;
7. reject `false` and tuple results whose first element is `false`;
8. require one explicit acknowledgement marker;
9. never automatically replay a mutation if acknowledgement is missing or failed.

Execution remains asynchronous after admission. If earlier owned work later fails, Autorio can now cancel work that was already in its dependent queue.

## Prompt/agent behavior

The repository agent prompt already describes AIRI as a standalone NPC, uses structured `operations`, distinguishes human chat from actor ownership, and requires operation-specific verification rather than generic idle.

The v8 loop additionally:

- bounds provider/tool rounds;
- checks actor epoch before and after observations;
- validates the whole operation batch before first mutation;
- uses atomic batch admission;
- bounds completion continuations;
- does not replay provider-paid turns or game mutations after uncertain acknowledgement.

## CI / protocol gate

The repository CI includes a Node 24 job:

```bash
node --test deploy/pterodactyl/staging/*.test.mjs
```

This covers session rules, guard behavior, structured policy, correlated research lookup, epoch-safe agent flow, atomic admission, and native-source preparation. It complements rather than replaces `tests/factorio`.

## Transactional installation requirements

The final v8 payload must retain the strong parts of the current installer:

- stage releases under `.airi`;
- never execute unverified network-fetched shell code;
- pin source and runtime downloads;
- keep provider secrets environment-only;
- back up selected save/config/mod state before activation;
- load-test an existing-save copy before activation;
- preserve an older completed release for rollback;
- atomically swap the active release/start script;
- never overwrite an existing save when creating a first-run world;
- graceful `/server-save` before shutdown with forced-stop diagnostics only as fallback.

## Promotion checklist

The migration is now at this point:

- [x] standalone NPC runtime implemented;
- [x] full parallel Factorio acceptance gate user-verified;
- [x] main updated to the validated runtime checkpoint;
- [x] v8 NPC session/guard prototypes;
- [x] strict structured operation policy;
- [x] actor-aware observation tools;
- [x] exact correlated research request tool;
- [x] epoch-safe agent loop;
- [x] atomic dependency-batch admission;
- [x] native source-preparer replacing connected-player gameplay patching;
- [x] dedicated Node 24 staging CI job;
- [x] payload generator safety rail blocks accidental v7 regeneration;
- [ ] migrate `payload-src/installer.sh` to the v8 runtime/supervisor contract;
- [ ] replace egg variables with `AIRI_ACTOR_MODE` / `AIRI_CHAT_PLAYERS` semantics;
- [ ] packaged zero-player disposable smoke;
- [ ] existing-save upgrade smoke;
- [ ] graceful packaged restart/save gate;
- [ ] rollback gate;
- [ ] one real provider → packaged NPC goal;
- [ ] regenerate canonical `install.sh` and `egg-airi-factorio-server.json` from the tested v8 source;
- [ ] let `main` catch up to that validated deployment checkpoint.

## What must not happen

Do **not**:

- force the old v7 payload onto the NPC source;
- hand-edit generated base64/checksum payload bytes;
- make human player count the NPC authorization boundary;
- restore model-generated Lua or `operationCommands` as the v8 mutation contract;
- send dependent model operations as separate RCON mutation commands;
- regenerate/publish the canonical egg until the source payload itself has migrated and passed its staging gates.
