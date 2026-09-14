# AIRI Factorio — Pterodactyl deployment

This directory contains this fork's Pterodactyl deployment for the standalone AIRI Factorio NPC.

## Current state

The Factorio runtime has a **user-verified standalone-NPC baseline**: the parallel zero-player `core`, `research-combat`, and `resilience` lanes pass, including real restarts, death recovery, navigation, native crafting ownership/reconciliation, research follow-through, combat, actor-mode boundaries, and explicit operation outcomes.

The checked-in [`egg-airi-factorio-server.json`](egg-airi-factorio-server.json) is now a **generated v8 standalone-NPC release candidate**, not the previous connected-player v7 package. The installed runtime remains pinned to source commit `8879a71b7b74118b1030d8a89aaf4fba3c95ebf6`.

The candidate still stays on `feat/npc-transition-work` until the packaged Docker smoke is green. Do not merge/publish it to `main` merely because the JSON imports successfully.

## What v8 changes

- zero-player NPC ownership through native `autorio_actor` mode/status;
- actor ID/kind/epoch authorization instead of connected-player ownership;
- `AIRI_CHAT_PLAYER` is chat authorization only and never actor ownership;
- strict structured model `operations`, with no model-generated Lua or legacy `operationCommands`;
- actor-aware observations for inventory, entities, navigation, crafting, research and combat;
- exact correlated research-request lookup;
- full-plan validation before mutation;
- **atomic dependency-batch admission** so Factorio cannot advance a tick between dependent operations from one model plan;
- no automatic replay of paid provider requests or unknown-acknowledgement game mutations;
- checksummed release files and loopback-only RCON;
- transactional activation plus an explicit `rollback-airi.sh` target for the previous completed managed release.

See [`staging/README.md`](staging/README.md) for the protocol details and [`RELEASE_CANDIDATE.md`](RELEASE_CANDIDATE.md) for the release gates.

## Importing the release-candidate egg

Import [`egg-airi-factorio-server.json`](egg-airi-factorio-server.json) through **Admin → Nests → Import Egg**.

Use this image for both installation and runtime:

```text
ghcr.io/ptero-eggs/yolks:debian_bookworm
```

Startup command:

```text
bash ./start-airi.sh
```

The only externally exposed service required by AIRI is Factorio's normal game port. Internal RCON is dynamically allocated on `127.0.0.1` and owned by the supervisor.

## v8 egg variables

| Purpose | Setting | Meaning |
|---|---|---|
| Actor ownership | `AIRI_ACTOR_MODE` | fixed to `npc` for this first v8 egg |
| Chat authorization | `AIRI_CHAT_PLAYER` | optional exact player name allowed to issue `!airi ...` |
| Provider credential | `OPENAI_API_KEY` | required; hidden and never written into `airi-config.json` |
| Model | `OPENAI_MODEL` | OpenAI-compatible model identifier |
| Provider URL | `OPENAI_API_BASEURL` | HTTPS OpenAI-compatible API base URL |
| Save | `SAVE_NAME` | optional explicit save name; blank chooses newest or creates `airi-world.zip` |
| Provider budget | `MAX_PROVIDER_REQUESTS_PER_HOUR` | persisted hourly request cap |
| Shutdown timeout | `SHUTDOWN_TIMEOUT_MS` | save/stop timeout before forced fallback |
| Factorio version | `FACTORIO_VERSION` | `latest`, `experimental`, or an exact supported `2.0.x` |

There is deliberately no `AIRI_PLAYER` actor-ownership variable in the v8 egg. Zero connected humans is valid. If `AIRI_CHAT_PLAYER` is blank, AIRI may run as an NPC but ordinary in-game `!airi` chat requests are disabled.

## Generated artifacts

- [`payload-src/installer.sh`](payload-src/installer.sh) — human-readable installer source of truth.
- [`build-payload.mjs`](build-payload.mjs) — generator and integrity/drift checker.
- [`install.sh`](install.sh) — self-contained checksummed bootstrap generated from the payload source.
- [`egg-airi-factorio-server.json`](egg-airi-factorio-server.json) — compact PTDL_v2 egg whose install field downloads that bootstrap from an **immutable commit pin**, verifies that the bootstrap advertises the expected payload-source SHA-256, and then executes it.

