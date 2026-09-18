# SGLuna Jev decision-layer architecture

Status: experimental design
Branch: `experiment/jev-agent-architecture`
Base at branch creation: `feat/npc-transition-work@c42f4ca5109cd33839fe759dae834634c653f132`

## Purpose

This document records the intended architecture for integrating TypeSafe Jev into the standalone Factorio NPC without replacing the main reasoning model or losing SGLuna's conversational personality.

The goal is not "replace the LLM with Jev". The goal is to split the current agent workload into layers so that:

- Jev handles frequent, low-latency, typed decisions;
- the main reasoning model keeps long-horizon planning and difficult replanning;
- a conversational path can preserve natural human interaction without giving that path world-mutation authority;
- the harness becomes less prescriptive about strategy and recovery policy;
- deterministic Factorio/runtime code remains authoritative for safety, identity, lifecycle, admission, execution, and world truth.

This is also an opportunity to move more semantic authority back toward the model stack. The harness should provide grounded capabilities, bounded observations, receipts, lifecycle guarantees, and hard safety invariants. It should avoid becoming the place where increasingly specific gameplay strategy and conversational routing policy are encoded.

## Design principle

The intended split is:

```text
                         player message
                              |
                              v
                     +------------------+
                     | Jev decision lane|
                     | typed / low cost |
                     +--------+---------+
                              |
             +----------------+----------------+
             |                |                |
             v                v                v
       conversation        planning         control/recovery
          lane              lane               lane
             |                |                |
             v                v                v
      conversational      reasoning        deterministic
           model            model             runtime
             |                |                |
             +----------------+----------------+
                              |
                              v
                            SGLuna
                              |
                              v
                        Factorio world
```

A more precise authority statement is:

> Models decide intent, strategy, and when more reasoning is needed. The runtime decides what is valid, what actually happened, and what may mutate the world.

"Less harness" therefore does **not** mean removing validation or letting model output become authoritative world state. It means reducing deterministic code that tries to make semantic decisions that a model can make better from grounded evidence.

## Three model lanes

### 1. Jev decision lane

Jev is a structured decision provider, not the personality and not the primary planner.

Initial responsibilities:

- classify a player message into a small typed intent set;
- decide whether an event should continue locally or wake the expensive planner;
- select among bounded recovery/escalation choices;
- decide whether current evidence is sufficient or another observation is needed;
- eventually decide whether a deterministic completion can continue without a full reasoning turn.

Representative outputs:

```text
interaction_route =
  continue_current
  status_query
  amend_current
  new_goal
  cancel_current
  chat_only

post_operation =
  continue
  observe
  retry
  replan
  escalate

completion_assessment =
  insufficient_evidence
  local_continue
  planner_required
  candidate_complete
```

These should be typed decisions with bounded choices, not free-form action generation.

Jev should not initially:

- generate Factorio operation arguments;
- choose arbitrary prototype names from memory;
- directly mutate the Task Board;
- write player-visible prose;
- declare world facts without runtime evidence;
- bypass operation admission;
- own actor identity or lifecycle state.

### 2. Main reasoning/planning lane

The existing reasoning-capable provider remains responsible for tasks that actually require planning.

Examples:

- turning a high-level goal into an executable plan;
- resolving production dependencies;
- choosing among grounded prototype/capability candidates;
- revising a plan after meaningful world changes;
- handling ambiguous multi-step tasks;
- deciding strategy when several valid approaches exist;
- requesting the observations/tools required to ground those decisions.

The planner should gain **more semantic authority**, not less.

Where the runtime currently accumulates gameplay-specific policy because the planner is too expensive to call for every small decision, Jev can become the cheap gate that decides when to let the planner act. That lets the deterministic harness focus on capabilities and invariants instead of becoming a second planner.

### 3. Conversation/personality lane

Human-facing conversation must remain separate from control authority.

This lane exists so SGLuna can answer naturally without waking the full planning loop for every casual question and without giving a lightweight chat response permission to mutate the world.

Example:

```text
Player:
"what are you doing?"

Jev route:
conversation

conversation context:
{
  current_goal,
  current_step,
  runtime_phase,
  last_verified_result,
  blocker_or_wait_reason
}

Conversational model:
"I'm waiting for the iron plates right now. Once they're ready I'll continue with the drills."
```

