# NPC staging prototypes

This directory contains the **v8 standalone-NPC deployment protocol prototypes**. They are intentionally not wired into the current v7 payload yet.

The purpose is to let the deployment authorization/session/agent model converge while the runtime reliability branch is still being validated, without destabilizing the existing installer.

## Files

- `npc-session.mjs` — deployment configuration, NPC readiness validation, chat-authorization separation and actor epoch helpers.
- `npc-session.test.mjs` — zero-player, multi-human, replacement-body and load-reconciliation unit cases.
- `guard.ts` — Factorio-side `airi_deployment` v8 prototype. It captures actor mode/ID/kind and performs atomic epoch authorization without wrapping every Autorio remote interface.
- `guard.test.mjs` — VM fixture for zero-player authorization, body replacement, cancellation and legacy player-mode compatibility.
- `supervisor-adapter.mjs` — Node/RCON startup handshake and atomically authorized operation wrapper.
- `supervisor-adapter.test.mjs` — fake-RCON tests for configure retry, identity validation, stale epochs and no-replay mutation failures.
- `structured-policy.mjs` — strict model response/operation validation plus the current actor-aware read-only tool surface; it does not accept model-generated Lua or the old `operationCommands` format.
- `structured-policy.test.mjs` — bounds, schema, rendering and injection-rejection cases for the staged model contract.
- `npc-agent-loop.mjs` — scriptable prompt/tool/operation loop which rechecks the captured NPC actor epoch before provider calls, tool reads and each world mutation.
- `npc-agent-loop.test.mjs` — scripted-provider vertical tests, including actor replacement during observation/mutation and full-batch validation before the first mutation.

## Run the isolated prototype tests

The deployment currently targets Node 24, which provides `stripTypeScriptTypes` used by the guard fixture.

```bash
node --test deploy/pterodactyl/staging/*.test.mjs
```

These tests are intentionally separate from the current v7 payload tests. Passing them does **not** make the Pterodactyl deployment staging-ready by itself.

## Integration order

When the same NPC commit has passed the repository Factorio gate:

1. pin that exact SHA as the staging `AIRI_REF`;
2. build the native Autorio NPC source rather than applying the v7 connected-player patch set;
3. inject/compile the v8 `airi_deployment` guard alongside the native mod without replacing its actor-aware interfaces;
4. change supervisor startup to configure NPC mode and capture the returned actor epoch;
5. replace the old connected-player authorization checks with the v8 actor epoch checks;
6. separate `AIRI_CHAT_PLAYER` request authorization from actor ownership;
7. replace the old embedded `operationCommands` adapter with `structured-policy.mjs` semantics and the current observation tool set;
8. use the epoch-safe agent-loop behavior for provider/tool/operation sequencing and no-replay failures;
9. replace the installer smoke expectation `zero players => denied` with `zero players => standalone NPC allowed`;
10. run clean-install, existing-save upgrade and rollback gates;
11. only then regenerate `install.sh` and the egg from `payload-src/installer.sh`.

Do not hand-edit the generated payload or egg script to experiment with this protocol.
