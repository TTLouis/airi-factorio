# AIRI Factorio — standalone NPC fork

> [!IMPORTANT]
> This repository is an independent fork of [`moeru-ai/airi-factorio`](https://github.com/moeru-ai/airi-factorio). It has diverged toward a **standalone, zero-player AIRI NPC** and production-oriented deployment/runtime tooling. It is not guaranteed to stay API- or behavior-compatible with upstream.

AIRI can run as a persistent Factorio NPC without owning or impersonating a connected human player. Human players may still talk to the NPC through `!airi ...`, but chat authorization is separate from NPC ownership.

## Current fork status

The standalone-NPC baseline includes:

- zero-player NPC ownership backed by a real Factorio `character`;
- structured model operations instead of model-generated Lua;
- actor-aware inventory, entity, navigation, crafting, research, and combat operations;
- transactional operation-batch admission and correlated operation outcomes;
- persistent saves plus managed release rollback;
- loopback-only supervisor-owned RCON;
- Pterodactyl console input forwarded to the real Factorio child process;
- startup reconciliation of `data/server-settings.json` without overwriting unrelated Factorio settings;
- environment-only provider secrets, with effective non-secret provider settings synchronized into `airi-config.json`;
- provider timeout/recovery handling so one failed request does not permanently stall the NPC;
- configurable provider request budgeting, currently defaulting to **300 requests/hour** in the Pterodactyl eggs;
- bounded behavior tracing for E2E/debugging;
- an in-game task/plan UI used by the current NPC harness.

`main` is the stable integration/deployment baseline. [`feat/npc-transition-work`](https://github.com/TTLouis/airi-factorio/tree/feat/npc-transition-work) is the active single-NPC integration/E2E branch and the current source of promotion candidates. A green feature-branch HEAD is not automatically equivalent to a promoted release: heavyweight package/Factorio gates are run for promotion checkpoints.

Capabilities on the integration branch can be newer than the main baseline. In particular, map operations, production-planning helpers, learning/skill work, UI work, and other experimental harness features may have narrower validation than the core standalone-NPC lifecycle.

## Validation model

For engine behavior, real Factorio integration evidence is authoritative. Unit/type tests protect contracts and regressions, but they do not by themselves prove Factorio runtime semantics.

The current promotion model is:

```text
feature/integration work
        ↓
ordinary CI + deterministic regressions
        ↓
freeze a candidate SHA
        ↓
package smoke + real zero-player Factorio harness
        ↓
promote validated checkpoint to main
```

Historical validation records live under [`docs/validation/`](./docs/validation/). Current single-NPC roadmap/status live in [`docs/NPC_AGENT_HARNESS_PLAN.md`](./docs/NPC_AGENT_HARNESS_PLAN.md) and [`docs/NPC_AGENT_HARNESS_STATUS.md`](./docs/NPC_AGENT_HARNESS_STATUS.md).

## Pterodactyl deployment channels

Two PTDL_v2 eggs keep stable deployments separate from active E2E work:

| Egg | Default source ref | Purpose |
| --- | --- | --- |
| [`deploy/pterodactyl/egg-airi-factorio-server.json`](./deploy/pterodactyl/egg-airi-factorio-server.json) | `main` | Stable/main deployment |
| [`deploy/pterodactyl/egg-airi-factorio-npc-e2e.json`](./deploy/pterodactyl/egg-airi-factorio-npc-e2e.json) | `feat/npc-transition-work` | Active NPC/E2E testing |

### Update behavior

**Restart does not update AIRI code.** A normal server restart keeps the already installed managed release.

**Reinstall resolves the egg's `AIRI_SOURCE_REF` again.** The installer resolves the configured branch/tag/ref to one exact Git commit SHA, validates and builds that exact snapshot transactionally, records the SHA in the installed manifest, and only then activates it. A failed install leaves the previous completed release active.

Set `AIRI_SOURCE_REF` to a full 40-character commit SHA when reproducing a specific E2E failure. Managed installs also provide `rollback-airi.sh` to return to the previous completed release without rewriting saves, user mods, or `airi-config.json`.

See [`deploy/pterodactyl/README.md`](./deploy/pterodactyl/README.md) for import, configuration, testing, runtime, and rollback details.

## Docker Compose deployment (WIP)

Docker Compose support is now included in the active integration line through [`compose.yml`](./compose.yml) and [`deploy/docker/`](./deploy/docker/). It is intentionally a thin deployment wrapper around the standalone-NPC runtime rather than a second runtime implementation.

During this WIP stage, Docker builds locally instead of pulling a published application image. The Compose environment mirrors the Pterodactyl parameters through `.env`, including provider configuration, chat authorization, Factorio account settings, request budgeting, timeouts, and Factorio version selection.

`.env.example` currently follows `feat/npc-transition-work`. Each build resolves that moving ref to an exact Git commit SHA and bakes that exact runtime into the image; restarting the container does not update source. Persistent saves and runtime state live outside the image under the configured data directory.

To try the WIP deployment:

```bash
cp .env.example .env
# Fill in OPENAI_API_KEY, OPENAI_API_BASEURL, and OPENAI_MODEL.
docker compose up -d --build
```

No stable GHCR application image is published yet. See [`deploy/docker/README.md`](./deploy/docker/README.md) for source pinning, configuration, persistence, console attach, and shutdown details.

## Important Pterodactyl defaults

The eggs intentionally do **not** ship a real provider/model configuration:

- `OPENAI_MODEL=replace-me`
- `OPENAI_API_BASEURL=https://provider.invalid/v1`
- `PROVIDER_TIMEOUT_MS=120000`
- `MAX_PROVIDER_REQUESTS_PER_HOUR=300`

`OPENAI_API_KEY` remains environment-only and is never persisted to `airi-config.json`. `OPENAI_MODEL` and `OPENAI_API_BASEURL` are synchronized into the non-secret config on startup so the file reflects the effective deployment settings.

`FACTORIO_USERNAME` and `FACTORIO_TOKEN` must either both be blank or both be configured. Blank credentials keep the server hidden/private; configured credentials enable the public Factorio listing path. These credentials are not stored in `airi-config.json`.

The current Pterodactyl install/runtime image is `ghcr.io/ptero-eggs/yolks:debian_bookworm`. Pinning that image to an immutable digest remains a hardening item.

## Development

Install workspace dependencies with:

```bash
pnpm install
```

The standalone-NPC runtime and E2E/deployment harness live primarily under:

```text
deploy/pterodactyl/
deploy/docker/
packages/agent/
packages/autorio/
tests/factorio/
```

Useful deployment checks include:

```bash
node deploy/pterodactyl/build-payload.mjs --check
node --test deploy/pterodactyl/build-payload.test.mjs deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
```

The heavyweight Pterodactyl release workflow additionally runs package smoke and a real zero-player Factorio harness. Repository CI does not use production provider credentials.

## Roadmap

Near-term work is deeper single-NPC E2E coverage, map-first remote interaction primitives, and deterministic production-planning constraints. Vehicle/train/space-platform work should build on the map-control foundation rather than bypass it. Swarm/multi-agent coordination remains a later, separately validated layer.

## Upstream and credits

This fork builds on the original [`moeru-ai/airi-factorio`](https://github.com/moeru-ai/airi-factorio) project and its `autorio` work. See the upstream repository for the original development setup, related Project AIRI projects, and upstream credits.
