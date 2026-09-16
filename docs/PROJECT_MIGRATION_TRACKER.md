# Factorio NPC migration tracker

This tracker covers the transition from the historical `airi-factorio` fork identity to the independent **Factorio NPC** project.

The goal is to preserve useful Git history and MIT attribution while removing tooling, CI, runtime assumptions, and branding that no longer match the headless-first autonomous NPC architecture.

## Ground rules

- Preserve Git history; do **not** rewrite the repository just to hide its origin.
- Preserve upstream MIT attribution and explicitly document the original AIRI/`autorio` lineage.
- Keep cleanup isolated from NPC behavior changes.
- Prove old components unused before deleting them.
- Do not bulk-rename established deployment protocol identifiers such as `AIRI_*` until compatibility aliases/tests exist.
- Factorio simulation state and deterministic helpers are authoritative; vision is optional research infrastructure, not a core runtime dependency.
- Treat the current learning/skill stack as project-owned NPC functionality unless a future audit proves a specific piece is obsolete.

## Phase 0 — Project identity

- [x] Adopt **Factorio NPC** as the project-facing name.
- [x] Define the project as headless-first and standalone-NPC-first.
- [x] Document that CV/YOLO is not required by the current runtime.
- [x] Move root package identity away from `@proj-airi/autorio-workspace`.
- [x] Preserve upstream lineage and MIT attribution.
- [ ] Update the GitHub repository description (requires repository settings access).
- [ ] Rename GitHub repository from `airi-factorio` to `factorio-npc` (requires repository settings access).
- [ ] Use GitHub **Leave fork network** after cleanup is complete (requires repository settings access; this preserves Git branches/commit history but not fork-network metadata such as PR/issue relationships).

## Phase 1 — Active architecture to keep

The following are current project-owned architecture and must remain intact during de-fork cleanup:

- [x] `packages/agent/`
- [x] `packages/autorio/`
- [x] `deploy/pterodactyl/`
- [x] `deploy/docker/`
- [x] `tests/factorio/`
- [x] `packages/tstl-plugin-reload-factorio-mod/` while `packages/autorio` depends on it.
- [x] Current NPC harness/status/architecture/validation docs.
- [x] `factory_area_learning*`, `learning_pipeline*`, `learning_opportunities*`, `skills*`, and `skill_verification*`; commit history confirms these are current Factorio NPC learning/skill work from September 15–16, 2026 rather than inherited AIRI baggage.

## Phase 2 — Legacy AIRI vision/developer stack

Reference audit showed that these components are not part of the current headless NPC runtime. They were removed during the detach cleanup:

- [x] `models/factorio-yolo-v0/`.
- [x] `pixi.toml` / `pixi.lock` YOLO/Python environment.
- [x] `.github/workflows/python.yml`, which existed for the inherited model tree.
- [x] `packages/factorio-rcon-snippets-for-node/` YOLO dataset collector.
- [x] `packages/factorio-rcon-snippets-for-vscode/` YOLO/dev snippets.
- [x] legacy root `docker/` GUI/X11/noVNC-oriented stack; current deployment is `deploy/docker/`.
- [x] `packages/vscode-factorio-rcon-evaluator/` and its root VSCode launch/build hooks.
- [x] `packages/factorio-wrapper/`, superseded by the current supervisor/Pterodactyl runtime.
- [x] Adapt `scripts/bootstrap.ts` so it no longer creates `factorio-wrapper` configuration.
- [x] Rename the devcontainer service/project identity to `factorio-npc`.
- [x] Remove unreferenced upstream README/banner assets (`project-structure.png`, `docs/banner.png`, `docs/banner-1280x640.png`).
- [x] Verify typecheck/tests/build/deployment packaging remain green after syncing the cleanup into `feat/npc-transition-work`.
- [ ] Regenerate `pnpm-lock.yaml` so stale importer entries for deleted workspaces are actually pruned rather than merely tolerated by frozen install.

Vision may return later as a **separate optional sensor package** rather than as a core workspace dependency.

## Phase 3 — Compatibility names still intentionally retained

