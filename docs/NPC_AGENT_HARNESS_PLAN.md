# AIRI Factorio — NPC Agent Harness Roadmap

This is the current single-NPC roadmap. Historical pass-by-pass plans are retained under `docs/validation/` and should not be treated as current release gates.

## Current checkpoint

The project has moved beyond the original "prove a zero-player character can wait/move/mine/craft" transition phase. The standalone-NPC architecture is now the baseline being prepared for promotion to `main`.

As of the 2026-09-16 promotion cleanup, `feat/npc-transition-work` had a green ordinary CI at commit `02167ac690c46b056ba2f0a62db056438c702419`. The branch is long-lived and continues to move, so any actual promotion must freeze and record a fresh candidate SHA before heavyweight validation.

## Promotion goal

Promote a **validated standalone-NPC baseline** to `main` without claiming that every experimental capability on the integration branch has equivalent E2E coverage.

A promotion checkpoint must preserve these baseline properties:

- AIRI owns a standalone Factorio `character`, not a connected human body;
- zero-player simulation and NPC operation remain supported;
- model mutations use bounded structured operations;
- real inventory/crafting/mining/research/combat/navigation semantics remain engine-backed;
- task completion/cancellation releases physical controls safely;
- restart/death/replacement invalidate stale logical work rather than silently continuing it;
- Pterodactyl install/update/rollback remains transactional;
- environment/Egg configuration remains authoritative over `airi-config.json`;
- ordinary CI is green on the candidate;
- package smoke and real Factorio integration pass for the frozen promotion candidate.

## Validation ladder

Use the cheapest deterministic layer that can actually prove the behavior:

```text
unit/type/contract test
        ↓
compiled/generated-artifact checks
        ↓
real Factorio deterministic harness
        ↓
packaged deployment smoke / upgrade / rollback
        ↓
real provider E2E when the behavior specifically depends on model interaction
```

Do not substitute lower layers for higher layers when the failure mode is engine-, process-, package-, or provider-specific.

## Near-term single-NPC work

### 1. Promotion cleanup and baseline freeze

- keep ordinary CI green;
- reconcile main-only documentation/deployment changes without discarding them;
- archive superseded staging/release notes as historical validation records;
- freeze one candidate SHA;
- run heavyweight Pterodactyl/package and real-Factorio promotion gates;
- promote only after those gates pass.

### 2. E2E harness and observability

Turn real gameplay failures into reproducible regressions. Prefer fixes in observations, tools, runtime semantics, receipts, recovery, and deterministic game knowledge over indefinitely expanding the system prompt.

The detailed learning/bootstrap E2E sequence and acceptance gates are maintained in `docs/NPC_LEARNING_BOOTSTRAP_E2E.md`. That document is the handoff for fresh-start research progression, automated red science, skill verification/reuse, and the later Coal Snake discovery benchmark.

Keep end-to-end behavior traceable:

```text
player request
→ model/provider turn
→ observations/tools
→ structured plan/actions
→ operation admission
→ Factorio execution/result
→ verification/replan
```

Do not log hidden chain-of-thought. Persist only operational plan/state, receipts, safe provider metadata, and explicit model-visible content.

### 3. Map-first remote interaction

For operations Factorio can legitimately perform from map/remote-view semantics, build and validate the map-side primitive before designing vehicle/train/space-platform behavior around local character movement.

The map foundation includes exact entity references, construction/ghost placement, rotation/orientation, deconstruction, upgrade, and other bounded operations with explicit verification.

### 4. Deterministic production planning

The planning path should continue to move game facts out of LLM guesswork and into deterministic tools/contracts.

The intended checkpoint order is:

```text
autorio_planning remote interface
→ contract test
→ CI
→ ordinary-agent solveProduction tool
→ prompt integration
→ Pterodactyl policy/tests
```

Only after that baseline is validated should the planner rely on validated inserter throughput, belt-lane capacity, stacking capacity, and similar transport constraints. Do not pass unverified throughput guesses to the model.

### 5. Vehicle / train / space-platform interaction

Build these on top of validated map and actor primitives. Avoid creating a second ad-hoc control architecture for each transport type.

### 6. Swarm / multi-agent coordination

Swarm work remains a separate layer. Single-NPC ownership, receipts, exact actor identity, map operations, and deterministic planning should be solid before swarm coordination becomes part of the main baseline.

## What is not required for the next main promotion

The next promotion does **not** require:

- perfect autonomous factory design;
- complete production-line reasoning;
- swarm readiness;
- every map primitive to be finished;
- vehicle/train/space-platform support;
- production provider calls in repository CI.

It does require that the promoted baseline accurately documents which capabilities are verified, partially verified, or experimental.
