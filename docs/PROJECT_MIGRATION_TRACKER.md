# Factorio NPC migration tracker

This tracker covers the transition from the historical `airi-factorio` fork identity to the independent **Factorio NPC** project.

The goal is to preserve useful Git history and MIT attribution while removing tooling, runtime assumptions, and branding that no longer match the headless-first autonomous NPC architecture.

## Ground rules

- Preserve Git history; do **not** rewrite history to hide project origin.
- Preserve upstream MIT attribution and document the original AIRI/`autorio` lineage.
- Keep cleanup isolated from NPC behavior changes.
- Prove old components unused before deleting them.
- Do not bulk-rename established deployment protocol identifiers such as `AIRI_*` until compatibility aliases/tests exist.
- Factorio simulation state and deterministic helpers are authoritative; vision is optional research infrastructure, not a core runtime dependency.

## Phase 0 — Project identity

- [x] Adopt **Factorio NPC** as the project-facing name.
- [x] Define the project as headless-first and standalone-NPC-first.
- [x] Document that CV/YOLO is not required by the current runtime.
- [x] Move root workspace identity away from `@proj-airi/autorio-workspace`.
- [x] Move the agent package identity to `@factorio-npc/agent`.
- [x] Preserve upstream lineage and MIT attribution.
- [x] Rename the GitHub repository from `airi-factorio` to `factorio-npc`.
- [x] Update the GitHub repository description.
- [x] Leave the GitHub fork network.

Verified after detach on 2026-09-16: the repository is `TTLouis/factorio-npc`, GitHub reports `fork: false`, the old `parent`/`source` relationship is gone, and all project branches remain present.

## Phase 1 — Active architecture to keep

The following are current project-owned architecture and must remain intact during de-fork cleanup:

- [x] `packages/agent/`
- [x] `packages/autorio/`
- [x] `deploy/pterodactyl/`
- [x] `deploy/docker/`
- [x] `tests/factorio/`
- [x] `packages/tstl-plugin-reload-factorio-mod/` while `packages/autorio` depends on it.
- [x] Current NPC harness/status/architecture/validation docs.
- [x] Current learning/skill work: `factory_area_learning*`, `learning_pipeline*`, `learning_opportunities*`, `skills*`, and `skill_verification*`.

The learning/skill subsystem was added as current Factorio NPC work and is **not** upstream baggage.

## Phase 2 — Legacy AIRI vision/developer stack

The following inherited components were removed after reference audit showed they were not part of the current headless NPC runtime:

- [x] `models/factorio-yolo-v0/`.
- [x] `pixi.toml` / `pixi.lock` YOLO/Python environment.
- [x] `.github/workflows/python.yml` used by the inherited model tree.
- [x] `packages/factorio-rcon-snippets-for-node/` YOLO dataset collector.
- [x] `packages/factorio-rcon-snippets-for-vscode/` YOLO/dev snippets.
- [x] legacy root `docker/` GUI/X11/noVNC stack; current deployment is `deploy/docker/`.
- [x] `packages/vscode-factorio-rcon-evaluator/` and old root VSCode launch/build hooks.
- [x] `packages/factorio-wrapper/`, superseded by the current supervisor/Pterodactyl runtime.
- [x] `scripts/bootstrap.ts` no longer creates `factorio-wrapper` configuration.
- [x] Devcontainer service/project identity moved to Factorio NPC.
- [x] Cleanup passed TypeScript build/typecheck, unit tests, and Pterodactyl runtime/staging CI before merge.

Vision may return later as a **separate optional sensor package** rather than as a core workspace dependency.

## Phase 3 — Compatibility names intentionally retained

These identifiers are compatibility surface, not evidence that the repository is still coupled to AIRI. Migrate them separately with aliases/tests instead of changing them cosmetically during detach:

- [ ] `@proj-airi/tstl-plugin-reload-factorio-mod` internal package name.
- [ ] `AIRI_*` environment/config variables already used by deployments.
- [ ] Pterodactyl egg filenames and selected human-facing labels.
- [ ] Runtime/log/config filenames such as `airi-config.json` where deployed servers may depend on them.

A future compatibility migration should introduce Factorio NPC names first, keep AIRI aliases for a deprecation window, add tests, then remove aliases.

## Phase 4 — Post-detach repository references

- [x] Root `package.json` repository URL points to `TTLouis/factorio-npc`.
- [x] Root test filters use `@factorio-npc/agent`.
- [x] Agent package metadata uses the Factorio NPC identity.
- [ ] Regenerate `pnpm-lock.yaml` with a normal `pnpm install` to prune stale importer records left by deleted workspaces. Current CI installation remains green, so this is cleanup rather than a runtime blocker.
- [ ] Repin the immutable Pterodactyl installer payload to the renamed repository.

### Pterodactyl repin requirement

The Pterodactyl deployment chain intentionally pins an immutable installer payload by commit SHA and checksum. Some pinned/generated scripts still contain the historical `TTLouis/airi-factorio` repository URL. GitHub rename redirects currently preserve behavior, but the deployment should not rely on that redirect indefinitely.

Do **not** replace those strings ad hoc. The safe sequence is:

1. Commit a new `deploy/pterodactyl/payload-src/installer.sh` using `TTLouis/factorio-npc` source URLs.
2. Use that commit SHA as the new `PAYLOAD_REF` in `deploy/pterodactyl/build-payload.mjs`.
3. Update the generator test expectation to the new repository slug.
4. Regenerate `deploy/pterodactyl/install.sh` and both generated egg JSON files.
5. Run `node deploy/pterodactyl/build-payload.mjs --check` and the full Pterodactyl CI suite before merge.

This preserves the existing immutable-loader/checksum security model.

## Phase 5 — Architecture cleanup after detach

This is separate from repository identity work and should continue through ordinary feature/audit PRs:

- [ ] Document `deploy/pterodactyl/staging/` versus `runtime-v8/` source-of-truth layering and remove accidental duplication only where safe.
- [ ] Document production-planning module boundaries and consolidate only true duplication.
- [ ] Keep task-board/project/debug UI as projections of canonical runtime state rather than parallel state stores.
- [ ] Complete single-NPC E2E gates before expanding swarm behavior.
- [ ] Formalize swarm identity, ownership/leases, message board, and lifecycle.
- [ ] Review the learning/skill subsystem for architecture quality only; do not treat it as de-fork cleanup.

## Validation gates

Cleanup is not considered complete merely because old files are gone. Relevant checks are:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm --filter autorio.ts build
node deploy/pterodactyl/build-payload.mjs --check
node --test deploy/pterodactyl/build-payload.test.mjs deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
docker compose config
pnpm test:npc
```

Heavy Factorio/Pterodactyl smoke remains authoritative for runtime packaging behavior.

## Decision log

### 2026-09-16

- The project is **Factorio NPC**, not an AIRI product extension.
- Repository: `TTLouis/factorio-npc`.
- Primary runtime target: headless Factorio servers.
- GitHub fork-network detach completed successfully without losing project branches.
- Preserve Git history and upstream attribution; do not history-rebase for cosmetic separation.
- YOLO/CV is not a required runtime and was removed from the core repository.
- The current learning/skill pipeline is project-owned work and must be preserved.
- AIRI-named deployment compatibility interfaces remain until a tested compatibility migration replaces them.
