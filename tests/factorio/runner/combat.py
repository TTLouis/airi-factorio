"""Prove bounded standalone-character combat with real weapons and enemy entities."""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, lua_text, remote_call
from runtime import operation_status_command, validate_clock, wait_until_idle


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def assert_actor(observation: dict, actor_id: int) -> None:
    validate_clock(observation['runtime'])
    actor = observation['actor']
    require(actor['valid'] is True and actor['kind'] == 'standalone_character', observation)
    require(actor['actor_id'] == actor_id, observation)
    require(observation['runtime']['connected_players'] == 0, observation)


def assert_stopped(observation: dict, actor_id: int) -> None:
    assert_actor(observation, actor_id)
    require(observation['task_state'] == 'idle', observation)
    require(observation['queue_empty'] is True and observation['queue_length'] == 0, observation)
    require(observation['walking'] is False and observation['mining'] is False and observation['shooting'] is False, observation)


def assert_kill(before: dict, after: dict, combat: dict, actor_id: int) -> None:
    assert_stopped(after, actor_id)
    require(before['target_alive'] is True and before['target_health'] > 0, before)
    require(after['target_alive'] is False, 'target must actually be gone; idle is not a kill')
    require(after['ammo'] < before['ammo'], 'real character weapon must consume ammunition')
    require(after['actor_health'] > 0, 'AIRI died during the combat fixture')
    require(after['runtime']['tick'] > before['runtime']['tick'], 'combat consumed no simulation time')
    result = combat.get('last_result') or {}
    require(result.get('completed') is True and result.get('code') == 'target_destroyed', combat)
    require(result.get('target_unit_number') == before['target_id'], (before, combat))


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    transcript = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'combat-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def combat_status() -> dict:
        return json_command(lua_json(remote_call('autorio_combat', 'status')), 'combat status')

    original_id = json.loads((results / 'runner.json').read_text())['actor_id']
    initial = status('before combat')
    require(initial['actor']['actor_id'] == original_id and initial['task_state'] == 'idle', initial)

    # Build an open deterministic arena around the existing NPC. Removing the
    # earlier test fixtures here is test-owned cleanup; production Autorio no
    # longer deletes world enemies during setup.
    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local f=game.forces.player; local enemy=game.forces.enemy; "
        "local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'original NPC missing'); "
        "for _,e in pairs(s.find_entities_filtered{position=a.position,radius=45}) do "
        "if e~=a and e.force~=enemy then e.destroy() end end; "
        "for _,e in pairs(s.find_entities_filtered{position=a.position,radius=45,force=enemy}) do e.destroy() end; "
        "local tiles={}; for x=math.floor(a.position.x)-45,math.floor(a.position.x)+45 do "
        "for y=math.floor(a.position.y)-12,math.floor(a.position.y)+12 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "local guns=a.get_inventory(defines.inventory.character_guns); local ammo=a.get_inventory(defines.inventory.character_ammo); "
        "guns.clear(); ammo.clear(); assert(guns.insert{name='pistol',count=1}==1); "
        "assert(ammo.insert{name='firearm-magazine',count=20}==20); a.selected_gun_index=1; "
        "local target=s.create_entity{name='small-biter',position={x=a.position.x+20,y=a.position.y},force=enemy}; assert(target); "
        "rcon.print(helpers.table_to_json({target_id=target.unit_number,target_health=target.health,ammo=ammo.get_item_count('firearm-magazine'),actor_health=a.health,position=a.position}))",
        'combat fixture',
    )
    require(fixture['target_health'] > 0 and fixture['ammo'] == 20, fixture)
    target_id = fixture['target_id']

    observation_command = (
        "/silent-command local s=game.surfaces[1]; local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'original NPC missing'); "
        f"local target=nil; for _,e in pairs(s.find_entities_filtered{{force=game.forces.enemy}}) do if e.unit_number=={target_id} then target=e end end; "
        "local o=remote.call('autorio_operations','status'); "
        "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
        "o.walking=a.walking_state.walking; o.mining=a.mining_state.mining; "
        "o.shooting=a.shooting_state.state~=defines.shooting.not_shooting; "
        "o.actor_health=a.health; o.position=a.position; "
        "o.ammo=a.get_inventory(defines.inventory.character_ammo).get_item_count('firearm-magazine'); "
        "o.target_alive=target~=nil and target.valid; o.target_health=target and target.health or 0; "
        f"o.target_id={target_id}; rcon.print(helpers.table_to_json(o))"
    )

    def observe() -> dict:
        value = json_command(observation_command, 'combat observation')
        assert_actor(value, original_id)
        return value

    before = observe()
    result = json_command(lua_json(remote_call('autorio_operations', 'attack_nearest_enemy', '40')), 'combat start')
    require(result == [True, 'Combat task queued'], result)
    wait_until_idle(status, 'combat target kill', 60)
    after = observe()
    combat = combat_status()
    assert_kill(before, after, combat, original_id)

    # No target is an explicit failure, not a successful empty combat task.
    no_target = json_command(lua_json(remote_call('autorio_operations', 'attack_nearest_enemy', '20')), 'no-target combat')
    require(no_target[0] is True, no_target)
    wait_until_idle(status, 'combat no target', 5)
    no_target_status = combat_status()
    require(no_target_status['last_result']['code'] == 'no_target', no_target_status)
    assert_stopped(observe(), original_id)

    # A live target with no ammunition must remain alive and must not make
    # dependent queued work execute as though the attack succeeded.
    no_ammo_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a); "
        "local ammo=a.get_inventory(defines.inventory.character_ammo); ammo.clear(); "
        "local t=s.create_entity{name='small-biter',position={x=a.position.x+8,y=a.position.y},force=game.forces.enemy}; assert(t); "
        "rcon.print(helpers.table_to_json({id=t.unit_number,health=t.health}))",
        'no-ammo fixture',
    )
    command(lua_text(remote_call('autorio_operations', 'attack_nearest_enemy', '20')))
    command(lua_text(remote_call('autorio_operations', 'wait', '120')))
    wait_until_idle(status, 'combat no ammo', 5)
    no_ammo_status = combat_status()
    require(no_ammo_status['last_result']['code'] == 'no_weapon_or_ammo', no_ammo_status)
    survivor = json_command(
        "/silent-command local found=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{force=game.forces.enemy}) do "
        f"if e.unit_number=={no_ammo_fixture['id']} then found=e end end; "
        "rcon.print(helpers.table_to_json({alive=found~=nil and found.valid,health=found and found.health or 0,task=remote.call('autorio_operations','status')}))",
        'no-ammo survivor',
    )
    require(survivor['alive'] is True and survivor['health'] == no_ammo_fixture['health'], survivor)
    require(survivor['task']['queue_length'] == 0 and survivor['task']['task_state'] == 'idle', survivor)

    # Cancellation while approaching must release physical controls. The target
    # is placed out of pistol range so it cannot be damaged before cancellation.
    cancel_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a); "
        "for _,e in pairs(s.find_entities_filtered{force=game.forces.enemy}) do e.destroy() end; "
        "local ammo=a.get_inventory(defines.inventory.character_ammo); ammo.clear(); ammo.insert{name='firearm-magazine',count=20}; "
        "local t=s.create_entity{name='small-biter',position={x=a.position.x+30,y=a.position.y},force=game.forces.enemy}; assert(t); "
        "rcon.print(helpers.table_to_json({id=t.unit_number,health=t.health,position=a.position}))",
        'combat cancellation fixture',
    )
    command(lua_text(remote_call('autorio_operations', 'attack_nearest_enemy', '50')))
    time.sleep(0.75)
    moving = observe()
    require(moving['task_state'] == 'attacking' and moving['walking'] is True, moving)
    require(command(lua_text(remote_call('autorio_operations', 'cancel_all_tasks'))) == 'true', 'combat cancellation call failed')
    cancelled = observe()
    assert_stopped(cancelled, original_id)
    cancel_position = cancelled['position']
    time.sleep(2)
    quiet = observe()
    assert_stopped(quiet, original_id)
    dx = quiet['position']['x'] - cancel_position['x']
    dy = quiet['position']['y'] - cancel_position['y']
    require(dx * dx + dy * dy < 0.01, (cancel_position, quiet['position']))
    cancel_target = json_command(
        "/silent-command local found=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{force=game.forces.enemy}) do "
        f"if e.unit_number=={cancel_fixture['id']} then found=e end end; "
        "rcon.print(helpers.table_to_json({alive=found~=nil and found.valid,health=found and found.health or 0}))",
        'cancelled target',
    )
    require(cancel_target['alive'] is True and cancel_target['health'] == cancel_fixture['health'], cancel_target)

    (results / 'combat.json').write_text(json.dumps({
        'status': 'pass', 'actor_id': original_id,
        'kill_before': before, 'kill_after': after, 'kill_result': combat,
        'no_target': no_target_status, 'no_ammo': no_ammo_status,
        'cancelled': quiet,
    }, indent=2))
    print(f'PASS: zero-player NPC bounded combat + failure/cancellation semantics with stable actor_id={original_id}', flush=True)


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
        (args.results / 'combat-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