The egg deliberately does **not** embed the large gzip/base64 bootstrap anymore. Keeping the PTDL JSON small avoids fragile escaping and makes it practical to parse/inspect independently, while the immutable commit pin plus the bootstrap's own source/archive checks preserve the release-integrity chain.

Regenerate/check with:

```bash
node deploy/pterodactyl/build-payload.mjs
node deploy/pterodactyl/build-payload.mjs --check
```

`--check` validates the standalone bootstrap against `payload-src/installer.sh`, parses the committed egg as JSON, and verifies that the complete egg schema matches the expected immutable loader contract. It does not require identical gzip output across different Node/zlib builds.

The standalone bootstrap also supports a non-installing integrity probe:

```bash
AIRI_INSTALL_ROOT=/tmp/airi-bootstrap-check bash deploy/pterodactyl/install.sh --verify-only
```

## Package smoke

The release gate for the generated artifact is:

```bash
bash deploy/pterodactyl/package-smoke.sh
```

On Windows with Docker Desktop, run the smoke directly only if the calling environment permits a long foreground process:

```powershell
.\deploy\pterodactyl\package-smoke.ps1
```

If the caller imposes a short command timeout, use the detached wrapper instead. It launches the exact same `package-smoke.ps1` through one UTF-16LE PowerShell `-EncodedCommand`, avoiding `Start-Process` argument splitting of nested Docker `bash -lc` validation scripts:

```powershell
.\deploy\pterodactyl\package-smoke-background.ps1 -Action Start
```

The start command returns immediately and records the exact candidate commit plus its PID. Query progress/result with a short command:

```powershell
.\deploy\pterodactyl\package-smoke-background.ps1 -Action Status
```

Detached state is written to `.package-smoke-last.log`, `.package-smoke-last.err.log`, `.package-smoke-last.pid`, and `.package-smoke-last.result.json`. A completed run is only a pass when the result JSON says `PASS` with exit code `0`; a dead PID without a result file is explicitly **inconclusive**, not a package failure or success.

On a Docker-capable machine the smoke performs:

1. generated-artifact integrity/schema check;
2. parse the committed PTDL_v2 egg and extract its real installation script;
3. standalone generated bootstrap `--verify-only`;
4. clean transactional installation **through the egg loader** into a disposable server volume;
5. pinned native Autorio tests/build plus injected v8 guard typecheck/build;
6. verified Factorio 2.0 headless download;
7. startup with **zero connected players**;
8. required `AIRI Factorio ready; standalone NPC actor_id=...` acknowledgement;
9. graceful SIGINT shutdown and `/server-save`;
10. verification that a non-empty save exists.

The script intentionally uses a dummy provider URL/key and does not issue a paid provider request; readiness must not require provider contact.

## Upgrade and rollback

Each successful install stages a new completed release under `.airi/releases/` and only then atomically switches `start-airi.sh`.

When upgrading from an already managed release, the installer records the previous startup target. To restore the most recently recorded completed release:

```bash
bash ./rollback-airi.sh
```

Rollback changes only the managed startup target. It does not rewrite saves, user mods, or `airi-config.json`.

## Why model operation batches are admitted atomically

Separate RCON calls are not a transaction: Factorio may advance a simulation tick between them. A first operation can therefore fail before its supposed dependent operation has entered Autorio's queue.

v8 validates the complete structured `operations` array first and admits the batch in **one epoch-authorized RCON/Lua transaction**. Runtime execution remains asynchronous, but all dependent work exists in Autorio's queue before Factorio advances again, so an owned failure can deterministically cancel the remaining batch.

## Promotion gate to `main`

For the same candidate revision, require:

1. `node deploy/pterodactyl/build-payload.mjs --check`;
2. v8 staging + production-runtime Node tests;
3. injected guard typecheck/build;
4. full zero-player Factorio acceptance harness;
5. generated package smoke on a Docker-capable runner, executing the committed egg loader;
6. existing-save upgrade/rollback check;
7. one real provider-to-NPC goal on the packaged server before calling the deployment production-ready.

Until those external package gates are green, PR #3 remains a draft and `main` remains the last validated checkpoint.
