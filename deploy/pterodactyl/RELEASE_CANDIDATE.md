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
- valid PTDL_v2 JSON with the same immutable checksummed installer loader as `install.sh`

The immutable installer payload is commit `5e56255fcfcd9f79e21838d452c20de3dbed829c`, whose `payload-src/installer.sh` has SHA-256 `014e965de0cb1e753bb42d992d10ba9762e7abe0681da020a3ed9c6e5949eb1f`. That installer pins runtime source `c5dc39e57285695f122603dbafc9abf4e0a2ef81` and revision `2026-09-14.5`.

The runtime pin includes the real-Factorio first-Lua-command confirmation fix and a production Source-RCON integration fixture that reproduces that first-command warning. Configure admission repeats the exact same command at most once when the achievement warning blocks execution, and accepts success only when the response contains the acknowledgement marker followed by parseable JSON. An echoed command containing the session or marker text is not treated as execution proof.

`install.sh` and the egg deliberately share one compact loader. The loader downloads the immutable human-readable installer payload directly, verifies its SHA-256, and only then executes it. This avoids mutable branch fetches, nested bootstrap pins, and gzip/zlib reproducibility as release concerns.

## Rollback

Every successful upgrade records the previous managed `start-airi.sh` target before atomically activating the new release. `rollback-airi.sh` restores the most recently recorded completed release target without modifying saves, user mods, or `airi-config.json`.

Do not publish this candidate to `main` until the package smoke is green on an external Docker-capable runner.
