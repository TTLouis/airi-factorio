# Pterodactyl standalone-NPC v8 release candidate

The generated `egg-airi-factorio-server.json` is now a v8 standalone-NPC candidate rather than the legacy connected-player package.

## Required gates before merging this checkpoint to `main`

- `node deploy/pterodactyl/build-payload.mjs --check`
- `node --test deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs`
- injected `guard.ts` typecheck/build inside Autorio
- full zero-player Factorio runtime harness
- `deploy/pterodactyl/package-smoke.sh` clean install in the Bookworm yolk
- packaged real Factorio boot with zero connected players
- standalone actor readiness acknowledgement
- graceful `/server-save` + SIGINT shutdown
- generated `install.sh` embedded in the egg exactly

The installer pins source commit `8879a71b7b74118b1030d8a89aaf4fba3c95ebf6`, which contains the corrected installed-layout v8 supervisor and its process/RCON tests. The generated artifacts are intentionally source-pinned so subsequent feature-branch changes do not silently alter a published egg.

## Rollback

Every successful upgrade records the previous managed `start-airi.sh` target before atomically activating the new release. `rollback-airi.sh` restores the most recently recorded completed release target without modifying saves, user mods, or `airi-config.json`.

Do not publish this candidate to `main` until the package smoke is green on an external Docker-capable runner.
