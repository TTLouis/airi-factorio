# AIRI Factorio — standalone NPC fork

> [!IMPORTANT]
> This repository is an independent fork of [`moeru-ai/airi-factorio`](https://github.com/moeru-ai/airi-factorio). It has diverged toward a **standalone, zero-player AIRI NPC** and a production-oriented Pterodactyl deployment. It is not guaranteed to stay API- or behavior-compatible with upstream.

AIRI can run as a persistent Factorio NPC without owning or impersonating a connected human player. Human players may still talk to the NPC through `!airi ...`, but chat authorization is separate from NPC ownership.

## Current fork status

The Pterodactyl deployment currently includes:

- standalone NPC ownership with zero connected players;
- structured model operations instead of model-generated Lua;
- actor-aware inventory, entity, navigation, crafting, research, and combat operations;
- transactional operation-batch admission and correlated operation outcomes;
- persistent saves plus managed release rollback;
- loopback-only supervisor-owned RCON;
- Pterodactyl console input forwarded to the real Factorio child process;
- reconciliation of `data/server-settings.json` on every startup without overwriting unrelated Factorio settings;
- environment-only provider secrets, with non-secret model/provider settings synchronized into `airi-config.json`;
- provider timeout/recovery handling so a failed model request does not permanently stall the NPC;
- configurable provider request budgeting, currently defaulting to **300 requests/hour** in the Pterodactyl eggs.

The active NPC/E2E development branch is [`feat/npc-transition-work`](https://github.com/TTLouis/airi-factorio/tree/feat/npc-transition-work). The stable integration branch is `main`.

A WIP Docker Compose deployment is being developed separately on [`feat/docker-compose-deployment`](https://github.com/TTLouis/airi-factorio/tree/feat/docker-compose-deployment) so Docker packaging work does not interfere with the ongoing NPC feature history.

## Pterodactyl deployment channels

Two separate eggs are provided so stable servers and active NPC E2E testing cannot be confused:

| Egg | Default source ref | Purpose |
| --- | --- | --- |
| [`deploy/pterodactyl/egg-airi-factorio-server.json`](./deploy/pterodactyl/egg-airi-factorio-server.json) | `main` | Stable/main deployment |
| [`deploy/pterodactyl/egg-airi-factorio-npc-e2e.json`](./deploy/pterodactyl/egg-airi-factorio-npc-e2e.json) | `feat/npc-transition-work` | Active NPC/E2E testing |

### Update behavior

**Restart does not update AIRI code.** A normal server restart keeps the already installed managed release.

**Reinstall resolves the egg's `AIRI_SOURCE_REF` again.** The installer resolves that branch/tag to one exact Git commit SHA, validates and builds that exact snapshot transactionally, records the SHA in the installed manifest, then atomically activates the new release. If installation fails, the previously completed release remains active.

This means the intended workflow is:

```text
push/merge harness changes
        ↓
Pterodactyl Reinstall
        ↓
resolve configured branch to an exact SHA
        ↓
test + build that exact snapshot
        ↓
activate it and record the SHA
```

Set `AIRI_SOURCE_REF` to a full 40-character commit SHA when reproducing a specific E2E failure. Managed installs also provide `rollback-airi.sh` to return to the previously completed release without rewriting saves, user mods, or `airi-config.json`.

See [`deploy/pterodactyl/README.md`](./deploy/pterodactyl/README.md) for import, configuration, testing, and rollback details.

## Docker Compose deployment (WIP)

Docker Compose support currently lives on [`feat/docker-compose-deployment`](https://github.com/TTLouis/airi-factorio/tree/feat/docker-compose-deployment) rather than `main`. It is intentionally a thin deployment wrapper around the same standalone-NPC runtime used by Pterodactyl.

During this early WIP stage, Docker builds locally instead of pulling a published image. The Compose environment mirrors the Pterodactyl egg parameters through `.env`, including provider configuration, chat authorization, Factorio account settings, request budgeting, timeouts, and Factorio version selection.

The current Docker branch defaults to `AIRI_SOURCE_REF=feat/npc-transition-work`. Each build resolves that moving ref to an exact Git commit SHA and builds that exact runtime snapshot; restarting the container does not update code. Persistent saves and runtime state live outside the image under the configured data directory.

To try it now:

```bash
git switch feat/docker-compose-deployment
cp .env.example .env
# Fill in OPENAI_API_KEY, OPENAI_API_BASEURL, and OPENAI_MODEL.
docker compose up -d --build
```

No GHCR image is published yet. Once the runtime is more stable, the same Compose and `.env` contract can switch from local builds to a published image without changing the persistent data layout.

See the [Docker Compose WIP documentation](https://github.com/TTLouis/airi-factorio/blob/feat/docker-compose-deployment/deploy/docker/README.md) for current details.

## Important Pterodactyl defaults

The eggs intentionally do **not** ship a real provider/model configuration:

- `OPENAI_MODEL=replace-me`
- `OPENAI_API_BASEURL=https://provider.invalid/v1`
- `PROVIDER_TIMEOUT_MS=120000`
- `MAX_PROVIDER_REQUESTS_PER_HOUR=300`

`OPENAI_API_KEY` remains environment-only and is never persisted to `airi-config.json`. `OPENAI_MODEL` and `OPENAI_API_BASEURL` are synchronized into the non-secret config on startup so the file reflects the effective Pterodactyl settings.

`FACTORIO_USERNAME` and `FACTORIO_TOKEN` must either both be blank or both be configured. Blank credentials keep the server hidden/private; configured credentials enable the public Factorio listing path. These credentials are not stored in `airi-config.json`.

The current Pterodactyl install/runtime image is `ghcr.io/ptero-eggs/yolks:debian_bookworm`. Pinning that image to an immutable digest remains a hardening roadmap item.

## Development

Install workspace dependencies with:

```bash
pnpm install
```

The standalone-NPC deployment and E2E harness live primarily under:

```text
deploy/pterodactyl/
packages/autorio/
tests/factorio/
```

Useful deployment checks include:

```bash
node deploy/pterodactyl/build-payload.mjs --check
node --test deploy/pterodactyl/build-payload.test.mjs deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
```

The real Factorio harness and package-smoke gates are intentionally separate from provider validation; repository CI does not use production provider credentials.

## Roadmap

Near-term work is focused on deeper NPC E2E coverage and improving the AI harness, alongside the WIP Docker Compose deployment. Longer-term work includes swarm/multi-agent coordination, an in-game message board, richer production-line reasoning, publishing a stable container image, and pinning deployment images by immutable digest.

## Upstream and credits

This fork builds on the original [`moeru-ai/airi-factorio`](https://github.com/moeru-ai/airi-factorio) project and its `autorio` work. See the upstream repository for the original development setup, related Project AIRI projects, and upstream credits.
