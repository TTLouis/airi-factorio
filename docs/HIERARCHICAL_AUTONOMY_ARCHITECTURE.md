# Hierarchical autonomy architecture

This document records the intended long-horizon autonomy model for the standalone SGLuna NPC runtime. It is a design contract and roadmap direction, not a claim that every layer described here is already implemented.

The north-star use case is an NPC that can pursue a goal as large as completing Factorio without forcing one provider turn to reason about the entire game, without flattening every horizon into one giant plan, and without moving strategic/domain knowledge into brittle harness scripts.

## Naming

- **SGLuna** is the project/runtime identity.
- Each spawned NPC has its own display identity, for example **Vale-1**.
- Product-level UI may say `SGLuna NPC Console` or `SGLuna Debug`.
- Actor-facing UI and conversation should use the current NPC display name, for example `Prompt Vale-1`.
- Internal runtime/project names should not leak into human-facing plan text as if they were world entities or locations.

## Hierarchy

Long-horizon work should be represented as four distinct layers:

```text
Project / Goal
    ↓
Milestone
    ↓
Plan Step
    ↓
Operation
```

These layers are intentionally different in scope and authority.

### Project / Goal

The durable user-level objective.

Examples:

- Reach Automation.
- Establish a self-sustaining factory.
- Launch a rocket.

The project goal may remain active for hours. It should not be flattened directly into dozens or hundreds of execution steps.

### Milestone

A bounded strategic outcome that can take minutes or longer but has a meaningful, verifiable result.

Examples:

- Establish burner-era production.
- Reach Automation.
- Establish electric mining and smelting.
- Automate red and green science.

Milestones are the bridge between long-term strategy and the currently executable plan.

### Plan Step

A short-horizon, goal-bearing unit inside the active milestone.

Examples:

- Gather stone for the first furnaces.
- Establish reliable iron plate production.
- Build the first lab.
- Produce enough science packs for Automation.

Plan steps are the primary unit shown in Plan Tracker and the primary unit for completion/checkpoint reasoning.

### Operation

A concrete engine-backed action admitted by the runtime, such as:

- walk;
- mine;
- craft;
- place;
- transfer;
- configure;
- research.

Operations are execution details. They are not substitutes for human-readable plan steps.

## Project Board vs Plan Tracker

The UI should eventually expose both a **Project Board** and the existing **Plan Tracker**, with different responsibilities.

### Project Board

The Project Board answers:

> What long-term outcome is this NPC pursuing, what milestone is active, and what broad development direction is it following?

It should show:

- project/goal title;
- completed milestone history;
- current milestone;
- a small rolling window of likely upcoming milestones;
- current development direction;
- current strategic focus.

Future milestones are **tentative**. The board should use a rolling horizon rather than committing to a complete rocket-launch roadmap at task start.

A useful rule is:

```text
completed history
current milestone
next 1-3 likely milestones
future beyond that: unspecified / replan later
```

### Plan Tracker

Plan Tracker answers:

> What bounded work is the NPC doing now to complete the active milestone?

It should show the current plan-step sequence and completion state.

Current plan steps are a much harder execution contract than future Project Board milestones. Once a step is active, completion/checkpoint semantics must not disappear just because the model prefers a different wording or strategy.

In short:

```text
Project Board = soft future strategic intent
Plan Tracker  = hard current execution contract
```

## Human-facing plan language

Plan entries are both execution/planning semantics and user-visible labels. The model should write them as concise natural-language intentions rather than operation dumps.

Prefer:

```text
Gather enough stone for the first furnaces
Establish reliable iron plate production
Prepare science packs for Automation
```

Avoid:

```text
Mine stone near AIRI
walk_to_entity
mine_entity
craft furnace
```

Natural wording must preserve checkpoint-relevant facts such as item, quantity, target, or desired result. Humanization must never weaken completion semantics.

The intended separation is conceptual:

```text
semantic intent / checkpoint semantics → Jev + runtime
human-readable display wording        → Main LLM
operation execution                   → Autorio/runtime
```

Do not spend a separate provider call only to polish plan wording.

## Jev role

Jev should remain a judge/router, not become a second gameplay planner.

The core boundary is:

> Jev decides whether the current problem is framed correctly and what kind of decision is required. The Main LLM decides the actual gameplay strategy.

Jev may classify, verify, wait, escalate, or request decomposition. It should not choose concrete factory layouts, exact tactical actions, or production solutions that belong to the Main LLM.

