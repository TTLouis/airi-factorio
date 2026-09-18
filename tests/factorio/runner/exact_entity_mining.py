"""Verify exact non-resource mining can approach beyond legacy name-mining radius."""
import argparse
import json
import sys
import time
from pathlib import Path

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'exact-entity-mining-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str):
        return decode_json(command(text), context)

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        f"for _,e in pairs(s.find_entities_filtered{{name='character'}}) do if e.unit_number=={actor_id} then a=e end end; "
        "assert(a); remote.call('autorio_operations','cancel_all_tasks'); "
        "for _,e in pairs(s.find_entities_filtered{name='wooden-chest',position=a.position,radius=40}) do e.destroy() end; "
        "local p=s.find_non_colliding_position('wooden-chest',{x=a.position.x+12,y=a.position.y},8,0.5); assert(p); "
        "local c=s.create_entity{name='wooden-chest',position=p,force=a.force}; assert(c and c.unit_number); "
        "rcon.print(helpers.table_to_json({actor_id=a.unit_number,chest_id=c.unit_number,actor_position=a.position,chest_position=c.position}))",
        'exact mining fixture',
    )
    require(fixture['actor_id'] == actor_id, fixture)

    observed = json_command(
        lua_json(remote_call('autorio_tools', 'get_nearby_entities', '64', repr('wooden-chest'), 'nil', '10')),
        'observe remote chest',
    )
    matches = [entity for entity in observed.get('entities', []) if entity.get('unit_number') == fixture['chest_id']]
    require(len(matches) == 1, observed)
    distance = matches[0].get('distance')
    require(isinstance(distance, (int, float)) and distance > 5, observed)

    legacy = json_command(
        lua_json(remote_call('autorio_operations', 'mine_entity', repr('wooden-chest'), '1')),
        'legacy remote name mine admission',
    )
    require(legacy is True, legacy)
    legacy_after = wait_until_idle(status, 'legacy remote name mining failure', 8)
    legacy_result = (legacy_after.get('basic_operation') or {}).get('last_result') or {}
    require(legacy_result.get('code') == 'no_target', legacy_after)

    exact = json_command(
        lua_json(remote_call('autorio_operations', 'mine_entity_exact', str(fixture['chest_id']))),
        'exact remote mining admission',
    )
    require(exact is True, exact)
    exact_after = wait_until_idle(status, 'exact remote mining auto approach', 20)
    exact_result = (exact_after.get('basic_operation') or {}).get('last_result') or {}
    require(exact_result.get('code') == 'completed' and exact_result.get('completed') is True, exact_after)
    require(exact_result.get('target_unit_number') == fixture['chest_id'], exact_after)

    inventory = json_command(
        "/silent-command local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "rcon.print(helpers.table_to_json({wooden_chest=a.get_main_inventory().get_item_count('wooden-chest'),position=a.position}))",
        'exact mining inventory verification',
    )
    require(inventory.get('wooden_chest', 0) >= 1, inventory)

    payload = {
        'status': 'pass',
        'fixture': fixture,
        'observation': observed,
        'legacy_failure': legacy_after,
        'exact_success': exact_after,
        'inventory': inventory,
    }
    (results / 'exact-entity-mining.json').write_text(json.dumps(payload, indent=2))
    print(
        f"PASS: exact mining auto-approached unit={fixture['chest_id']} beyond legacy radius after name mining returned no_target",
        flush=True,
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
        (args.results / 'exact-entity-mining-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