The conversation model is allowed to verbalize authoritative runtime/task state. It is not allowed to fabricate new state or execute operations.

If a message that begins as conversation actually changes the goal, Jev should route it to the planner rather than letting the talker reinterpret it.

## Authority boundaries

### Factorio / deterministic runtime remains authoritative for

- live world state;
- exact entity identity and stale-identity rejection;
- actor/session identity;
- operation admission and argument validation;
- execution of structured operations;
- physical reach and engine semantics;
- task cancellation and lifecycle serialization;
- Pause / Terminate / New Task authority;
- operation receipts and deterministic verification;
- persistence boundaries;
- provider cancellation/timeouts;
- secret handling and provider transport constraints.

These are not candidates for "give the LLM more authority".

### Model stack becomes authoritative for

- semantic interpretation of user intent;
- strategic planning;
- selecting among grounded alternatives;
- deciding when a plan needs revision;
- choosing whether an unexpected result is locally recoverable versus planner-worthy;
- deciding when additional observation is useful;
- conversational framing and personality.

### Harness should progressively stop owning

- large trees of semantic retry/replan heuristics;
- gameplay strategy that is not required for safety or engine correctness;
- model-specific assumptions that can be represented as provider capability/configuration;
- conversational routing rules that can be expressed as a bounded learned decision;
- scenario-specific tactical policy that belongs in skills/model reasoning rather than the general execution harness.

The test for a harness rule should be:

> Is this a correctness/safety invariant that must always hold, or is it a judgment about what the agent should do?

If it is the first, keep it deterministic.
If it is the second, prefer Jev, the planner, or a reusable skill unless deterministic behavior is required for a specific engine contract.

## Current code mapping

The current runtime already has a useful seam.

### Existing main planner path

`deploy/pterodactyl/runtime-v8/supervisor.mjs` wires the main `provider` into `NpcAgentLoop`.

That provider should remain unchanged in the first Jev experiment.

### Existing interaction-provider path

`NpcAgentLoop` already receives a separate `interactionProvider`.

The current interaction route sends a compact state payload containing data such as:

- player message;
- sender;
- current goal;
- current task/runtime state.

That is the best first Jev integration point because it is already:

- isolated from the main planner trace;
- tool-free;
- bounded;
- intended to return a classification rather than a long plan.

The first experiment should therefore replace only the **interaction classification decision**, not the planner and not player-visible response generation.

### Existing deterministic runtime

The structured operation parser, preflight/admission checks, task manager, task controllers, exact identity handling, lifecycle gates, and Factorio-side execution remain unchanged in the initial experiment.

## Proposed provider abstraction

Add a provider role distinct from the existing main provider:

```text
plannerProvider
interactionDecisionProvider
conversationProvider
```

The first implementation can map these roles as:

```text
plannerProvider             -> existing OpenAI-compatible reasoning provider
interactionDecisionProvider -> TypeSafe Jev
conversationProvider        -> existing provider initially, split later
```

Do not force Jev behind the OpenAI chat-completions contract if its native API is structurally different. Prefer a small internal decision-provider interface that expresses what SGLuna actually needs.

Conceptually:

```ts
decisionProvider.evaluate({
  state,
  questions,
  signal,
  timeoutMs,
  traceContext
})
```

The runtime should normalize Jev's response into its own small internal decision schema.

Provider-specific request/response encoding belongs in the provider adapter, not in `NpcAgentLoop`.

## First Jev contract: interaction routing

Input should be compact and grounded.

Example conceptual state:

```json
{
  "message": "bro why are you just standing there",
  "sender": "Louis",
  "current_goal": "build 20 electric mining drills",
  "task_status": "waiting",
  "current_step": "smelt iron plates",
  "active_operation": null,
  "has_blocker": false
}
```

Decision:

```text
route =
  continue_current
  status_query
  amend_current
  new_goal
  cancel_current
  chat_only
```

The Phase 1 contract intentionally distinguishes `status_query` from `chat_only`: status can be answered from authoritative task/runtime state, while casual conversation belongs to the future personality lane. `cancel_current` also remains explicit because cancellation has lifecycle authority. A future `planner_question`-style escalation belongs to planner wake/sleep or recovery routing rather than being treated as a human-message intent in the current contract.

