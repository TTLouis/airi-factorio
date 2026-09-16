# Pterodactyl standalone-NPC v8 release candidate

The generated `egg-airi-factorio-server.json` is now a v8 standalone-NPC candidate rather than the legacy connected-player package.

## Required gates before merging this checkpoint to `main`

- `node deploy/pterodactyl/build-payload.mjs --check` — PASS
- `node --test deploy/pterodactyl/build-payload.test.mjs deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs` — PASS (56/56, verified in a Linux `node:24-bookworm` container; the native-spawn test only runs under a real shebang-capable shell, so it fails under a direct Windows host run and must be checked in Linux/Docker or CI)
- `pnpm --filter autorio.ts run test` / `typecheck` / `build` — PASS (155/155 tests)
- injected `guard.ts` typecheck/build inside Autorio — PASS
- full zero-player Factorio runtime harness (`tests/factorio/Dockerfile` + `tests/factorio/run.sh`) — PASS (70 Python regressions + core/research-combat/resilience lanes, including a mid-run Factorio restart that preserves owned native crafting state)
- `deploy/pterodactyl/package-smoke.ps1` clean install in the Bookworm yolk — PASS
- package smoke parses and executes the **committed egg installation loader**, not a bypass path — confirmed
- packaged real Factorio boot with zero connected players — confirmed (`AIRI Factorio ready; standalone NPC actor_id=...`)
- standalone actor readiness acknowledgement — confirmed
- graceful `/server-save` + SIGINT shutdown — confirmed (`AIRI Factorio stopped cleanly`, non-empty save produced)
- valid PTDL_v2 JSON with the same immutable checksummed installer loader as `install.sh` — confirmed
- existing-save upgrade/rollback check — PASS (real Docker volume: install, upgrade-install over it, `rollback-airi.sh` restored the prior release's `start-airi.sh` target; pre-existing saves, mods, and `airi-config.json` were untouched throughout)

The immutable installer payload is commit `92afd659485f5cb47a912615e669332c85ef9d12`, whose `payload-src/installer.sh` has SHA-256 `7bcddbab0e959d505a156269340fa2de2fe4c837bc83b0fc9d9f7b6df58dfff1`. That installer pins runtime source `ad3e87523b157880a360e773de68519e49f809f0` and revision `2026-09-14.22`.

## Production provider validation (deferred, not a merge blocker)

Every gate above is **engineering/package validated** without any real provider credentials — package smoke and the zero-player Factorio harness use a dummy `OPENAI_API_KEY`/URL and never issue a paid provider request, because standalone NPC readiness and runtime correctness do not require provider contact.

**Production provider validation is pending**: running one real provider-to-NPC goal against a packaged server with a real OpenAI-compatible API key. This is intentionally deferred to production deployment, is not exercised by repository CI or package smoke, and is not a merge blocker for this branch.

## Deferred hardening roadmap

The Pterodactyl install/runtime image remains `ghcr.io/ptero-eggs/yolks:debian_bookworm` by tag. Pinning that image to an immutable digest is still a roadmap hardening item and is intentionally not part of this promotion checkpoint.

## Root cause of the package smoke failure this checkpoint fixes

The previously reported package smoke failure (`FAIL candidate=042bae6...`) traced back to two distinct bugs, found by adding real diagnostics and validating against an actual Factorio server rather than the local unit-test fixture:

1. **`airi_deployment.configure` lost its `session` argument to an implicit Lua `self` parameter.** It was declared as a standalone `function configure(mode, session) {...}` referenced by shorthand in the `remote.add_interface('airi_deployment', {...})` table. TypeScriptToLua could not prove that binding is never used as a method, so it compiled with an implicit leading parameter — `remote.call` has no receiver to bind, so every argument shifted by one and `session` arrived as `nil`. Declaring the handler directly as an inline table value (matching every sibling handler: `status`, `authorize`, `cancel`, `disable`) removed the implicit parameter; verified directly against the compiled `control.lua`.
2. **Nothing ever generates the chunks around the force's spawn position when zero human players connect.** `get_npc_actor()` now calls `surface.request_to_generate_chunks` + `surface.force_generate_chunk_requests` before `create_entity` if the target chunk isn't already generated, so standalone NPC creation doesn't depend on a player having joined first.

A separate, unrelated bug was also found and fixed along the way: `packages/agent/src/parser.ts`'s `parseChatMessage` referenced an undefined `playerRegex` (the regex was declared as `playerChatRegex`), so every non-server chat line threw a `ReferenceError` instead of parsing.

Configure admission still repeats the exact same command at most once when the achievement warning blocks execution on a save's first Lua command, and accepts success only when the response contains the acknowledgement marker followed by parseable JSON. An echoed command containing the session or marker text is not treated as execution proof. This mechanism was itself verified working correctly against real Factorio during the investigation — it was never the actual bug.

`install.sh` and the egg deliberately share one compact loader. The loader downloads the immutable human-readable installer payload directly, verifies its SHA-256, and only then executes it. This avoids mutable branch fetches, nested bootstrap pins, and gzip/zlib reproducibility as release concerns.

## Rollback

Every successful upgrade records the previous managed `start-airi.sh` target before atomically activating the new release. `rollback-airi.sh` restores the most recently recorded completed release target without modifying saves, user mods, or `airi-config.json`.

## Windows development note

This repo is developed from both Windows and Linux. Two things only work correctly on Linux (matching the Bookworm install/runtime image and GitHub Actions' `ubuntu-latest` runners):

- The `runtime-v8.test.mjs` fixture spawns a fake Factorio executable via a `#!/usr/bin/env node` shebang; Windows cannot exec that directly (`ENOENT`), so that one test fails under a native Windows `node --test` run. It passes under Linux/Docker (verified in `node:24-bookworm`) and under CI.
- The package smoke test must run through `package-smoke.ps1` on Windows (uses `docker.exe` argument arrays directly), not `package-smoke.sh` through Git Bash — Git Bash's MSYS path auto-conversion mangles the `-v host:container` bind-mount arguments passed to `docker run`.