These names are not proof that the project remains coupled to AIRI. They are compatibility surface and should be migrated separately with aliases/tests instead of being changed during the detach cleanup:

- [x] Migrate `@proj-airi/factorio-agent` to `@factorio-npc/agent` and update root filters.
- [ ] Migrate the TSTL plugin package name away from `@proj-airi/*`; this requires a lockfile-safe dependency rename.
- [ ] `AIRI_*` environment/config variables already used by deployments.
- [ ] Pterodactyl egg filenames and some human-facing labels.
- [ ] runtime/log/config filenames such as `airi-config.json` where deployed servers may already depend on them.
- [ ] old repository URLs in deployment source defaults after GitHub performs the repository rename.
- [ ] internal Factorio compatibility identifiers such as the `autorio` mod id and `autorio_*` remote interfaces; rename only with explicit migration aliases because saves, deployment scripts, tests, or external callers may depend on them.

A future compatibility migration should introduce project-owned names first, keep AIRI/`autorio` aliases for one deprecation window, add tests, then remove aliases only when deployments have migrated.

## Phase 4 — Repository detach

### Preconditions

- [x] Project identity committed to `main`.
- [x] Upstream attribution retained.
- [x] Legacy CV/YOLO/developer-stack cleanup isolated and merged.
- [x] Existing feature branches survived cleanup without history rewriting.
- [x] Cleanup CI is green on `main`.
- [x] Cleanup synced into `feat/npc-transition-work` and its build/typecheck, unit-test, and Pterodactyl staging jobs are green.
- [ ] Finish the small NPC legacy/metadata prune and lockfile regeneration.

### GitHub settings actions

These operations are repository-level administration and are not exposed by the current GitHub connector, so they must be performed in GitHub Settings after the code cleanup is merged:

- [ ] Change repository name: `airi-factorio` -> `factorio-npc`.
- [ ] Change description to: `Headless-first autonomous NPC runtime and planning harness for Factorio servers.`
- [ ] Add topics: `factorio`, `npc`, `llm`, `agents`, `headless`, `factorio-mod`.
- [ ] Choose **Leave fork network**.
- [ ] Confirm all local/deployment clones follow the GitHub redirect or update their remotes explicitly.
- [ ] Verify all branches still exist after detach.

Do **not** delete or recreate the repository to detach it. Use GitHub's supported fork-network detach path so Git history and branches remain intact.

## Phase 5 — Architecture cleanup after detach

This is separate from de-fork identity work and should continue through ordinary feature/audit PRs:

- [x] Confirm the learning/skill subsystem is current project-owned work rather than inherited cleanup material.
- [ ] Audit the learning/skill subsystem for integration boundaries, data ownership, and duplication with deterministic planning helpers, but do not remove it merely because its names look generic.
- [ ] Document `deploy/pterodactyl/staging/` versus `runtime-v8/` source-of-truth layering and remove accidental duplication only where safe.
- [ ] Document production-planning module boundaries and consolidate only true duplication.
- [ ] Keep task-board/project/debug UI as projections of canonical runtime state rather than parallel state stores.
- [ ] Complete single-NPC E2E gates before expanding swarm behavior.
- [ ] Formalize swarm identity, ownership/leases, message board, and lifecycle.

## Validation gates

Cleanup is not considered complete merely because dead files are gone. The relevant checks are:

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

- The project is now **Factorio NPC**, not an AIRI product extension.
- Preferred repository name: `factorio-npc`.
- Primary runtime target: headless Factorio servers.
- Preserve Git history and upstream attribution; do not history-rebase for cosmetic separation.
- YOLO/CV is not a required runtime and is removed from the core repository.
- Existing feature branches must survive repository detach unchanged.
- `factory_area_learning`, `learning_pipeline`, `learning_opportunities`, `skills`, and `skill_verification` are confirmed current Factorio NPC work and are protected from de-fork deletion.
- The Factorio mod id `autorio`, `autorio_*` remote interfaces, and deployed `AIRI_*` names remain compatibility interfaces for now, not project identity.
- GitHub fork-network detach should happen only after cleanup is committed/merged, so important work exists in ordinary Git history rather than only fork-network metadata.
