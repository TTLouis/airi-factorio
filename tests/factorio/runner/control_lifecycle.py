#!/usr/bin/env python3
"""Real-engine completion/cancellation checks; never force-stop test subjects."""
import argparse
import json
import math
import os
import time
from collections.abc import Callable
from pathlib import Path

from run import connect_with_retry, decode_json, lua_text, remote_call, squared_distance
from runtime import validate_clock, wait_until_idle


def assert_stopped(status: dict, actor_id: int, expected_state: str = 'idle') -> None:
    validate_clock(status.get('runtime', {}))
    actor = status.get('actor', {})
    if (actor.get('actor_id') != actor_id or actor.get('kind') != 'standalone_character'
            or actor.get('valid') is not True):
        raise AssertionError(f'controlled actor changed or became invalid: {status!r}')
    if status.get('task_state') != expected_state:
        raise AssertionError(f'expected {expected_state} task state: {status!r}')
    if status.get('queue_empty') is not True or status.get('queue_length') != 0:
        raise AssertionError(f'control lifecycle check left queued work: {status!r}')
    physical = status.get('physical', {})
    if (physical.get('walking') is not False or physical.get('mining') is not False
            or physical.get('not_shooting') is not True):
        raise AssertionError(f'task ended but character controls are still active: {status!r}')


def assert_quiet_pair(before: dict, after: dict, actor_id: int, expected_state: str = 'idle') -> None:
    assert_stopped(before, actor_id, expected_state)
    assert_stopped(after, actor_id, expected_state)
    if after['runtime']['tick'] - before['runtime']['tick'] < 3:
        raise AssertionError('quiet interval did not advance independently of RCON')
    # One fixed-point position unit is the tolerance, not a permissive arrival radius.
    if squared_distance(before['actor']['position'], after['actor']['position']) > (1 / 256) ** 2:
        raise AssertionError(f'character drifted during {expected_state}: before={before!r}, after={after!r}')


