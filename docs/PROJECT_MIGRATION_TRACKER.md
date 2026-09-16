# Project migration tracker

This tracker covers the transition from the historical `airi-factorio` fork identity to the independent **Factorio NPC** project identity.

The goal is to preserve useful history and attribution while removing runtime, tooling, CI, documentation, and naming that no longer match the headless-first autonomous NPC architecture.

## Migration principles

- Preserve Git history; do **not** rewrite the repository with a history-wide rebase.
- Preserve upstream MIT attribution and origin references.
- Prefer proving a component unused before deleting it.
- Keep cleanup changes isolated from NPC behavior changes.
- Avoid breaking Pterodactyl/Docker deployments only to rename identifiers.
- Migrate compatibility names such as `AIRI_*` gradually and with tests.
- Treat Factorio simulation state and deterministic helpers as authoritative; vision is optional, not required runtime infrastructure.

## Phase 0 — Identity baseline

- [x] Establish `Factorio NPC` as the project-facing name in the root README.
- [x] Describe the current architecture as headless-first, structured-state, standalone NPC runtime.
- [x] Explicitly document that YOLO/CV is not required by the current runtime.
- [x] Update root package metadata away from `@proj-airi/autorio-workspace`.
- [x] Preserve upstream lineage and MIT license attribution.
- [ ] Update GitHub repository description to remove `CV & LLM / YOLO` wording.
- [ ] Rename GitHub repository from `airi-factorio` to `factorio-npc` after code/config references are prepared.
- [ ] Evaluate and, if desired, use GitHub `Leave fork network` after confirming there are no downstream forks or metadata that must be preserved.

## Phase 1 — Inventory: Keep / Adapt / Remove / Replace

### KEEP — active architecture

- [ ] `packages/agent/`
- [ ] `packages/autorio/`
- [ ] `deploy/pterodactyl/`
- [ ] `deploy/docker/`
- [ ] `tests/factorio/`
- [ ] `packages/tstl-plugin-reload-factorio-mod/` while `packages/autorio` still depends on it.
- [ ] Current NPC harness/status/architecture docs.

### ADAPT — useful but still AIRI-named

- [ ] Root and package namespace references (`@proj-airi/*`).
- [ ] `AIRI_*` environment/config identifiers.
- [ ] Pterodactyl egg filenames and human-facing labels.
- [ ] Docker image/test names containing `airi-factorio`.
- [ ] Runtime log prefixes where they are user-facing rather than protocol compatibility.
- [ ] GitHub Actions/release artifact names.
- [ ] Links that assume the old repository name.

Compatibility identifiers should be migrated behind aliases/deprecation windows instead of bulk-renamed in one commit.

### REMOVE CANDIDATES — require reference proof first

- [ ] `models/factorio-yolo-v0/`
- [ ] YOLO-only Python dependencies/tasks in `pixi.toml` and `pixi.lock`.
- [ ] `.github/workflows/python.yml` if it exists only for inherited YOLO/model checks.
- [ ] `packages/factorio-rcon-snippets-for-node/` if no active dev/runtime path imports it.
- [ ] `packages/factorio-rcon-snippets-for-vscode/` if no active workflow depends on it.
- [ ] legacy root `docker/` GUI/Xvfb/noVNC stack if nothing active references it.
- [ ] `packages/vscode-factorio-rcon-evaluator/` if it is no longer used by maintainers.
- [ ] obsolete upstream-only devcontainer/bootstrap pieces after reference audit.

Before deleting each candidate, search its package/path/name through source, scripts, CI, docs, deployment manifests, and lockfiles.

### REVIEW / POSSIBLE REPLACE

- [ ] `packages/factorio-wrapper/`: determine whether current deployments/runtime still use it or whether newer supervisor/Pterodactyl code superseded it.
- [ ] `factory_area_learning.ts`, `learning_pipeline.ts`, `learning_opportunities.ts`: determine whether inherited learning architecture still contributes to the current deterministic harness.
- [ ] `skills.ts` / `skill_verification.ts`: classify current runtime responsibilities versus old agent architecture.
- [ ] `deploy/pterodactyl/staging/` vs `runtime-v8/`: document source-of-truth layering and remove accidental duplication only where safe.
- [ ] production planning modules (`production_planning.ts`, live bridge, candidate enumerator, remote interface, scope helpers): document boundaries and consolidate only actual duplication.
- [ ] task-board/project UI state: ensure canonical runtime state, debug state, and UI projections are not duplicated.