## Jev decision taxonomy

Jev decisions should be distinguished by family rather than collapsed into one generic `replan` or `continue` decision.

### 1. Granularity

Question:

> Is the current objective at the right level for direct planning/execution?

Suggested outputs:

- `keep` — current scope is appropriately bounded;
- `split` — current scope is too broad and should be decomposed;
- `collapse` — the current decomposition is unnecessarily fragmented and can be simplified.

Jev should decide **whether** decomposition is required. The Main LLM should decide **how** to decompose it.

Examples:

- `Gather 20 stone` → usually `keep`.
- `Reach Automation` → may require one milestone with multiple plan steps depending on current state.
- `Launch a rocket` → definitely requires milestone decomposition.

Do not allow unbounded recursive nesting. The intended hierarchy is fixed at:

```text
Goal → Milestone → Plan Step → Operation
```

### 2. Development direction

Question:

> What kind of progress does the current situation call for?

Suggested outputs:

- `vertical`;
- `horizontal`;
- `maintain`;
- `recover`.

#### Vertical development

Vertical development means advancing the current critical path toward the active milestone by unlocking a required capability or removing a prerequisite blocker.

Its defining intent is:

> Remove the blocker on the current critical path.

Examples may include research, a new production capability, a prerequisite machine, or extra production if that extra production is itself the blocker preventing the milestone.

#### Horizontal development

Horizontal development means strengthening an already-available capability when the critical path exists but is too weak, fragile, narrow, or poorly supplied for sustained progress.

It can include:

- capacity;
- redundancy;
- logistics;
- coverage;
- buffers;
- additional resource access;
- throughput;
- reliability.

Its defining intent is:

> Strengthen an existing capability for future or sustained demand.

Do **not** reduce the distinction to "technology = vertical" and "factory expansion = horizontal". The classification is relative to the active milestone and the reason the work is needed.

For example, adding more iron smelting may be vertical if insufficient iron throughput is the current milestone blocker, while the same expansion may be horizontal if the current path is already viable and the goal is resilience or future scale.

#### Maintain

The current architecture/plan remains valid and no strategic redirection is needed. Continue ordinary execution, deterministic waiting, feeding, crafting, mining, transfer, or other bounded progress.

#### Recover

The world has invalidated the plan or capability and the immediate task is to restore a valid state.

Examples:

- death;
- destroyed production;
- exhausted resource access;
- stale exact entity identity;
- lost power;
- a previously valid plan step becoming impossible.

Recovery is not merely horizontal development.

### 3. Completion / outcome

Question:

> What does current evidence say about the active step or milestone?

Suggested outputs:

- `incomplete`;
- `progress`;
- `completed`;
- `invalidated`.

Completion must be based on authoritative world/runtime evidence, not merely the presence of an operation such as `mining` or `crafting`.

Jev may help define or select useful checkpoints, but runtime code remains responsible for evaluating whether a supported structured condition is actually true.

### 4. Execution routing

Question:

> Does the Main LLM need to wake up now?

Suggested outputs:

- `wait_runtime`;
- `continue_runtime`;
- `wake_planner`.

Deterministic passive progress such as smelting, crafting queues, research progress, or another already-started process should not wake the Main LLM simply because no new action is required this instant.

### 5. Reasoning budget

Question:

> If the Main LLM must be called, how much decision budget is appropriate for this decision?

Suggested semantic levels:

- `micro`;
- `normal`;
- `deep`;
- `strategic`.

These are semantic budget classes, not universal provider parameters. The runtime must map them to provider/model-specific controls.

For example, one provider may map `deep` to a reasoning-effort parameter while another may require a larger output budget or different configuration.

Task length alone must not determine reasoning depth. A multi-hour goal may contain many trivial decisions, waits, or deterministic executions that require no Main LLM call at all.

## Observation budget and planning horizon

Reasoning budget should not be considered in isolation.

A difficult decision may legitimately require more than one independent read-only fact, while a trivial decision should not receive an unrestricted observation window.

A future Jev decision envelope may therefore include:

```json
{
  "main_llm": "call",
  "reasoning_budget": "deep",
  "observation_budget": 3,
  "planning_horizon": "subgoal"
}
```

Suggested planning-horizon classes:

- `immediate` — next concrete action/step;
- `checkpoint` — enough planning to reach the current verification point;
- `subgoal` — enough planning to finish the current milestone-sized problem;
- `strategic` — high-level milestone/project direction.

