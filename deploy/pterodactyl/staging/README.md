# NPC staging v8

This directory contains the **v8 standalone-NPC deployment protocol** that is being promoted into the Pterodactyl payload.

The underlying Factorio runtime is no longer experimental at this checkpoint: the zero-player NPC acceptance suite has passed all three isolated parallel lanes (`core`, `research-combat`, and `resilience`), including real process restarts, death recovery, navigation, native crafting ownership/reconciliation, native research follow-through, combat, actor-mode boundaries, and explicit basic-operation failure receipts.

The remaining work here is deployment integration: replacing the old v7 connected-player patch/guard/agent contract without weakening the transactional installer and rollback behavior.

## Files

- `npc-session.mjs` — deployment configuration, NPC readiness validation, chat-authorization separation and actor epoch helpers.
- `npc-session.test.mjs` — zero-player, multi-human, replacement-body and load-reconciliation unit cases.
- `guard.ts` — Factorio-side `airi_deployment` v8 guard. It captures actor mode/ID/kind and performs actor-epoch authorization without wrapping the native actor-aware Autorio interfaces.
- `guard.test.mjs` — VM fixture for zero-player authorization, body replacement, cancellation and legacy player-mode compatibility.
- `supervisor-adapter.mjs` — Node/RCON startup handshake plus authorized operation and **atomic dependency-batch** admission.
- `supervisor-adapter.test.mjs` — fake-RCON tests for configure retry, identity validation, stale epochs, no-replay failures, and one-transaction batch admission.
- `structured-policy.mjs` — strict structured model response/operation validation plus the actor-aware read-only tool surface. It does not accept model-generated Lua or the old `operationCommands` format.
- `structured-policy.test.mjs` — bounds, schema, rendering and injection-rejection cases for the staged model contract.
- `npc-agent-loop.mjs` — epoch-safe prompt/tool/operation loop. It rechecks the captured NPC actor before provider calls and observations, validates the complete plan before mutation, then admits the operation dependency batch atomically.
- `npc-agent-loop.test.mjs` — scripted-provider vertical tests for replacement during observation, malformed later operations, atomic dependency admission, post-admission actor replacement, completion continuation, and malformed/unknown tools.

## Why operation batches are atomic

Factorio can advance simulation ticks between separate RCON commands. That matters when a model returns a plan such as:

1. mine a target;
2. wait or perform another operation that should only happen if mining remains valid.

Submitting those as separate RCON commands creates a race: operation 1 can execute and fail before operation 2 has even entered Autorio's queue. The runtime then has nothing dependent to cancel.

v8 therefore treats one model `operations` array as one **admission transaction**:

1. validate every structured operation first;
2. re-check the captured actor epoch;
3. send one RCON/Lua command;
4. authorize the epoch once inside that command;
5. enqueue every operation synchronously, in order;
6. fail closed on an admission rejection;
7. never replay the mutation command automatically.

Runtime execution is still asynchronous. If the first owned operation later fails, Autorio can now cancel the already-queued dependent work deterministically. If death/recovery or a mode change happens after admission, the next supervisor/agent epoch check cancels the stale continuation while the in-game ownership boundary handles the admitted tasks.

## Run the isolated v8 protocol tests

The deployment targets Node 24; the guard fixture uses Node's `stripTypeScriptTypes`.

```bash
node --test deploy/pterodactyl/staging/*.test.mjs
```

These tests are a deployment-protocol gate, not a substitute for the real Factorio harness.

## Promotion order

The validated runtime baseline is now on `main`, while `feat/npc-transition-work` remains the active integration/testing branch. The Pterodactyl promotion order is:

1. keep all new deployment work on `feat/npc-transition-work`;
2. pin the payload to a validated NPC source SHA instead of the old connected-player source pin;
3. build the native actor-aware Autorio source — do **not** reapply the v7 connected-player control patch set;
4. compile/inject the v8 `airi_deployment` guard alongside the native NPC interfaces;
5. configure `npc` mode at startup and capture the standalone actor ID/kind/epoch;
6. keep `AIRI_CHAT_PLAYER` (who may issue `!airi`) separate from NPC ownership;
7. replace `operationCommands` with the structured `operations` contract;
8. use atomic dependency-batch admission for model mutations;
9. expose the current actor-aware observation tools, including correlated research state;
10. replace the old installer smoke assumption `zero players => denied` with `zero players => standalone NPC authorized`;
11. run clean-install, existing-save upgrade, graceful restart/save, rollback, and one real provider-to-NPC goal;
12. only after those gates pass, regenerate `install.sh` and `egg-airi-factorio-server.json` from `payload-src/installer.sh` and let `main` catch up again.

Do not hand-edit the generated payload blob or egg export. The payload source and generator remain the source of truth.
