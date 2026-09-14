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
    transcript_path = results / 'swarm-production-transcript.json'
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

    def work_status(work_id: str):
        value = swarm_call('work_status', repr(work_id))
        assert_true(value.get('found') is True, f'production work missing: {work_id}: {value!r}')
        return value

    def wait_until(predicate, observe, context: str, timeout: float = 30.0, interval: float = 0.1):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = observe()
            if predicate(last):
                return last
            time.sleep(interval)
        raise AssertionError(f'{context} timed out: {last!r}')

    verify_free_running_ticks(command, results)

    swarm = swarm_call('status')
    actors = sorted(swarm.get('actors') or [], key=lambda entry: entry['actorId'])
    assert_true(len(actors) == 2, f'production gate requires exactly two existing swarm actors: {swarm!r}')
    assert_true(all((entry.get('agent') or {}).get('state') == 'available' for entry in actors), f'production actors are not both available: {actors!r}')
    first = actors[0]
    second = actors[1]
    first_id = first['actorId']
    second_id = second['actorId']
    first_agent = first['agent']['id']
    second_agent = second['agent']['id']
    first_physical = first['runtime']['physical']['physicalActorId']
    second_physical = second['runtime']['physical']['physicalActorId']

    # Deterministic real-engine production fixture. Actor 1 starts beside the
    # stone source and can reach the chest through the transfer radius without
    # walking to it. Actor 2 starts beside the chest. This lets global scoring
    # naturally select A for gather+deposit and B for pickup+craft.
    fixture_command = (
        "/silent-command "
        "local s=game.surfaces[1]; local tiles={}; "
        "for x=-12,8 do for y=-5,5 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "for _,e in pairs(s.find_entities_filtered{area={{-12,-5},{8,5}}}) do if e.name~='character' then e.destroy() end end; "
        f"local a={first_physical}; local b={second_physical}; "
        "local moved_a=false; local moved_b=false; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        "local inv=e.get_inventory(defines.inventory.character_main); if inv then inv.clear() end; "
        "if e.unit_number==a then moved_a=e.teleport({-8,0}) elseif e.unit_number==b then moved_b=e.teleport({1,0}) end end; "
        "local stone=s.create_entity{name='stone',position={-6,0},amount=100}; "
        "local chest=s.create_entity{name='wooden-chest',position={-1,0},force='player'}; "
        "rcon.print(helpers.table_to_json({moved_a=moved_a,moved_b=moved_b,stone=stone~=nil,chest=chest~=nil}))"
    )
    fixture = decode_json(command(fixture_command), 'cooperative production fixture')
    assert_true(fixture == {'moved_a': True, 'moved_b': True, 'stone': True, 'chest': True}, f'could not establish production fixture: {fixture!r}')

    created = coordination_call(
        'create_cooperative_craft_mission',
        repr('cooperative stone furnace'),
        repr('stone'),
        repr('stone'),
        '5',
        '-6',
        '0',
        repr('wooden-chest'),
        '-1',
        '0',
        repr('stone-furnace'),
        '1',
        '80',
        '1',
    )
    assert_true(created.get('ok') is True, f'could not create cooperative production mission: {created!r}')
    mission_id = created['missionId']

    mission_done = wait_until(
        lambda value: (value.get('mission') or {}).get('status') == 'satisfied',
        lambda: coordination_call('mission_status', repr(mission_id)),
        'cooperative production mission completion',
    )
    assert_true(all(obj.get('status') == 'satisfied' for obj in mission_done.get('objectives') or []), f'production objective not satisfied: {mission_done!r}')

    gather = work_status(created['gatherWorkId'])
    delivery = work_status(created['deliveryWorkId'])
    acquire = work_status(created['acquireWorkId'])
    craft = work_status(created['craftWorkId'])
    for label, value in [('gather', gather), ('delivery', delivery), ('acquire', acquire), ('craft', craft)]:
        assert_true((value.get('work') or {}).get('status') == 'completed', f'{label} work not completed: {value!r}')
        assert_true(len(value.get('results') or []) >= 1, f'{label} work has no result evidence: {value!r}')
        assert_true(len((value.get('work') or {}).get('evidence') or []) >= 1, f'{label} work has no evidence: {value!r}')

    assert_true(gather['results'][-1]['agentId'] == first_agent, f'near-resource actor did not gather: {gather!r}')
    assert_true(delivery['results'][-1]['agentId'] == first_agent, f'item-carrying actor did not stage material: {delivery!r}')
    assert_true(acquire['results'][-1]['agentId'] == second_agent, f'near-handoff second actor did not collect staged material: {acquire!r}')
    assert_true(craft['results'][-1]['agentId'] == second_agent, f'second actor did not perform final craft: {craft!r}')

    craft_observations = [
        value for value in (craft.get('work') or {}).get('evidence') or []
        if value.get('kind') == 'observation'
    ]
    assert_true(len(craft_observations) >= 1, f'craft completion lacks operation receipt evidence: {craft!r}')

    final_second = swarm_call('status', repr(second_id))
    final_physical = final_second['runtime']['physical']['physicalActorId']
    inventory_check = decode_json(command(
        "/silent-command local s=game.surfaces[1]; local n=0; local chest=0; "
        f"for _,e in pairs(s.find_entities_filtered{{name='character'}}) do if e.unit_number=={final_physical} then "
        "local inv=e.get_inventory(defines.inventory.character_main); if inv then n=inv.get_item_count('stone-furnace') end end end; "
        "for _,e in pairs(s.find_entities_filtered{name='wooden-chest',position={-1,0},radius=2}) do "
        "local inv=e.get_inventory(defines.inventory.chest); if inv then chest=chest+inv.get_item_count('stone') end end; "
        "rcon.print(helpers.table_to_json({stone_furnace=n,chest_stone=chest}))"
    ), 'final cooperative production inventory')
    assert_true(inventory_check['stone_furnace'] >= 1, f'second actor lacks real stone-furnace output: {inventory_check!r}')
    assert_true(inventory_check['chest_stone'] == 0, f'handoff chest still contains staged stone after pickup: {inventory_check!r}')

    result = {
        'status': 'pass',
        'mission_id': mission_id,
        'first_actor_id': first_id,
        'second_actor_id': second_id,
        'first_agent_id': first_agent,
        'second_agent_id': second_agent,
        'work_ids': created['workIds'],
        'gather': gather,
        'delivery': delivery,
        'acquire': acquire,
        'craft': craft,
        'final_inventory': inventory_check,
        'transcript': transcript,
    }
    (results / 'swarm-production.json').write_text(json.dumps(result, indent=2))
    print(
        'PASS: two swarm NPCs cooperated through real stone mining, chest handoff, '
        'second-agent pickup, and native stone-furnace crafting'
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
        (args.results / 'swarm-production-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
