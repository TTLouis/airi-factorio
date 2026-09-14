# AIRI Factorio — Pterodactyl deployment

This directory contains this fork's Pterodactyl deployment for the standalone AIRI Factorio NPC.

## Current state

The Factorio runtime has a **user-verified standalone-NPC baseline**: the parallel zero-player `core`, `research-combat`, and `resilience` lanes pass, including real restarts, death recovery, navigation, native crafting ownership/reconciliation, research follow-through, combat, actor-mode boundaries, and explicit operation outcomes.

The checked-in [`egg-airi-factorio-server.json`](egg-airi-factorio-server.json) is now a **generated v8 standalone-NPC release candidate**, not the previous connected-player v7 package. The installed runtime is pinned to source commit `76615f72a3a69390c5104601046d6fecb51f12f8`, including the real-Factorio first-Lua-command confirmation regression, acknowledgement-based retry, production Source-RCON fixture for that warning path, and the spawn-chunk-generation fix for zero-player worlds.

The packaged Docker smoke (`deploy/pterodactyl/package-smoke.ps1`) is green on this candidate: clean install through the committed egg loader, packaged Factorio boot with zero connected players, standalone NPC readiness, graceful save, and clean shutdown all verified. See [`RELEASE_CANDIDATE.md`](RELEASE_CANDIDATE.md) for the full gate list and root-cause writeup.

## What v8 changes

- zero-player NPC ownership through native `autorio_actor` mode/status;
- actor ID/kind/epoch authorization instead of connected-player ownership;
- `AIRI_CHAT_PLAYERS` is chat authorization only and never actor ownership;
- strict structured model `operations`, with no model-generated Lua or legacy `operationCommands`;
- actor-aware observations for inventory, entities, navigation, crafting, research and combat;
- exact correlated research-request lookup;
- full-plan validation before mutation;
- **atomic dependency-batch admission** so Factorio cannot advance a tick between dependent operations from one model plan;
- acknowledgement-based first-Lua-command handling: the exact configure command is repeated once only when Factorio's achievement warning blocks execution, and echoed command text is not accepted as an acknowledgement;
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
| Chat authorization | `AIRI_CHAT_PLAYERS` | who may issue `!airi ...`: blank/`*` = everyone, `none` = disabled, or a comma-separated exact-name allowlist |
| Provider credential | `OPENAI_API_KEY` | required; hidden and never written to `airi-config.json` |
| Model | `OPENAI_MODEL` | OpenAI-compatible model identifier |
| Provider URL | `OPENAI_API_BASEURL` | HTTPS OpenAI-compatible API base URL |
| Save | `SAVE_NAME` | optional explicit save name; blank chooses newest or creates `airi-world.zip` |
| Factorio account | `FACTORIO_USERNAME` / `FACTORIO_TOKEN` | both blank = hidden server; both set = published through Factorio's public matching service; hidden and never written to `airi-config.json` |
| Provider budget | `MAX_PROVIDER_REQUESTS_PER_HOUR` | persisted hourly request cap |
| Shutdown timeout | `SHUTDOWN_TIMEOUT_MS` | save/stop timeout before forced termination |
| Factorio version | `FACTORIO_VERSION` | `latest`, `experimental`, or an exact supported `2.0.x` |

There is deliberately no `AIRI_PLAYER` actor-ownership variable in the v8 egg. Zero connected humans is valid. `AIRI_CHAT_PLAYERS` defaults to blank, which allows every player to issue `!airi` chat requests; set it to `none` to disable in-game AIRI commands entirely, or to a comma-separated list of exact player names for an allowlist. The legacy single-name `AIRI_CHAT_PLAYER` variable is still accepted as a fallback when `AIRI_CHAT_PLAYERS` is unset, for existing installs.

`FACTORIO_USERNAME` and `FACTORIO_TOKEN` must both be set or both left blank; supplying only one fails startup rather than silently publishing or discarding the credential. Neither is ever logged, persisted to `airi-config.json`, or included in the release manifest.

## Generated artifacts

- [`payload-src/installer.sh`](payload-src/installer.sh) — human-readable installer source of truth. The current release payload is frozen at immutable commit `867031bf2364ffdc4359545f59a0daac5eb710f5` with SHA-256 `d0224f5af1ec5ade147b20a41917f8acc2f5470920a0fd9b25a32970ac769470`.
- [`build-payload.mjs`](build-payload.mjs) — generator and integrity/drift checker.
- [`install.sh`](install.sh) — small generated loader that downloads the immutable payload source, verifies its SHA-256, and executes it.
- [`egg-airi-factorio-server.json`](egg-airi-factorio-server.json) — PTDL_v2 egg embedding that **same loader exactly**.

The loader is intentionally small. Both entry points use one immutable Git commit plus one expected payload SHA-256, removing gzip/zlib reproducibility and nested bootstrap-pin drift from the release chain.

Regenerate/check with:

```bash
node deploy/pterodactyl/build-payload.mjs
node deploy/pterodactyl/build-payload.mjs --check
```

`--check` validates the local installer source contract, verifies the checked-in `install.sh` against the expected immutable loader, parses the egg as JSON, and requires the egg to embed the exact same loader and schema.

The loader supports a non-installing integrity probe:

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
3. immutable loader `--verify-only` against the pinned installer payload;
4. clean transactional installation **through the egg's identical loader** into a disposable server volume;
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
6. existing-save upgrade/rollback check.

Gates 1-6 are **engineering/package validated** and gate merge readiness. See [`RELEASE_CANDIDATE.md`](RELEASE_CANDIDATE.md) for the current pass/fail state of each.

A separate, later concern is **production provider validation**: running one real provider-to-NPC goal against a packaged server with real OpenAI-compatible credentials. This is intentionally deferred to production deployment and is not part of gates 1-6 — no production credentials are used in repository CI or package smoke, and standalone NPC readiness/runtime correctness do not require provider contact. It is an operational checklist item for whoever deploys the egg, not a merge blocker for this repository.