## Phase 2 — Legacy CV / YOLO removal

- [ ] Confirm no runtime import or deployment dependency on `factorio-yolo-v0`.
- [ ] Remove YOLO model source and training/prediction tasks.
- [ ] Remove `ultralytics` and other Python dependencies that exist only for YOLO.
- [ ] Remove Python CI if nothing non-YOLO remains under its scope.
- [ ] Remove dataset-collector helpers that are only used by the YOLO experiment.
- [ ] Regenerate/update lockfiles.
- [ ] Verify TypeScript workspace install/build/test paths are unaffected.

Vision can later return as a separate optional sensor package rather than as a core workspace dependency.

## Phase 3 — Namespace and compatibility migration

- [ ] Select final package namespace strategy.
- [ ] Rename internal packages only where package-manager/tooling value justifies churn.
- [ ] Introduce new environment names for project-owned settings if desired.
- [ ] Keep temporary aliases for established `AIRI_*` deployment variables.
- [ ] Add warnings/documentation for deprecated names before removal.
- [ ] Rename Pterodactyl egg display names and Docker-facing labels.
- [ ] Rename test container/image names.
- [ ] Update repository URLs after GitHub rename.

## Phase 4 — Repository identity change

Preconditions:

- [ ] `main` is green and has a reproducible release/deployment checkpoint.
- [ ] No active automation assumes only the old repository URL.
- [ ] Pterodactyl/Docker source-ref handling is verified against the renamed repository.
- [ ] Release workflows are checked for hard-coded repo/package names.

Actions:

- [ ] Rename repository to `factorio-npc`.
- [ ] Change GitHub description to something similar to: `Headless-first autonomous NPC runtime and planning harness for Factorio servers.`
- [ ] Add topics such as `factorio`, `npc`, `llm`, `agents`, `headless`, `factorio-mod`.
- [ ] Decide whether to leave the GitHub fork network.
- [ ] Verify old GitHub URL redirects as expected.
- [ ] Update local remotes / deployment source defaults / docs.

## Phase 5 — Architectural cleanup after rename

- [ ] Finish duplicate/dead-code audit.
- [ ] Remove compatibility aliases whose deprecation window has ended.
- [ ] Document stable module boundaries for observation, planning, execution, UI, and deployment.
- [ ] Keep deterministic production/throughput constraints local and validated before model exposure.
- [ ] Complete single-NPC E2E gates before expanding swarm behaviors.
- [ ] Formalize swarm primitives: identity, task ownership, leases, message board, and lifecycle.

## Validation gates for cleanup PRs

At minimum, use the checks relevant to the touched area:

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

Heavy Factorio/Pterodactyl smoke should gate deletion of code that could affect real runtime packaging.

## Related projects to monitor

These projects solve adjacent parts of the same problem space and are useful architecture references rather than upstream dependencies:

- `brickfrog/factorio-buddy` — persistent autonomous Factorio companion/NPC.
- Factorio Learning Environment (FLE) — structured/headless Factorio agent evaluation environment.
- `matteomekhail/Agentic-Factorio` — embodied companion/multi-agent coordination ideas.
- Factorio MCP projects — structured external tool/API surface patterns.
- Factorio AI Player projects — deterministic skill layer below LLM strategy.
- factory-layout / optimization research — useful reference for future deterministic layout candidate evaluation.

## Decision log

### 2026-09-16

- Project identity should move away from AIRI as the product name.
- Preferred working name: **Factorio NPC** / repository `factorio-npc`.
- Do not history-rebase the repository solely for identity separation.
- Preserve upstream history and attribution.
- Headless Factorio is the primary runtime target.
- YOLO is not part of the required runtime; treat it as a removal candidate and, if ever revived, an optional sensor/research mode.