Rules:

- Jev returns a route, not prose.
- The decision must be validated against the known enum.
- Invalid/unavailable Jev output falls back safely to the existing routing path or the planner.
- No Jev decision can directly execute an operation.
- Cancellation must follow the same request/lifecycle authority as the existing interaction path.

## Second Jev contract: post-operation routing

After interaction routing proves stable, Jev can evaluate a bounded runtime outcome.

Example state:

```json
{
  "goal": "build a mining outpost",
  "current_step": "place electric mining drill",
  "operation": "place_candidate",
  "result": "rejected",
  "reason": "not_placeable",
  "retry_count": 1,
  "world_changed": true,
  "plan_has_remaining_steps": true
}
```

Decision:

```text
next =
  retry_local
  observe
  continue_plan
  replan
  escalate_to_planner
```

This is where Jev can allow the harness to shrink over time.

A deterministic failure should still be represented precisely by the runtime. Jev decides what reasoning path to take next; it does not redefine the failure.

## Third Jev contract: planner wake/sleep

Once the first two contracts are reliable, Jev may decide whether a full planner turn is necessary after a deterministic completion.

Example:

```text
operation completed
      |
      v
Jev:
  current plan still grounded?
  next action already fully parameterized?
  new observation required?
  planner reasoning required?
      |
      +--> local continuation
      +--> bounded observation
      +--> planner
```

This should target expensive "wake the planner just to say continue" turns.

It should not silently advance semantic Task Board steps merely because an operation completed. Operation completion and semantic step completion remain separate evidence claims.

## Conversation design

The "human vibe" should be an explicit product surface rather than an accidental side effect of the planner.

The conversation provider should receive a compact projection of authoritative state, for example:

- SGLuna personality instructions;
- recent player dialogue;
- current goal;
- current visible plan step;
- current runtime phase;
- recent verified receipts;
- blocker/wait reason;
- optionally a small current-world summary if needed.

It should not receive the full Factorio tool surface by default.

Its output should be player-visible text only.

For messages that request or imply world changes, the conversation lane should hand back to the decision router/planner instead of acting.

This separation lets the conversational model be optimized for responsiveness, style, and continuity while the planner is optimized for reasoning.

## Reducing harness policy safely

Jev should not be used as justification for deleting deterministic safeguards.

A safe reduction order is:

1. identify an existing heuristic that produces a semantic choice;
2. preserve the exact observations and receipts that feed that heuristic;
3. express the choice as a bounded decision schema;
4. run Jev in shadow mode and compare decisions without changing behavior;
5. promote that specific decision contract from shadow to active-with-fallback after evidence justifies it; this is a per-contract rollout state, not a global Jev enabled flag;
6. preserve a deterministic fallback/escalation path;
7. only then remove duplicated heuristic policy if the model path is stable.

Good candidates:

- interaction intent classification;
- retry versus observe versus planner escalation;
- whether a deterministic completion requires another full planning round;
- whether a world change is material enough to invalidate the current plan.

Bad candidates:

- whether an exact entity ID is stale;
- whether a placement collides;
- whether an operation is authorized;
- whether a lifecycle command can race another lifecycle command;
- whether the actor is still the same NPC;
- whether an engine operation actually completed.

## Fallback behavior

Jev is an optimization and decision layer, not a single point of failure.

If Jev is:

- disabled;
- unconfigured;
- rate limited;
- timed out;
- unavailable;
- returning malformed data;
- returning an unknown choice;

the runtime should take a conservative fallback path.

For V1, the preferred fallback is the existing interaction/planner route rather than inventing a new deterministic policy.

The experiment must remain usable with no decision-provider credentials configured.

## Configuration

Jev credentials must remain environment-only and must never be persisted into canonical `sgluna-config.json`, legacy compatibility config, or traces.

There is deliberately **no separate enabled flag**. The decision provider is present when a decision-provider API key is present, and absent when it is not. Missing decision-provider credentials must never prevent an otherwise valid SGLuna server from starting.

TypeSafe's documented native API is:

```text
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
model: jev-latest
```

