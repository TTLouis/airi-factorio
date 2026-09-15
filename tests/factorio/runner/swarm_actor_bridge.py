#!/usr/bin/env python3
import argparse
import json
import sys
import time
from pathlib import Path

from run import assert_true, connect_with_retry, decode_json, lua_json, remote_call


def run(client, results: Path) -> None:
    transcript: list[dict[str, object]] = []
    results.mkdir(parents=True, exist_ok=True)
    transcript_path = results / 'swarm-actor-bridge-transcript.json'
    started = time.monotonic()

    def command(value: str) -> str:
        response = client.command(value)
        transcript.append({
            'command': value,
            'response': response,
            'elapsed_seconds': round(time.monotonic() - started, 3),
        })
        transcript_path.write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def call(interface: str, method: str, *args: str):
        response = command(lua_json(remote_call(interface, method, *args)))
        return decode_json(response, f'{interface}.{method}')

    def swarm_call(method: str, *args: str):
        return call('autorio_swarm', method, *args)

    def bridge_call(method: str, *args: str):
        return call('autorio_swarm_actor', method, *args)

    def bridge_status(actor_id: str):
        return bridge_call('status', repr(actor_id))

    def actor_status(actor_id: str):
        status = swarm_call('status', repr(actor_id))
        assert_true(status.get('found') is True, f'actor missing: {actor_id}: {status!r}')
        return status

    def wait_actor_state(actor_id: str, expected: str, context: str, timeout: float = 8.0):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = actor_status(actor_id)
            if (last.get('tasks') or {}).get('task_state') == expected:
                return last
            time.sleep(0.1)
        raise AssertionError(f'{context}: expected {expected}, got {last!r}')

    def wait_work_completed(work_id: str, timeout: float = 12.0):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = swarm_call('work_status', repr(work_id))
            if (last.get('work') or {}).get('status') == 'completed':
                return last
            time.sleep(0.1)
        raise AssertionError(f'work {work_id} did not complete: {last!r}')

    roster = swarm_call('status')
    actors = [entry for entry in roster.get('actors') or [] if entry.get('found') is True]
    assert_true(len(actors) >= 2, f'actor bridge gate needs at least two live swarm actors: {roster!r}')
    first = actors[0]
    second = actors[1]
    first_id = first['actorId']
    second_id = second['actorId']
    first_agent = first['agent']['id']
    second_agent = second['agent']['id']

    first_bridge = bridge_status(first_id)
    second_bridge = bridge_status(second_id)
    assert_true(first_bridge.get('allowed') is True, f'first actor not direct-authorized: {first_bridge!r}')
    assert_true(second_bridge.get('allowed') is True, f'second actor not direct-authorized: {second_bridge!r}')
    assert_true(first_bridge.get('displayName') and second_bridge.get('displayName'), f'missing deterministic display names: {first_bridge!r} {second_bridge!r}')
    assert_true(first_bridge['displayName'] != second_bridge['displayName'], f'display names collided: {first_bridge!r} {second_bridge!r}')
    first_token = first_bridge['authority_token']
    second_token = second_bridge['authority_token']
    assert_true(first_token != second_token, f'authority tokens collided: {first_bridge!r} {second_bridge!r}')

    first_wait = bridge_call('wait', repr(first_id), repr(first_token), '240')
    second_wait = bridge_call('wait', repr(second_id), repr(second_token), '600')
    assert_true(first_wait.get('ok') is True and second_wait.get('ok') is True, f'direct wait admission failed: {first_wait!r} {second_wait!r}')
    wait_actor_state(first_id, 'waiting', 'first direct wait did not start')
    wait_actor_state(second_id, 'waiting', 'second direct wait did not start')

    cancelled = bridge_call('cancel_all_tasks', repr(first_id), repr(first_token))
    assert_true(cancelled.get('ok') is True, f'could not cancel first direct actor: {cancelled!r}')
    first_after_cancel = wait_actor_state(first_id, 'idle', 'first actor did not cancel')
    second_after_cancel = actor_status(second_id)
    assert_true((second_after_cancel.get('tasks') or {}).get('task_state') == 'waiting', f'cancelling first actor affected second actor: {second_after_cancel!r}')
    assert_true((first_after_cancel.get('basic') or {}).get('last_result', {}).get('actor_id') != (second_after_cancel.get('basic') or {}).get('last_result', {}).get('actor_id'), f'per-actor basic receipts collapsed: {first_after_cancel!r} {second_after_cancel!r}')

    bridge_call('cancel_all_tasks', repr(second_id), repr(second_token))
    wait_actor_state(second_id, 'idle', 'second actor did not cancel')

    before_replace = bridge_status(first_id)
    old_token = before_replace['authority_token']
    old_body_revision = before_replace['body_revision']
    destroyed = swarm_call('destroy_body', repr(first_id))
    assert_true(destroyed.get('ok') is True, f'could not destroy first body for stale-token gate: {destroyed!r}')
    replaced = swarm_call('replace_body', repr(first_id), '0', '-2', '1', repr('player'))
    assert_true(replaced.get('ok') is True, f'could not replace first body for stale-token gate: {replaced!r}')
    after_replace = bridge_status(first_id)
    assert_true(after_replace.get('allowed') is True, f'replacement actor not direct-authorized: {after_replace!r}')
    assert_true(after_replace['body_revision'] == old_body_revision + 1, f'body revision did not advance: before={before_replace!r} after={after_replace!r}')
    assert_true(after_replace['authority_token'] != old_token, f'authority token survived body replacement: {before_replace!r} {after_replace!r}')
    stale = bridge_call('wait', repr(first_id), repr(old_token), '3')
    assert_true(stale.get('ok') is False and stale.get('code') == 'stale_authority', f'stale authority was not rejected: {stale!r}')

    first_token = after_replace['authority_token']
    first_long_wait = bridge_call('wait', repr(first_id), repr(first_token), '1800')
    assert_true(first_long_wait.get('ok') is True, f'could not occupy first actor with direct work: {first_long_wait!r}')
    wait_actor_state(first_id, 'waiting', 'first actor did not enter direct busy state')

    first_position = actor_status(first_id)['actor']['position']
    survey = swarm_call(
        'create_survey_work',
        str(first_position['x']),
        str(first_position['y']),
        '1.5',
        '90',
        '1',
    )
    assert_true(survey.get('ok') is True, f'could not create scheduler exclusion survey: {survey!r}')
    work_id = survey['work']['id']
    completed = wait_work_completed(work_id)
    results_list = completed.get('results') or []
    assert_true(results_list, f'scheduler exclusion work has no result: {completed!r}')
    assert_true(results_list[-1]['agentId'] == second_agent, f'coordinator stole direct-busy actor instead of using second agent: first={first_agent} second={second_agent} completed={completed!r}')
    first_still_busy = actor_status(first_id)
    assert_true((first_still_busy.get('tasks') or {}).get('task_state') == 'waiting', f'coordinator disturbed direct-busy actor: {first_still_busy!r}')

    cleanup = bridge_call('cancel_all_tasks', repr(first_id), repr(first_token))
    assert_true(cleanup.get('ok') is True, f'could not clean up first direct wait: {cleanup!r}')
    wait_actor_state(first_id, 'idle', 'first actor cleanup did not finish')

    final_first = bridge_status(first_id)
    final_second = bridge_status(second_id)
    result = {
        'status': 'pass',
        'first_actor_id': first_id,
        'second_actor_id': second_id,
        'first_agent_id': first_agent,
        'second_agent_id': second_agent,
        'first_display_name': final_first.get('displayName'),
        'second_display_name': final_second.get('displayName'),
        'stale_authority_result': stale,
        'scheduler_exclusion_work': completed,
        'final_first': final_first,
        'final_second': final_second,
        'transcript': transcript,
    }
    (results / 'swarm-actor-bridge.json').write_text(json.dumps(result, indent=2))
    print(
        'PASS: actor-scoped authority isolated two NPCs, invalidated stale body tokens, '
        'and kept direct-busy actors out of Blackboard scheduling'
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', type=Path, required=True)
    args = parser.parse_args()

    client = None
    try:
        client = connect_with_retry(args.host, args.port, args.password)
        run(client, args.results)
        return 0
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / 'swarm-actor-bridge-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
