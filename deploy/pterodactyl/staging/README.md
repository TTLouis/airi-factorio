# NPC staging prototypes

This directory contains the **v8 standalone-NPC deployment protocol prototypes**. They are intentionally not wired into the current v7 payload yet.

The purpose is to let the deployment authorization/session model converge while the runtime reliability branch is still being validated, without destabilizing the existing installer.

## Files

- `npc-session.mjs` — deployment configuration, NPC readiness validation, chat-authorization separation and actor epoch helpers.
- `npc-session.test.mjs` — zero-player, multi-human, replacement-body and load-reconciliation unit cases.
- `guard.ts` — Factorio-side `airi_deployment` v8 prototype. It captures actor mode/ID/kind and performs atomic epoch authorization without wrapping every Autorio remote interface.
- `guard.test.mjs` — VM fixture for zero-player authorization, body replacement, cancellation and legacy player-mode compatibility.
- `supervisor-adapter.mjs` — Node/RCON startup handshake and atomically authorized operation wrapper.
- `supervisor-adapter.test.mjs` — fake-RCON tests for configure retry, identity validation, stale epochs and no-replay mutation failures.

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
7. migrate the embedded agent from `operationCommands` to the repository's structured-operation/read-tool contract;
8. replace the installer smoke expectation `zero players => denied` with `zero players => standalone NPC allowed`;
9. run clean-install, existing-save upgrade and rollback gates;
10. only then regenerate `install.sh` and the egg from `payload-src/installer.sh`.

Do not hand-edit the generated payload or egg script to experiment with this protocol.
