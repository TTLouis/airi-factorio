# Pterodactyl standalone-NPC v8 release candidate

The generated `egg-airi-factorio-server.json` is now a v8 standalone-NPC candidate rather than the legacy connected-player package.

## Required gates before merging this checkpoint to `main`

- `node deploy/pterodactyl/build-payload.mjs --check`
- `node --test deploy/pterodactyl/build-payload.test.mjs deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs`
- injected `guard.ts` typecheck/build inside Autorio
- full zero-player Factorio runtime harness
- `deploy/pterodactyl/package-smoke.sh` / `.ps1` clean install in the Bookworm yolk
- package smoke parses and executes the **committed egg installation loader**, not a bypass path
- packaged real Factorio boot with zero connected players
- standalone actor readiness acknowledgement
- graceful `/server-save` + SIGINT shutdown
- valid PTDL_v2 JSON with immutable installer-loader pin and matching payload-source SHA

The runtime installer pins source commit `8879a71b7b74118b1030d8a89aaf4fba3c95ebf6`, which contains the corrected installed-layout v8 supervisor and its process/RCON tests. The compact egg loader separately pins installer artifact commit `2d9ea4cbcd65dcf850a5f6deed49cf5747433571`, which contains the synchronized self-verifying `install.sh` for this payload revision. Both pins are immutable so subsequent feature-branch changes cannot silently alter a published egg.

The egg intentionally does not embed the large bootstrap directly. Its loader downloads the pinned `install.sh`, checks that the bootstrap advertises the expected payload-source SHA-256, then executes it. The bootstrap itself verifies its compressed archive and decompressed installer source before installation.

## Rollback

Every successful upgrade records the previous managed `start-airi.sh` target before atomically activating the new release. `rollback-airi.sh` restores the most recently recorded completed release target without modifying saves, user mods, or `airi-config.json`.

Do not publish this candidate to `main` until the package smoke is green on an external Docker-capable runner.
