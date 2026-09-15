# Docker Compose deployment (WIP)

This deployment wrapper is intentionally separate from the active NPC implementation branch. The Docker image is built locally and resolves `AIRI_SOURCE_REF` to an exact Git commit during the build, so the deployment branch does not need to carry the NPC runtime history.

## Quick start

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY, OPENAI_API_BASEURL, and OPENAI_MODEL.
docker compose up -d --build
```

Persistent server state is stored in `${AIRI_DATA_DIR:-./data}`. This includes saves, `airi-config.json`, `data/server-settings.json`, mods, and AIRI runtime state.

Follow logs with:

```bash
docker compose logs -f airi-factorio
```

To attach the terminal directly to Factorio stdin through the AIRI supervisor:

```bash
docker attach "$(docker compose ps -q airi-factorio)"
```

Use Docker's normal detach sequence (`Ctrl-p`, `Ctrl-q`) instead of `Ctrl-c` if you want the server to keep running.

## Source selection

During early development, `.env.example` defaults to:

```text
AIRI_SOURCE_REF=feat/npc-transition-work
```

The Docker build resolves that ref to an exact SHA and bakes that exact AIRI runtime into the local image. Restarting the container does not update code. To move to a newer commit, rebuild:

```bash
docker compose up -d --build
```

An exact 40-character commit SHA can also be used for reproducible builds. When the NPC runtime is promoted to `main`, the default can change to `main` without changing the Compose/runtime configuration contract.

## Configuration boundary

The Compose environment mirrors the Pterodactyl egg's runtime parameters. Provider and Factorio credentials stay in `.env`/container environment; `OPENAI_API_KEY` is not persisted to `airi-config.json`. `FACTORIO_USERNAME` and `FACTORIO_TOKEN` are written only where Factorio requires them in `data/server-settings.json`.

Leave both Factorio account fields blank for a private/unlisted server. Set both to enable public listing.

## Factorio version

`FACTORIO_VERSION` is a build-time setting because the current WIP image includes the selected official Factorio headless build. Supported values follow the existing deployment installer: `latest`, `experimental`, or an exact `2.0.x` release.

Changing `FACTORIO_VERSION` requires rebuilding the image.

## Shutdown

`docker stop` sends `SIGTERM` to the AIRI supervisor. The existing supervisor shutdown path cancels AIRI work, saves Factorio, and stops the child process. Compose gives it a 90-second grace period by default.

## Notes

- This is a WIP local-build deployment; no GHCR image is published yet.
- The container intentionally uses `linux/amd64`, matching the current tested Factorio/Pterodactyl runtime.
- RCON remains internal to the container and is not exposed on the host.
- The legacy top-level `docker/` directory is not used by this deployment.
