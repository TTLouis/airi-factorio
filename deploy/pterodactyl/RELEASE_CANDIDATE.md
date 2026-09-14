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

The immutable installer payload is commit `c60728afc4d348d9739a3c7de70bec86cc9c708a`, whose `payload-src/installer.sh` has SHA-256 `c5ae9291b5d8ce16deb4356b20e0c1b2629ff350794393c61500dac8f3836170`. That installer pins runtime source `f0a0420d7a16cb6b48855c12538013ba112ec6c5` and revision `2026-09-14.4`.

The runtime pin includes the real-Factorio first-Lua-command confirmation fix. Configure admission now repeats the exact same command at most once when the achievement warning blocks execution, and accepts success only when the response contains the acknowledgement marker followed by parseable JSON. An echoed command containing the session or marker text is not treated as execution proof.

`install.sh` and the egg deliberately share one compact loader. The loader downloads the immutable human-readable installer payload directly, verifies its SHA-256, and only then executes it. This avoids mutable branch fetches, nested bootstrap pins, and gzip/zlib reproducibility as release concerns.

## Rollback

Every successful upgrade records the previous managed `start-airi.sh` target before atomically activating the new release. `rollback-airi.sh` restores the most recently recorded completed release target without modifying saves, user mods, or `airi-config.json`.

Do not publish this candidate to `main` until the package smoke is green on an external Docker-capable runner.
