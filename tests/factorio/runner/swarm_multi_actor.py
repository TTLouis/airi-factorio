#!/usr/bin/env python3
import argparse
import json
import sys
import time
from pathlib import Path

from run import assert_true, connect_with_retry, decode_json, lua_json, remote_call, squared_distance
from runtime import verify_free_running_ticks


def run(client, results: Path) -> None:
    transcript: list[dict[str, object]] = []
    results.mkdir(parents=True, exist_ok=True)
    transcript_path = results / 'swarm-multi-actor-transcript.json'
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

    def swarm_call(method: str, *args: str):
        response = command(lua_json(remote_call('autorio_swarm', method, *args)))
        return decode_json(response, f'autorio_swarm.{method}')

    def swarm_status(actor_id: str | None = None):
        args = [] if actor_id is None else [repr(actor_id)]
        return swarm_call('status', *args)

    def actor_entry(actor_id: str):
        status = swarm_status(actor_id)
        assert_true(status.get('found') is True, f'swarm actor not found: {actor_id}: {status!r}')
        return status

    def wait_for_idle(actor_ids: list[str], context: str, timeout: float = 12.0):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = {actor_id: actor_entry(actor_id) for actor_id in actor_ids}
            if all((entry.get('tasks') or {}).get('task_state') == 'idle' for entry in last.values()):
                return last
            time.sleep(0.1)
        raise AssertionError(f'{context} did not become idle: {last!r}')

    lua_probe = '/silent-command rcon.print("AIRI_RCON_READY")'
    probe_response = command(lua_probe)
    if probe_response != 'AIRI_RCON_READY':
        probe_response = command(lua_probe)
    assert_true(probe_response == 'AIRI_RCON_READY', f'Factorio Lua console handshake failed: {probe_response!r}')

    simulation_clock = verify_free_running_ticks(command, results)

    fixture_command = (
        "/silent-command "
        "local s=game.surfaces[1]; local tiles={}; "
        "for x=-12,14 do for y=-5,5 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "for _,e in pairs(s.find_entities_filtered{area={{-12,-5},{14,5}}}) do if e.name~='character' then e.destroy() end end; "
        "rcon.print(helpers.table_to_json({characters=#s.find_entities_filtered{name='character'}}))"
    )
    fixture = decode_json(command(fixture_command), 'swarm fixture setup')
    assert_true(fixture['characters'] == 0, f'expected no pre-existing character bodies in swarm lane: {fixture!r}')

    first = swarm_call('create_actor', '-6', '-2', '1', repr('player'))
    second = swarm_call('create_actor', '-6', '2', '1', repr('player'))
    assert_true(first.get('ok') is True, f'could not create first swarm actor: {first!r}')
    assert_true(second.get('ok') is True, f'could not create second swarm actor: {second!r}')

    first_id = first['actorId']
    second_id = second['actorId']
    first_physical = first['actor']['actor_id']
    second_physical = second['actor']['actor_id']
    assert_true(first_id != second_id, f'logical actor ids collided: {first!r} {second!r}')
    assert_true(first['agentId'] != second['agentId'], f'agent ids collided: {first!r} {second!r}')
    assert_true(first_physical != second_physical, f'physical actor ids collided: {first!r} {second!r}')
    assert_true(first['runtime']['bodyRevision'] == 1, f'first body revision not initialized: {first!r}')
    assert_true(second['runtime']['bodyRevision'] == 1, f'second body revision not initialized: {second!r}')

    bodies = decode_json(command(
        "/silent-command local s=game.surfaces[1]; rcon.print(helpers.table_to_json({count=#s.find_entities_filtered{name='character'}}))"
    ), 'character count after swarm creation')
    assert_true(bodies['count'] == 2, f'expected exactly two swarm character bodies: {bodies!r}')

    first_start = actor_entry(first_id)['actor']['position']
    second_start = actor_entry(second_id)['actor']['position']

    first_move = swarm_call('walk_to_position', repr(first_id), '6', '-2')
    second_move = swarm_call('walk_to_position', repr(second_id), '6', '2')
    assert_true(first_move.get('ok') is True and second_move.get('ok') is True, f'could not start simultaneous swarm movement: {first_move!r} {second_move!r}')

    moved = wait_for_idle([first_id, second_id], 'simultaneous two-actor movement')
    first_end = moved[first_id]['actor']['position']
    second_end = moved[second_id]['actor']['position']
    assert_true(squared_distance(first_start, first_end) >= 36.0, f'first swarm actor did not move enough: {first_start!r} -> {first_end!r}')
    assert_true(squared_distance(second_start, second_end) >= 36.0, f'second swarm actor did not move enough: {second_start!r} -> {second_end!r}')
    assert_true(squared_distance(first_end, {'x': 6.0, 'y': -2.0}) <= 4.0, f'first actor missed target: {first_end!r}')
    assert_true(squared_distance(second_end, {'x': 6.0, 'y': 2.0}) <= 4.0, f'second actor missed target: {second_end!r}')

    first_back = swarm_call('walk_to_position', repr(first_id), '-6', '-2')
    second_forward = swarm_call('walk_to_position', repr(second_id), '11', '2')
    assert_true(first_back.get('ok') is True and second_forward.get('ok') is True, f'could not start isolation movement: {first_back!r} {second_forward!r}')
    time.sleep(0.35)
    cancelled = swarm_call('cancel', repr(first_id))
    assert_true(cancelled.get('ok') is True, f'could not cancel only first actor: {cancelled!r}')
    cancelled_position = actor_entry(first_id)['actor']['position']

    second_only = wait_for_idle([second_id], 'second actor after first cancellation')
    time.sleep(0.35)
    first_after_cancel = actor_entry(first_id)
    assert_true((first_after_cancel.get('tasks') or {}).get('task_state') == 'idle', f'first actor not idle after cancellation: {first_after_cancel!r}')
    assert_true(squared_distance(cancelled_position, first_after_cancel['actor']['position']) <= 0.5, f'first actor kept moving after cancellation: before={cancelled_position!r}, after={first_after_cancel!r}')
    assert_true(squared_distance(second_only[second_id]['actor']['position'], {'x': 11.0, 'y': 2.0}) <= 4.0, f'second actor was disrupted by first cancellation: {second_only!r}')

    second_wait = swarm_call('wait', repr(second_id), '600')
    assert_true(second_wait.get('ok') is True, f'could not start second actor isolation wait: {second_wait!r}')
    second_before_death = actor_entry(second_id)
    assert_true((second_before_death.get('tasks') or {}).get('task_state') == 'waiting', f'second actor wait did not start: {second_before_death!r}')

    first_before_death = actor_entry(first_id)
    old_revision = first_before_death['runtime']['bodyRevision']
    old_physical = first_before_death['runtime']['physical']['physicalActorId']
    destroyed = swarm_call('destroy_body', repr(first_id))
    assert_true(destroyed.get('ok') is True, f'could not destroy first swarm body: {destroyed!r}')
    missing = actor_entry(first_id)
    assert_true(missing['runtime']['state'] == 'missing', f'first logical actor was not marked missing: {missing!r}')
    assert_true(missing.get('actor') is None, f'destroyed first body still resolves physically: {missing!r}')

    second_during_death = actor_entry(second_id)
    assert_true(second_during_death['runtime']['physical']['physicalActorId'] == second_physical, f'second physical identity changed when first died: {second_during_death!r}')
    assert_true((second_during_death.get('tasks') or {}).get('task_state') == 'waiting', f'second actor work was cancelled by first death: {second_during_death!r}')

    replacement = swarm_call('replace_body', repr(first_id), '0', '-2', '1', repr('player'))
    assert_true(replacement.get('ok') is True, f'could not replace first swarm body: {replacement!r}')
    assert_true(replacement['actorId'] == first_id, f'replacement changed logical actor identity: {replacement!r}')
    assert_true(replacement['actor']['actor_id'] != old_physical, f'replacement reused old physical body identity: {replacement!r}')
    assert_true(replacement['runtime']['bodyRevision'] == old_revision + 1, f'replacement did not increment body revision: before={old_revision}, replacement={replacement!r}')

    second_after_replacement = actor_entry(second_id)
    assert_true(second_after_replacement['runtime']['physical']['physicalActorId'] == second_physical, f'second actor changed during first replacement: {second_after_replacement!r}')
    assert_true((second_after_replacement.get('tasks') or {}).get('task_state') == 'waiting', f'second actor work was disrupted by first replacement: {second_after_replacement!r}')

    swarm_call('cancel', repr(second_id))
    replacement_wait = swarm_call('wait', repr(first_id), '3')
    assert_true(replacement_wait.get('ok') is True, f'replacement body could not accept fresh work: {replacement_wait!r}')
    wait_for_idle([first_id], 'replacement actor fresh work', 5.0)

    final = swarm_status()
    final_bodies = decode_json(command(
        "/silent-command local s=game.surfaces[1]; rcon.print(helpers.table_to_json({count=#s.find_entities_filtered{name='character'}}))"
    ), 'final character count')
    assert_true(final_bodies['count'] == 2, f'expected exactly two live swarm bodies after replacement: {final_bodies!r}')

    result = {
        'status': 'pass',
        'simulation_clock': simulation_clock,
        'first_actor_id': first_id,
        'second_actor_id': second_id,
        'first_original_physical_id': first_physical,
        'first_replacement_physical_id': replacement['actor']['actor_id'],
        'second_physical_id': second_physical,
        'first_final_body_revision': replacement['runtime']['bodyRevision'],
        'final_status': final,
        'transcript': transcript,
    }
    (results / 'swarm-multi-actor.json').write_text(json.dumps(result, indent=2))
    print(
        'PASS: two live swarm NPCs moved independently, cancellation stayed actor-scoped, '
        f'and body replacement preserved logical identity ({first_id}, {second_id})'
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
        (args.results / 'swarm-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