The runtime remains the final authority on provider/tool budgets and safety limits.

## Decision order

Jev should avoid answering every decision family when an earlier answer already resolves the situation.

A useful evaluation order is:

```text
1. Is the current step/milestone complete?
2. Is the current scope still valid in the live world?
3. Is the granularity appropriate?
4. What development direction is needed?
5. Can runtime continue/wait, or must the planner wake?
6. If the planner wakes, what reasoning/observation/horizon budget is justified?
```

Example: a furnace is already smelting and the checkpoint is not yet satisfied.

```text
completion  → incomplete
validity    → valid
granularity → keep
direction   → maintain
routing     → wait_runtime
Main LLM    → skipped
```

Example: the active milestone is blocked by inadequate iron production.

```text
completion  → incomplete
validity    → valid
granularity → keep
direction   → vertical (critical-path blocker)
routing     → wake_planner
budget      → deep
```

## Dynamic decomposition

Task decomposition should not be completely fixed at the beginning of a long goal.

A milestone that originally appeared directly executable may reveal missing prerequisite structure after new world evidence arrives.

Example:

```text
Milestone: Reach Automation
        ↓
observe live state
        ↓
no furnace / no iron production / no viable science path
        ↓
Jev: current scope needs prerequisite decomposition
        ↓
Main LLM creates bounded milestone/plan structure
```

Jev may request `split` or `wake_planner`; the Main LLM owns the concrete new milestone names and gameplay strategy.

Likewise, if the player or world already satisfied a planned prerequisite, the system should be able to skip or collapse unnecessary work based on authoritative evidence rather than mechanically replaying the original sequence.

## Milestone completion

Milestone completion should ultimately be based on outcome state, not only on "every planned step was executed in order."

For example, a milestone such as "Establish burner production" may be considered complete when the required production capabilities are observably available, even if a player manually satisfied one prerequisite or the planner found a different valid path.

Plan-step completion remains individually auditable, but the milestone is an outcome contract rather than a script transcript.

## Retry and escalation

Reasoning budget must not stick at a high level forever.

A useful future policy is:

```text
normal decision fails repeatedly → deep
deep decision discovers major strategic conflict → strategic
successful execution/progress → decay back toward normal/micro
```

Keep bounded retry/escalation counts. Do not allow endless same-budget retries or permanent `strategic` mode after one hard decision.

## Proposed V1

Do not implement the entire hierarchy as a recursive tree engine first.

A practical V1 is:

```text
Project Goal
    ↓
Current Milestone
    ↓
existing Plan Tracker steps
    ↓
operations
```

Add only enough durable state to represent:

- project/goal title;
- current milestone id/title;
- milestone completion summary/contract;
- a small list of tentative next milestones;
- current development direction;
- existing plan steps.

For Jev, start with explicit, separately traceable decision families rather than one monolithic response.

A minimal initial set is:

```text
granularity: keep | split | collapse
development: vertical | horizontal | maintain | recover
completion: incomplete | progress | completed | invalidated
routing: wait_runtime | continue_runtime | wake_planner
reasoning_budget: micro | normal | deep | strategic
```

The first implementation should preserve current Task Board and Plan Tracker compatibility while layering milestone/project state above them.

## Non-goals

This design must not:

- turn Jev into a second full gameplay planner;
- encode a hardcoded Factorio progression script in the harness;
- require a full rocket roadmap at task creation;
- make future milestones as authoritative as the current execution contract;
- classify development direction solely by building/technology type;
- wake the Main LLM for deterministic passive progress;
- apply one provider's reasoning parameter names universally;
- erase checkpoint/completion evidence merely because a replan occurs;
- create unlimited recursive subtask depth.

## Intended end state

The long-horizon control loop should resemble:

```text
User goal
   ↓
Main LLM creates strategic direction
   ↓
Project Board / current milestone
   ↓
Jev judges granularity, progress, direction, and routing
   ↓
Main LLM creates or revises a bounded plan when needed
   ↓
Plan Tracker
   ↓
Jev verifies / waits / escalates
   ↓
Autorio + deterministic runtime execute
   ↓
authoritative world evidence
   ↓
repeat
```

The desired behavior is not for the Main LLM to reason maximally on every turn. The desired behavior is for the system to keep the problem at the correct level, skip the Main LLM when deterministic progress is enough, and spend deeper reasoning only at genuine strategic or uncertain decision points.
