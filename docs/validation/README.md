# Validation history

This directory contains historical evidence and superseded checkpoint documents. Files here are intentionally immutable descriptions of the commit/state they were written for; they are not the current roadmap or deployment manual.

Current documentation lives in:

- `../../README.md` — project overview and branch/deployment model;
- `../NPC_AGENT_HARNESS_PLAN.md` — current single-NPC roadmap and promotion gates;
- `../NPC_AGENT_HARNESS_STATUS.md` — current verified status and known limits;
- `../NPC_CHARACTER_ARCHITECTURE.md` — stable actor/body architecture;
- `../../deploy/pterodactyl/README.md` — current Pterodactyl operation/deployment contract.

Historical records currently include the original NPC harness plan/status snapshots, the v7→v8 Pterodactyl staging design, the 2026-09-14 v8 release-candidate record, and user-supplied runtime transcripts.

When a new promotion checkpoint is validated, add a new dated file here. Do not rewrite an older record to make it describe a newer commit.
