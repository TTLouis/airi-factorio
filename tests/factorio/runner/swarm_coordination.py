#!/usr/bin/env python3
import argparse
import json
import sys
import time
from pathlib import Path

from run import assert_true, connect_with_retry, decode_json, lua_json, remote_call
from runtime import verify_free_running_ticks


def run(client, results: Path) -> None:
    transcript: list[dict[str, object]] = []
    results.mkdir(parents=True, exist_ok=True)
    transcript_path = results / 'swarm-coordination-transcript.json'
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

    def coordination_call(method: str, *args: str):
        return call('autorio_swarm_coordination', method, *args)

    def actor_status(actor_id: str):
        value = swarm_call('status', repr(actor_id))
        assert_true(value.get('found') is True, f'actor missing from swarm status: {actor_id}: {value!r}')
        return value

    def work_status(work_id: str):
        value = swarm_call('work_status', repr(work_id))
        assert_true(value.get('found') is True, f'work missing from swarm status: {work_id}: {value!r}')
        return value

    def wait_until(predicate, observe, context: str, timeout: float = 15.0, interval: float = 0.1):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = observe()
            if predicate(last):
                return last
            time.sleep(interval)
        raise AssertionError(f'{context} timed out: {last!r}')

    verify_free_running_ticks(command, results)

    all_status = swarm_call('status')
    actors = all_status.get('actors') or []
    assert_true(len(actors) == 2, f'coordination gate requires exactly two existing swarm actors: {all_status!r}')
    actors = sorted(actors, key=lambda entry: entry['actorId'])
    first_id = actors[0]['actorId']
    second_id = actors[1]['actorId']
    first_agent = actors[0]['agent']['id']
    second_agent = actors[1]['agent']['id']

    # Milestone 1: one structured Mission compiles to parallel Objectives and
    # unaddressed Work. Locality should split the two targets across the agents,
    # and Work evidence should satisfy both Objectives and then the Mission.
    targets = "{{x=-11,y=-3,radius=1.5,label='west objective'},{x=11,y=3,radius=1.5,label='east objective'}}"
    mission_created = coordination_call('create_survey_mission', repr('parallel survey mission'), targets, '70')
    assert_true(mission_created.get('ok') is True, f'could not create structured survey mission: {mission_created!r}')
    mission_id = mission_created['missionId']
    mission_work_ids = mission_created['workIds']
    assert_true(len(mission_work_ids) == 2, f'mission did not compile two work items: {mission_created!r}')

    mission_done = wait_until(
        lambda value: (value.get('mission') or {}).get('status') == 'satisfied',
        lambda: coordination_call('mission_status', repr(mission_id)),
        'mission objective completion',
    )
    assert_true(all(obj.get('status') == 'satisfied' for obj in mission_done.get('objectives') or []), f'not all mission objectives satisfied: {mission_done!r}')

    global_snapshot = coordination_call('snapshot', '1')
    assert_true(global_snapshot.get('schema') == 'swarm_coordination_snapshot_v1', f'global coordination snapshot schema mismatch: {global_snapshot!r}')
    assert_true(isinstance(global_snapshot.get('tick'), int), f'global coordination snapshot missing simulation tick: {global_snapshot!r}')
    assert_true((global_snapshot.get('counts') or {}).get('missions', 0) >= 1, f'global coordination snapshot lost mission count: {global_snapshot!r}')
    assert_true((global_snapshot.get('counts') or {}).get('objectives', 0) >= 2, f'global coordination snapshot lost objective count: {global_snapshot!r}')
    assert_true(len(global_snapshot.get('missions') or []) <= 1, f'global coordination snapshot ignored requested bound: {global_snapshot!r}')
    assert_true(len(global_snapshot.get('objectives') or []) <= 1, f'global coordination snapshot objective projection is unbounded: {global_snapshot!r}')
    assert_true('latestEvents' not in global_snapshot and 'events' not in global_snapshot, f'global coordination snapshot leaked event history: {global_snapshot!r}')

    first_mission_work = work_status(mission_work_ids[0])
    second_mission_work = work_status(mission_work_ids[1])
    mission_agents = {first_mission_work['results'][-1]['agentId'], second_mission_work['results'][-1]['agentId']}
    assert_true(mission_agents == {first_agent, second_agent}, f'parallel mission was not split across both agents: {first_mission_work!r} {second_mission_work!r}')

    # Milestone 2: let the nearer first actor acquire a real Claim, destroy its
    # body, and require the still-online second agent to acquire a new Claim for
    # the same Work. Then replace the first body and verify its recovering Agent
    # returns to the available pool without inheriting stale ownership.
    reassignment = swarm_call('create_survey_work', '0', '-4', '1.5', '85', '1')
    assert_true(reassignment.get('ok') is True, f'could not create reassignment work: {reassignment!r}')
    reassignment_id = reassignment['work']['id']

    first_claim = wait_until(
        lambda value: (value.get('claim') or {}).get('actorId') == first_id,
        lambda: work_status(reassignment_id),
        'initial reassignment claim by first actor',
    )
    assert_true(first_claim['work']['status'] == 'active', f'initial reassignment work not active: {first_claim!r}')

    first_before_loss = actor_status(first_id)
    old_revision = first_before_loss['runtime']['bodyRevision']
    old_physical = first_before_loss['runtime']['physical']['physicalActorId']
    destroyed = swarm_call('destroy_body', repr(first_id))
    assert_true(destroyed.get('ok') is True, f'could not destroy claimed actor body: {destroyed!r}')

    second_claim = wait_until(
        lambda value: (value.get('claim') or {}).get('actorId') == second_id,
        lambda: work_status(reassignment_id),
        'claim reassignment to second actor after first actor loss',
    )
    assert_true(second_claim['claim']['id'] != first_claim['claim']['id'], f'reassignment reused stale claim identity: {first_claim!r} {second_claim!r}')

    reassigned_done = wait_until(
        lambda value: (value.get('work') or {}).get('status') == 'completed',
        lambda: work_status(reassignment_id),
        'reassigned work completion',
    )
    assert_true(reassigned_done['results'][-1]['agentId'] == second_agent, f'reassigned work did not complete under second agent: {reassigned_done!r}')

    replacement = swarm_call('replace_body', repr(first_id), '-11', '-3', '1', repr('player'))
    assert_true(replacement.get('ok') is True, f'could not replace first actor after claim recovery: {replacement!r}')
    assert_true(replacement['runtime']['bodyRevision'] == old_revision + 1, f'body revision did not advance after replacement: {replacement!r}')
    assert_true(replacement['actor']['actor_id'] != old_physical, f'body replacement reused old physical identity: {replacement!r}')

    recovered_first = wait_until(
        lambda value: (value.get('agent') or {}).get('state') == 'available',
        lambda: actor_status(first_id),
        'replaced first agent returning to available',
    )
    assert_true((recovered_first.get('agent') or {}).get('currentWorkId') is None, f'recovered first agent retained stale work: {recovered_first!r}')

    # Milestone 3: block an active job with an observation Request. The active
    # Claim must be released, deterministic remedial survey Work generated near
    # the first actor, evidence must satisfy the Request, and the original Work
    # must then reopen and finish under the nearer second actor.
    original = swarm_call('create_survey_work', '11', '0', '1.5', '75', '1')
    assert_true(original.get('ok') is True, f'could not create blocker target work: {original!r}')
    original_id = original['work']['id']

    original_claim = wait_until(
        lambda value: (value.get('claim') or {}).get('actorId') == second_id,
        lambda: work_status(original_id),
        'original work claim before blocker',
    )
    assert_true(original_claim['work']['status'] == 'active', f'original blocker work not active: {original_claim!r}')

    blocked = coordination_call('block_work_for_observation', repr(original_id), '-10', '-3', '1.5', '90', '1')
    assert_true(blocked.get('ok') is True, f'could not create observation blocker: {blocked!r}')
    request_id = blocked['request']['id']

    request_planned = wait_until(
        lambda value: len((value.get('request') or {}).get('satisfyingWorkIds') or []) >= 1,
        lambda: coordination_call('request_status', repr(request_id)),
        'request remedy planning',
    )
    remedy_id = request_planned['request']['satisfyingWorkIds'][-1]

    remedy_done = wait_until(
        lambda value: (value.get('work') or {}).get('status') == 'completed',
        lambda: work_status(remedy_id),
        'request remedy work completion',
    )
    assert_true(remedy_done['results'][-1]['agentId'] == first_agent, f'local remedial request was not handled by recovered first agent: {remedy_done!r}')

    request_done = wait_until(
        lambda value: (value.get('request') or {}).get('status') == 'satisfied',
        lambda: coordination_call('request_status', repr(request_id)),
        'evidence-backed request satisfaction',
    )
    assert_true(len((request_done.get('request') or {}).get('evidence') or []) >= 1, f'satisfied request has no evidence: {request_done!r}')

    original_done = wait_until(
        lambda value: (value.get('work') or {}).get('status') == 'completed',
        lambda: work_status(original_id),
        'blocked original work reopening and completion',
    )
    assert_true(original_done['results'][-1]['agentId'] == second_agent, f'original work did not resume under the nearer second agent: {original_done!r}')
    assert_true(len((original_done.get('work') or {}).get('blockingRequests') or []) >= 1, f'original work lost blocker provenance: {original_done!r}')

    final_first = actor_status(first_id)
    final_second = actor_status(second_id)
    assert_true(final_first['agent']['state'] == 'available', f'first agent not available at final checkpoint: {final_first!r}')
    assert_true(final_second['agent']['state'] == 'available', f'second agent not available at final checkpoint: {final_second!r}')

    result = {
        'status': 'pass',
        'mission_id': mission_id,
        'mission_work_ids': mission_work_ids,
        'reassignment_work_id': reassignment_id,
        'blocker_request_id': request_id,
        'remedy_work_id': remedy_id,
        'original_blocked_work_id': original_id,
        'first_actor_id': first_id,
        'second_actor_id': second_id,
        'transcript': transcript,
    }
    (results / 'swarm-coordination.json').write_text(json.dumps(result, indent=2))
    print(
        'PASS: mission work split across agents, active work reassigned after actor loss, '
        'and blocker Request remedy evidence reopened original work'
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
        (args.results / 'swarm-coordination-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
