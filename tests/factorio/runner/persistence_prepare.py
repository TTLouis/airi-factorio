"""Prepare a live NPC save while physical work is active, then force a server save."""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, validate_clock


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def run(client: Rcon, results: Path, save_path: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'persistence-prepare-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    original_id = json.loads((results / 'runner.json').read_text())['actor_id']
    initial = json_command(operation_status_command(), 'persistence initial status')
    require(initial['task_state'] == 'idle' and initial['queue_length'] == 0, initial)
    require(initial['actor']['actor_id'] == original_id, initial)

    # Combat owns nearby-enemy fixtures. Clear them here so the restart test is
    # only measuring persistence/reconciliation, then create a long, open movement
    # corridor with one unique target that will itself be persisted by the save.
    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'original NPC missing'); "
        "for _,e in pairs(s.find_entities_filtered{force=game.forces.enemy,position=a.position,radius=60}) do e.destroy() end; "
        "for _,e in pairs(s.find_entities_filtered{name='steel-chest',position=a.position,radius=60}) do e.destroy() end; "
        "local tiles={}; local x0=math.floor(a.position.x); local y0=math.floor(a.position.y); "
        "for x=x0-3,x0+40 do for y=y0-4,y0+4 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "local inv=a.get_main_inventory(); assert(inv); inv.clear(); "
        "assert(inv.insert{name='iron-plate',count=17}==17); assert(inv.insert{name='copper-plate',count=13}==13); "
        "local target=s.create_entity{name='steel-chest',position={x=a.position.x+28,y=a.position.y},force=a.force}; assert(target); "
        "rcon.print(helpers.table_to_json({actor_id=a.unit_number,force_index=a.force.index,health=a.health,"
        "iron=inv.get_item_count('iron-plate'),copper=inv.get_item_count('copper-plate'),"
        "target_id=target.unit_number,target_position=target.position,position=a.position}))",
        'persistence fixture',
    )
    require(fixture['actor_id'] == original_id, fixture)
    require(fixture['iron'] == 17 and fixture['copper'] == 13, fixture)

    result = json_command(lua_json(remote_call('autorio_operations', 'walk_to_entity', repr('steel-chest'), '40')), 'restart movement start')
    require(result is True, result)
    queued = json_command(lua_json(remote_call('autorio_operations', 'wait', '300')), 'restart queued wait')
    require(queued[0] is True, queued)

    def active_observation() -> dict:
        return json_command(
            "/silent-command local s=game.surfaces[1]; local a=nil; "
            "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
            f"if e.unit_number=={original_id} then a=e end end; assert(a); "
            "local o=remote.call('autorio_operations','status'); "
            "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
            "o.walking=a.walking_state.walking; o.mining=a.mining_state.mining; "
            "o.shooting=a.shooting_state.state~=defines.shooting.not_shooting; "
            "local inv=a.get_main_inventory(); o.force_index=a.force.index; o.health=a.health; o.position=a.position; "
            "o.iron=inv.get_item_count('iron-plate'); o.copper=inv.get_item_count('copper-plate'); "
            f"o.target_id={fixture['target_id']}; rcon.print(helpers.table_to_json(o))",
            'active persistence observation',
        )

    deadline = time.monotonic() + 12.0
    before = None
    while time.monotonic() < deadline:
        candidate = active_observation()
        validate_clock(candidate['runtime'])
        if candidate['task_state'] in ('walking_to_entity', 'walking_direct') and candidate['walking'] is True:
            before = candidate
            break
        time.sleep(0.1)
    require(before is not None, 'NPC never entered active walking before save')
    require(before['queue_length'] == 1 and before['queued_task_types'] == ['waiting'], before)
    require(before['iron'] == 17 and before['copper'] == 13, before)
    require(before['runtime']['connected_players'] == 0, before)

    old_mtime = save_path.stat().st_mtime_ns
    command('/silent-command game.server_save()')
    save_deadline = time.monotonic() + 20.0
    while time.monotonic() < save_deadline:
        try:
            stat = save_path.stat()
        except FileNotFoundError:
            time.sleep(0.1)
            continue
        if stat.st_mtime_ns > old_mtime and stat.st_size > 0:
            break
        time.sleep(0.1)
    else:
        raise AssertionError(f'server save did not update {save_path}')

    payload = {
        'status': 'prepared',
        'actor_id': original_id,
        'force_index': fixture['force_index'],
        'inventory': {'iron-plate': 17, 'copper-plate': 13},
        'target_id': fixture['target_id'],
        'target_position': fixture['target_position'],
        'before_save': before,
        'saved_file_mtime_ns': save_path.stat().st_mtime_ns,
        'saved_file_size': save_path.stat().st_size,
    }
    (results / 'persistence-before.json').write_text(json.dumps(payload, indent=2))
    print(
        f"[npc-test] Saved active NPC state for restart: actor_id={original_id}, "
        f"task={before['task_state']}, queued={before['queue_length']}",
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--save', type=Path, required=True)
    args = parser.parse_args()
    client = None
    try:
        client = connect_with_retry(args.host, args.port, args.password)
        run(client, args.results, args.save)
        return 0
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / 'persistence-prepare-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