The repository accepts the official `TYPESAFE_API_KEY` name and the provider-generic `DECISION_PROVIDER_API_KEY` alias. Experimental tuning variables are:

```text
DECISION_PROVIDER_API_KEY=        # optional; TYPESAFE_API_KEY is also accepted
DECISION_PROVIDER_API_URL=https://api.typesafe.ai/v1/systemone
DECISION_PROVIDER_MODEL=jev-latest
DECISION_PROVIDER_TIMEOUT_MS=5000
MAX_DECISION_PROVIDER_REQUESTS_PER_HOUR=180
DECISION_PROVIDER_MAX_INPUT_CHARS=16000
DECISION_PROVIDER_MAX_QUESTIONS=16
```

The API key is runtime-only. The URL/model/limits are also intentionally environment-owned during the experiment rather than being written into the compatibility `airi-config.json`.

Do not add these to the stable Main egg until the experimental branch has a working end-to-end path.

### Credit conservation from the first call

Jev is inexpensive, but the integration should still be efficient by construction:

- send one compact shared state instead of planner history;
- batch independent questions that use the same state into one System One request;
- cap the entire serialized decision request before transport;
- cap question count;
- use a separate decision-provider hourly request budget rather than consuming the planner budget;
- do not automatically retry provider HTTP failures;
- use the `usage.input_tokens` / `usage.output_tokens` fields returned by TypeSafe for observability;
- during shadow rollout, call Jev only at the bounded decision seam being evaluated rather than mirroring every runtime event.

TypeSafe explicitly recommends asking same-state questions together because they are evaluated in parallel. The goal is therefore to conserve **requests and repeated state tokens**, not to artificially force every workflow into one question.

## Cost model and experiment economics

The economic target is **not to minimize Jev calls**. Jev should be used freely enough to prevent unnecessary expensive planner work, while remaining bounded against runaway loops.

As of 2026-09-18, TypeSafe publishes Jev pricing at **$0.042 per 1M input tokens ($42 per billion); output tokens are free**:
<https://typesafe.ai/blog/introducing-system-one-models-and-jev>

At that published input price, a $5 promotional balance corresponds to roughly **119 million input tokens**. Illustrative SGLuna workloads:

| Workload | Jev input / gameplay hour | Approx cost / gameplay hour | Approx hours from $5 |
| --- | ---: | ---: | ---: |
| 60 calls/hour × 1k input tokens | 60k | $0.00252 | ~1,984 h |
| 60 calls/hour × 2k input tokens | 120k | $0.00504 | ~992 h |
| 180 calls/hour × 4k input tokens | 720k | $0.03024 | ~165 h |

These are planning estimates, not billing authority. Promotional credits may have expiration or account-specific terms. Runtime observability should prefer provider-reported `usage.cost` when present and must not hard-code the published token price as billing truth.

The optimization objective is therefore:

> spend cheap Jev decisions when they remove or shorten expensive planner work; treat the hourly Jev request cap primarily as runaway-loop protection, not as a reason to wake the planner unnecessarily.

### Metrics required for real E2E evaluation

The experiment should make it possible to compute:

- Jev calls per task and per active gameplay hour;
- Jev input/output tokens per call and cumulatively;
- provider-reported Jev cost per call and cumulatively;
- Jev cost per active gameplay hour;
- latency distribution;
- shadow agreement/disagreement with the currently active router;
- planner wakes explicitly caused by the decision layer;
- planner calls explicitly skipped by the decision layer;
- planner input/output tokens avoided after Jev becomes active;
- task correctness, recovery frequency, and real Factorio completion rate.

Do **not** claim a saved planner call from a shadow decision. Shadow mode is counterfactual evidence only. A planner call counts as avoided only when an active Jev-controlled path explicitly emits a `planner.skipped` event with decision-provider attribution. Likewise, planner escalation should emit an attributed `planner.wake` event.

The live Debug projection keeps the latest Jev call separate from cumulative Jev experiment totals. Per-gameplay-hour reporting should use active task/gameplay intervals from traces rather than wall-clock server uptime, so idle servers do not make the economics look artificially cheap.

## Observability

We need enough visibility to answer:

