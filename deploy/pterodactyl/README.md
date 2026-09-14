# AIRI Factorio — Pterodactyl deployment

This directory contains this fork's Pterodactyl deployment for an AIRI-controlled Factorio headless server.

## Current state

The **Factorio runtime itself has reached a validated standalone-NPC baseline**. AIRI no longer needs to own a connected human player's character: the repository acceptance harness has passed zero-player core, research/combat, and resilience lanes, including real restarts, death recovery, navigation, native crafting ownership/reconciliation, research follow-through, combat, actor-mode boundaries, and explicit operation outcomes.

The Pterodactyl package is now being migrated from the older connected-player v7 contract to the **v8 standalone-NPC deployment protocol** in [`staging/`](staging/).

Until that promotion is completed and the generated artifacts are rebuilt, treat the checked-in generated `install.sh` / egg export as the **previous v7 package**, not as proof that the v8 NPC deployment is already production-ready.

The v8 deployment work includes:

- zero-player NPC ownership through native `autorio_actor` mode/status;
- actor ID/kind/epoch authorization instead of player-count ownership;
- `AIRI_CHAT_PLAYER` as chat authorization only, separate from NPC ownership;
- strict structured model `operations` instead of model-generated Lua / `operationCommands`;
- actor-aware observation tools for inventory, entities, navigation, crafting, research and combat;
- full-plan validation before mutation;
- **atomic dependency-batch admission** so Factorio cannot advance a tick between operations from the same model plan;
- no automatic replay of paid provider requests or game mutations;
- clean install, upgrade, rollback and real-provider acceptance gates before promotion.

See [`staging/README.md`](staging/README.md) for the current v8 protocol and promotion checklist.

## Generated egg files

- [`egg-airi-factorio-server.json`](egg-airi-factorio-server.json) — Pterodactyl `PTDL_v2` egg export. Import via **Admin → Nests → Import Egg** once the desired payload revision has been generated and validated.
- [`install.sh`](install.sh) — the same bootstrap install script as a standalone file.

Both are generated wrappers around a checksummed embedded payload.

**The payload source of truth is [`payload-src/installer.sh`](payload-src/installer.sh).** Do not hand-edit the base64/gzip payload inside `install.sh` or the egg JSON.

The supported generation flow is:

1. edit [`payload-src/installer.sh`](payload-src/installer.sh) and the deployment sources/tests that feed it;
2. run [`build-payload.sh`](build-payload.sh), or `node build-payload.mjs`;
3. the generator verifies that decoding the freshly generated payload reproduces `payload-src/installer.sh` byte-for-byte;
4. it updates the payload checksum/size constants and embeds the identical install script in the egg export;
5. commit `payload-src/installer.sh`, `install.sh`, and `egg-airi-factorio-server.json` together.

The generated payload is transactional: portable Node → pinned fork source → Autorio build/deployment guard → supervisor/agent modules → syntax/runtime/unit gates → release swap. A failed install must leave the previous completed release available.

## Runtime container

**Install and runtime image:**

```text
ghcr.io/ptero-eggs/yolks:debian_bookworm
```

**Startup command:**

```text
bash ./start-airi.sh
```

Factorio's game port comes from Pterodactyl's `SERVER_PORT`. Internal RCON remains loopback-only and is managed by the supervisor.

## Configuration direction for v8

The existing egg still exposes the v7 `AIRI_PLAYER` variable. The v8 contract separates chat authorization from controlled-actor ownership:

| Purpose | v8 setting | Meaning |
|---|---|---|
| Actor mode | `AIRI_ACTOR_MODE` | normally `npc`; determines the controlled actor type |
| Chat authorization | `AIRI_CHAT_PLAYER` | optional player name allowed to issue `!airi` chat requests |
| Provider credential | `OPENAI_API_KEY` | required provider key; never written into `airi-config.json` |
| Model | `OPENAI_MODEL` | OpenAI-compatible model identifier |
| Provider URL | `OPENAI_API_BASEURL` | OpenAI-compatible API base URL |
| Save | `SAVE_NAME` | explicit save selection when needed |
| Provider budget | `MAX_PROVIDER_REQUESTS_PER_HOUR` | persisted hourly request limit |
| Factorio version | `FACTORIO_VERSION` | `latest` or supported pinned `2.0.x` |

In NPC mode, **zero connected players is valid**. Human player count must not determine whether the standalone actor is authorized. If `AIRI_CHAT_PLAYER` is unset, the deployment may run the NPC runtime but should not accept ordinary `!airi` chat requests until another request-ingress policy is configured.

`airi-config.json` remains optional. Environment/egg variables take precedence over corresponding file settings. Provider secrets stay environment-only.

## Why model operation batches are admitted atomically

One important behavior was exposed by the real Factorio acceptance harness: separate RCON commands are not a transaction. Factorio can advance a tick between them.

If a model returns:

1. `mine_entity`;
2. `wait` as dependent work;

and those are sent as two RCON commands, mining may fail before the wait has entered Autorio's queue. The runtime then cannot cancel work that was never queued.

The v8 supervisor therefore validates the entire structured operation list first and admits it in **one authorized RCON/Lua command**. The operations are still executed asynchronously by Autorio, but dependent queue semantics are established before Factorio can advance the simulation.

## Public Factorio listing credentials

A Factorio.com account is not required for a private/unlisted server. The headless binary is downloaded from Factorio's public headless distribution and all AIRI control occurs over loopback RCON.

If public listing is explicitly enabled, the installer supports supplying both `FACTORIO_USERNAME` and `FACTORIO_TOKEN`; both must be provided together. Without them, the normal deployment remains private/unlisted.

## Promotion gate

Before the v8 generated egg replaces the old v7 package, require all of the following on the same candidate revision:

1. v8 staging protocol tests pass on Node 24;
2. full zero-player Factorio acceptance harness passes;
3. payload pins a validated NPC source SHA and no longer reapplies the connected-player patch set;
4. clean Pterodactyl install passes;
5. existing-save upgrade passes without actor/save corruption;
6. graceful save/restart passes;
7. rollback to the previous completed release passes;
8. one real provider request completes an NPC goal through the packaged server;
9. `install.sh` and the egg are regenerated from `payload-src/installer.sh` and verified byte-for-byte by the payload builder.

Development continues on `feat/npc-transition-work`; `main` is updated at validated checkpoints.
