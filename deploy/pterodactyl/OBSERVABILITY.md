# AIRI runtime observability

This document describes the public, structured diagnostics used to debug the standalone Factorio NPC runtime. It intentionally excludes hidden chain-of-thought, credentials, authorization headers, API keys, and other secrets.

## Sources

The runtime writes two rotating JSONL traces under `logs/` by default:

- `airi-behavior.jsonl` — request/actor/provider/tool/plan/runtime event timeline.
- `airi-prompts.jsonl` — final provider request payload metadata plus provider response diagnostics.

Both writers sanitize common credentials before writing. Provider reasoning text is not persisted; only bounded metadata such as `reasoning_content_chars` is recorded.

The in-game AIRI Debug window is a bounded projection of the current/latest live diagnostics. It is not the canonical trace store.

## Correlation

Use `request_id` as the primary correlation key across the two JSONL files. Behavior events also carry `turn`, `actor_id`, `epoch`, and an ordered `seq`. Provider events additionally carry `round` and `recovery_attempt`.

A normal investigation should follow:

`request.received -> actor.bound -> provider.request -> provider.response -> tool.call/result -> plan.accepted -> operations -> request.completed`

A structured-output failure normally follows:

`provider.response -> replan.started -> provider.request/response ... -> request.failed`

`request.failed.data.failure_snapshot` freezes the final provider event, recovery state, last tool, plan position, actor identity when available, and accumulated usage so the failure remains diagnosable after the active request unwinds.

## Provider diagnostics

`provider.response` metadata may include:

- `response_id`, `model`, `finish_reason`, `diagnostic_code`
- `response_bytes`
- `content_chars`, `content_utf8_bytes`
- `content_non_ascii_chars`, `content_replacement_chars`
- `normalized_content_chars`
- `reasoning_content_chars` (length only; no reasoning text)
- `tool_call_count`
- `structured_content.json_valid`
- `structured_content.plan_valid`
- `structured_content.error`
- token/cache usage
- a bounded, sanitized final content preview in the prompt trace

Important diagnostic codes include:

- `provider_output_truncated_empty_content`
- `provider_output_truncated`
- `provider_empty_content`
- `provider_body_invalid_json`
- `provider_missing_assistant_message`
- `provider_response_too_large`
- `provider_http_error`
- `provider_timeout`
- `provider_cancelled`

Do not collapse these back into a single `Invalid provider content JSON` message in diagnostics. The player-facing NPC may use a natural fallback, but the debug path should preserve the actual failure class.

## Latest failure report

`runtime-v8/debug-report.mjs` correlates the latest `request.failed` event with provider and prompt traces without printing prompt payloads or hidden reasoning text.

From the installed runtime/repository root:

```sh
node deploy/pterodactyl/runtime-v8/debug-report.mjs
```

For machine-readable output:

```sh
node deploy/pterodactyl/runtime-v8/debug-report.mjs --json
```

Explicit JSONL paths may be passed as the first and second positional arguments:

```sh
node deploy/pterodactyl/runtime-v8/debug-report.mjs /path/to/airi-behavior.jsonl /path/to/airi-prompts.jsonl
```

The report includes the final failure, actor/epoch, provider round/recovery attempt, finish reason, diagnostic code, content/UTF-8/reasoning sizes, structured JSON/schema status, last tool, usage, prompt-size metadata, a short correlated event timeline, and bounded diagnosis hints.

## Interpreting the original empty-content failure

If a report shows all of the following:

- `finish_reason=length`
- `content_chars=0`
- `tool_call_count=0`
- large `reasoning_content_chars`

then the evidence points to the provider exhausting output budget before emitting visible structured content. Chinese text itself is not invalid JSON. Treat language as a possible verbosity/budget amplifier only if controlled A/B runs support that conclusion.

If `content_replacement_chars > 0`, investigate UTF-8 decoding or byte-based slicing. If content is non-empty with `structured_content.json_valid=false`, inspect the bounded final content preview for malformed/truncated JSON. If JSON is valid but `plan_valid=false`, investigate the AIRI structured-response schema instead.

## Regression contract

Observability changes should preserve these properties:

1. A failed request can be diagnosed from the Debug UI plus the two JSONL traces without hidden reasoning.
2. Failure context survives request unwind and ordinary UI heartbeat refreshes.
3. Provider transport JSON errors are distinguishable from model structured-content errors.
4. Truncation, empty content, UTF-8 replacement evidence, JSON parse failure, and plan-schema failure remain distinguishable.
5. Logging failures never turn an otherwise valid provider request into a runtime failure.
6. Secrets are sanitized and reasoning text is never written to the trace.

Relevant regression tests include:

- `runtime-v8/behavior-trace.test.mjs`
- `runtime-v8/prompt-trace.test.mjs`
- `runtime-v8/debug-ui-bridge.test.mjs`
- `runtime-v8/debug-report.test.mjs`