def run(client, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    core = json.loads((results / 'runner.json').read_text())
    transfer = json.loads((results / 'placement-transfer.json').read_text())
    if core.get('status') != 'pass' or transfer.get('status') != 'pass':
        raise AssertionError('core and placement/transfer gates must pass first')
    actor_id = core['actor_id']
    if transfer['actor_id'] != actor_id:
        raise AssertionError('placement/transfer did not keep the core NPC identity')

    started = time.monotonic()
    transcript: list[dict] = []
    observations: dict[str, dict] = {}
    resource_position = None
    wall_timeout = float(os.environ.get('NPC_TEST_WALL_TIMEOUT', '120'))
    if not math.isfinite(wall_timeout) or wall_timeout <= 0:
        raise ValueError('NPC_TEST_WALL_TIMEOUT must be a finite positive number')

    def command(value: str) -> str:
        try:
            response = client.command(value)
        except Exception as exc:
            transcript.append({'elapsed_seconds': time.monotonic() - started,
                               'command': value, 'error': str(exc)})
            raise
        else:
            transcript.append({'elapsed_seconds': time.monotonic() - started,
                               'command': value, 'response': response})
            return response
        finally:
            (results / 'control-lifecycle-transcript.json').write_text(
                json.dumps({'transcript': transcript}, indent=2))

    def read_status(context: str) -> dict:
        inspect_resource = ''
        if resource_position is not None:
            inspect_resource = (
                "local ore=game.surfaces[1].find_entities_filtered{name='iron-ore',"
                f"position={{x={resource_position['x']},y={resource_position['y']}}},radius=0.25}}[1]; "
                "s.resource={found=ore~=nil,amount=ore and ore.amount or 0}; "
            )
        value = (
            "/silent-command local s=remote.call('autorio_operations','status'); "
            "s.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,"
            "connected_players=#game.connected_players}; "
            "local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
            f"if e.unit_number=={actor_id} then a=e; break end end; "
            "if a then s.physical={walking=a.walking_state.walking,mining=a.mining_state.mining,"
            "not_shooting=a.shooting_state.state==defines.shooting.not_shooting,"
            "iron_ore=a.get_item_count('iron-ore')} end; "
            + inspect_resource + "rcon.print(helpers.table_to_json(s))"
        )
        status = decode_json(command(value), context)
        validate_clock(status.get('runtime', {}))
        if status.get('actor', {}).get('actor_id') != actor_id or not status.get('physical'):
            raise AssertionError(f'{context}: original character disappeared or was replaced: {status!r}')
        return status

    def observe_quiet(context: str, expected_state: str = 'idle') -> dict:
        before = read_status(context + ' before quiet interval')
        assert_stopped(before, actor_id, expected_state)
        time.sleep(2.0)  # No RCON traffic or corrective input during this interval.
        after = read_status(context + ' after quiet interval')
        record = {'before': before, 'after': after}
        observations[context] = record
        (results / 'control-lifecycle-observations.json').write_text(json.dumps(observations, indent=2))
        assert_quiet_pair(before, after, actor_id, expected_state)
        return record

    def await_state(context: str, predicate: Callable[[dict], bool]) -> dict:
        began = time.monotonic()
        first_tick = None
        previous_tick = None
        last_change = began
        while True:
            status = read_status(context)
            now = time.monotonic()
            tick = status['runtime']['tick']
            if first_tick is None:
                first_tick = tick
            if previous_tick is not None and tick < previous_tick:
                raise AssertionError(f'{context}: simulation tick went backwards')
            if tick != previous_tick:
                last_change = now
            previous_tick = tick
            if tick - first_tick >= 600 or now - began >= wall_timeout or now - last_change >= 10:
                raise AssertionError(f'{context}: state was not reached within clock/wall budget: {status!r}')
            if predicate(status):
                return status
            time.sleep(0.05)

    def corridor(distance: int) -> dict:
        # Deterministic terrain/targets only. No teleport, walking reset, speed
        # modifier, or actor replacement may hide the behavior under test.
        fixture = (
            "/silent-command local s=game.surfaces[1]; local a=nil; "
            "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
            f"if e.unit_number=={actor_id} then a=e; break end end; assert(a,'missing original NPC'); "
            "local x=math.floor(a.position.x); local y=math.floor(a.position.y); local tiles={}; "
            "for tx=x-3,x+30 do for ty=y-4,y+4 do "
            "tiles[#tiles+1]={name='landfill',position={x=tx,y=ty}} end end; "
            "s.set_tiles(tiles,true,false,true); "
            "for _,e in pairs(s.find_entities_filtered{area={{x-3,y-4},{x+31,y+5}}}) do "
            "if e.name~='character' then e.destroy() end end; "
            f"local target=s.create_entity{{name='iron-chest',position={{x=a.position.x+{distance},y=a.position.y}},force=a.force}}; "
            "rcon.print(helpers.table_to_json({created=target~=nil,start=a.position,"
            "target=target and target.position or nil}))"
        )
        value = decode_json(command(fixture), 'control lifecycle corridor fixture')
        if value['created'] is not True:
            raise AssertionError(f'could not create lifecycle target: {value!r}')
        return value

    def begin_walk(queue_wait: bool = False) -> None:
        walk = remote_call('autorio_operations', 'walk_to_entity', repr('iron-chest'), '40')
        if queue_wait:
            wait = remote_call('autorio_operations', 'wait', '3600')
            value = f'/silent-command local w={walk}; local q={wait}; rcon.print(helpers.table_to_json({{walk=w,wait=q}}))'
            result = decode_json(command(value), 'queued walk and wait')
            if result.get('walk') is not True or result['wait'][0] is not True:
                raise AssertionError(f'could not queue walk and wait: {result!r}')
        elif command(lua_text(walk)) != 'true':
            raise AssertionError('could not start lifecycle movement')

    def cancel() -> None:
        if command(lua_text(remote_call('autorio_operations', 'cancel_all_tasks'))) != 'true':
            raise AssertionError('cancel_all_tasks was rejected')
        status = read_status('immediately after cancellation')
        assert_stopped(status, actor_id)

    observe_quiet('after core and transfer')
    fixture = corridor(12)
    begin_walk()
    arrived = wait_until_idle(read_status, 'lifecycle movement completion')
    if squared_distance(fixture['start'], arrived['actor']['position']) < 4:
        raise AssertionError('lifecycle movement did not move a meaningful distance')
    if squared_distance(fixture['target'], arrived['actor']['position']) > 16:
        raise AssertionError('lifecycle movement did not reach the target area')
    observe_quiet('after movement completion')

    corridor(12)
    begin_walk(queue_wait=True)
    await_state('walk-to-wait handoff', lambda s: s['task_state'] == 'waiting')
    observe_quiet('during queued wait', 'waiting')
    cancel()

    corridor(24)
    begin_walk(queue_wait=True)
    moving = await_state('active movement before cancellation', lambda s: (
        s['task_state'] in ('walking_to_entity', 'walking_direct') and s['physical']['walking'] is True))
    if moving.get('queue_length') != 1:
        raise AssertionError('cancellation fixture must have a queued wait')
    cancel()
    observe_quiet('after movement cancellation')

    fixture = (
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e; break end end; assert(a,'missing original NPC'); "
        "local ore=s.create_entity{name='iron-ore',position={x=a.position.x+1,y=a.position.y},amount=1000}; "
        "rcon.print(helpers.table_to_json({created=ore~=nil,position=ore and ore.position or nil}))"
    )
    resource = decode_json(command(fixture), 'mining cancellation fixture')
    if resource['created'] is not True:
        raise AssertionError('could not create mining cancellation resource')
    resource_position = resource['position']
    if command(lua_text(remote_call('autorio_operations', 'mine_entity', repr('iron-ore'), '1000'))) != 'true':
        raise AssertionError('could not start mining cancellation task')
    await_state('active mining before cancellation', lambda s: (
        s['task_state'] == 'mining' and s['physical']['mining'] is True))
    cancel()
    cancelled = observe_quiet('after mining cancellation')
    before, after = cancelled['before'], cancelled['after']
    if (before['resource']['found'] is not True or after['resource']['found'] is not True
            or before['resource']['amount'] != after['resource']['amount']
            or before['physical']['iron_ore'] != after['physical']['iron_ore']):
        raise AssertionError(f'mining continued after cancellation: {cancelled!r}')

    (results / 'control-lifecycle.json').write_text(json.dumps({
        'status': 'pass', 'actor_id': actor_id, 'observations': observations,
    }, indent=2))
    print(f'PASS: zero-player NPC stops after movement and cancellation with stable actor_id={actor_id}', flush=True)


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
        (args.results / 'control-lifecycle-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', flush=True)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