- Was Jev invoked?
- Which decision contract was used?
- What bounded choice did it return?
- How long did it take?
- Did the decision wake the planner?
- Did fallback occur?
- How many planner turns were avoided?
- Did downstream deterministic execution accept or reject the result?

Do not log secrets.
Do not log hidden chain-of-thought.
Prefer compact state/decision metadata and redact user text where appropriate.

Decision trace events:

```text
decision.request
decision.response
decision.fallback
decision.route_applied
planner.wake
planner.skipped
conversation.request
conversation.response
```

During the experiment, Jev decision lifecycle events are written to a dedicated `logs/sgluna-decision.jsonl` stream (overridable with `SGLUNA_DECISION_TRACE_FILE`) rather than being folded into the planner's `logs/sgluna-behavior.jsonl` request trace. The decision trace records bounded contract/mode, route, confidence, latency, normalized usage/cost, agreement, and fallback metadata; it does not copy the full player message or credentials. The existing provider trace remains distinct so request-cumulative planner usage is not confused with decision-layer usage.

## Rollout plan

Current branch status: Phase 0 is implemented, and Phase 1 shadow interaction-routing plumbing is implemented but still awaiting real E2E trace evidence. Phases 2-6 remain design targets and must not be inferred as active from the presence of telemetry counters.

### Phase 0 - documentation and seam

- define decision-provider interface;
- define typed decision schemas;
- keep existing behavior unchanged;
- add implicit credential-based configuration and bounded request validation;
- add tests for fallback and cancellation.

### Phase 1 - shadow interaction routing

- call Jev for interaction classification;
- record its route;
- continue using the existing route for behavior;
- compare disagreements;
- verify latency and failure behavior.

### Phase 2 - active interaction routing

- Jev becomes the primary classifier;
- malformed/unavailable response falls back;
- main planner remains unchanged;
- player-visible conversation still uses the existing model path.

### Phase 3 - explicit conversation lane

- split natural-language response generation from planning;
- give the talker authoritative compact state;
- give it no Factorio mutation tools;
- route goal-changing language back to planning.

### Phase 4 - post-operation decision routing

- introduce bounded `continue / observe / retry / replan / escalate` decisions;
- start in shadow mode;
- replace only semantic harness heuristics, never deterministic correctness checks.

### Phase 5 - planner wake/sleep optimization

- use Jev to avoid unnecessary full planner turns after deterministic receipts;
- measure planner-turn reduction and task correctness;
- keep semantic Task Board completion evidence strict.

### Phase 6 - harness simplification

Only after the model path is proven:

- remove redundant semantic heuristics;
- move scenario strategy into skills/model reasoning;
- keep deterministic engine and lifecycle invariants;
- document every removed ownership rule in architecture tests/docs.

## Acceptance criteria for the first implementation

The first real Jev change is successful when:

- with no decision-provider API key, Jev is absent with no behavior change;
- Jev credentials never enter persisted config or logs;
- interaction classification can call Jev directly;
- Jev output is schema/enum validated;
- timeout/cancel follows current request lifecycle semantics;
- Jev cannot execute Factorio operations;
- a Jev failure falls back safely;
- the main planner remains untouched;
- existing task lifecycle and desync regressions stay green;
- trace output can distinguish Jev decisions from planner provider rounds.

## Non-goals

The initial Jev experiment does not:

- replace the main reasoning model;
- replace Factorio-side deterministic execution;
- weaken operation validation;
- give Jev arbitrary tool access;
- move Task Board authority into a provider;
- redesign combat;
- redesign bootstrap/production planning;
- redesign swarm coordination;
- require public benchmark publication;
- require Jev for normal server startup.

## Long-term target

The desired architecture is not a "smarter harness".

It is a **thinner, more trustworthy harness around a more capable model stack**:

```text
Factorio
  = truth + physics + authoritative mutation

runtime harness
  = safety + identity + lifecycle + bounded capabilities + receipts

Jev
  = fast learned decisions about where reasoning should go

planner LLM
  = strategy + planning + grounded semantic decisions

conversation LLM
  = SGLuna's human-facing voice
```

If this split works, SGLuna should feel more autonomous and more natural at the same time: fewer brittle policy branches in the harness, fewer unnecessary expensive planner turns, and a cleaner separation between "thinking", "deciding where to think", "talking", and "doing".
