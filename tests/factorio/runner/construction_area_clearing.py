"""Verify bounded construction-area clearing with heterogeneous live tree prototypes."""
import argparse
import json
import sys
import time
from pathlib import Path

from run import Rcon, connect_with_retry, decode_json, remote_call
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
        (results / 'construction-area-clearing-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str):
        return decode_json(command(text), context)

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        f"for _,e in pairs(s.find_entities_filtered{{name='character'}}) do if e.unit_number=={actor_id} then a=e end end; "
        "assert(a); remote.call('autorio_operations','cancel_all_tasks'); "
        "local trees={}; local rocks={}; local resources={}; for name,p in pairs(prototypes.entity) do "
        "if p.type=='tree' and p.mineable_properties and p.mineable_properties.minable then trees[#trees+1]=name end; "
        "if p.type=='simple-entity' and p.mineable_properties and p.mineable_properties.minable and not p.is_building then rocks[#rocks+1]=name end; "
        "if p.type=='resource' and p.mineable_properties and p.mineable_properties.minable and p.infinite_resource~=true then resources[#resources+1]=name end end; "
        "table.sort(trees); table.sort(rocks); table.sort(resources); "
        "local base=s.find_non_colliding_position('wooden-chest',{x=a.position.x+8,y=a.position.y},24,0.5); "
        "if not base then rcon.print(helpers.table_to_json({setup_ok=false,reason='no_base',tree_candidates=#trees,rock_candidates=#rocks,resource_candidates=#resources})); return end; "
        "local area={{base.x-4,base.y-4},{base.x+4,base.y+4}}; "
        "for _,e in pairs(s.find_entities_filtered{area=area}) do if e.valid and e~=a and e.type~='character' then e.destroy() end end; "
        "local outside_target={x=base.x+6,y=base.y}; for _,e in pairs(s.find_entities_filtered{position=outside_target,radius=1.5}) do if e.valid and e~=a and e.type~='character' then e.destroy() end end; "
        "local function create_inside(names,want,skip) for _,name in ipairs(names) do if name~=skip then "
        "local pos=s.find_non_colliding_position(name,want,0.75,0.25); "
        "if pos and math.abs(pos.x-base.x)<3.75 and math.abs(pos.y-base.y)<3.75 then local e=s.create_entity{name=name,position=pos}; if e then return e,name,pos end end end end return nil,nil,want end; "
        "local t1,tree1,p1=create_inside(trees,{x=base.x,y=base.y},nil); "
        "local t2,tree2,p2=create_inside(trees,{x=base.x+1.5,y=base.y+1.5},tree1); "
        "local rock,rock_name,pr=create_inside(rocks,{x=base.x-1.5,y=base.y+1.5},nil); "
        "local pres={x=base.x+1.5,y=base.y-1.5}; local res=nil; local resource_name=nil; "
        "for _,name in ipairs(resources) do local candidate=s.create_entity{name=name,position=pres,amount=1000}; if candidate then res=candidate; resource_name=name; break end end; "
        "local pb=s.find_non_colliding_position('wooden-chest',{x=base.x-1.5,y=base.y-1.5},0.75,0.25); "
        "local building=pb and s.create_entity{name='wooden-chest',position=pb,force=a.force} or nil; "
        "local po=tree1 and s.find_non_colliding_position(tree1,outside_target,1,0.25) or nil; "
        "local outside=(tree1 and po) and s.create_entity{name=tree1,position=po} or nil; "
        "local dx=base.x-a.position.x; local dy=base.y-a.position.y; local initial_distance=math.sqrt(dx*dx+dy*dy); "
        "local inv=a.get_main_inventory(); local inserted=inv.insert{name='wooden-chest',count=1}; "
        "local setup_ok=t1~=nil and t2~=nil and rock~=nil and res~=nil and building~=nil and outside~=nil and inserted==1 and initial_distance>a.resource_reach_distance+1; "
        "rcon.print(helpers.table_to_json({setup_ok=setup_ok,actor_id=a.unit_number,tree1=tree1,tree2=tree2,rock=rock_name,resource=resource_name,"
        "center=base,inside1=p1,inside2=p2,rock_position=pr,resource_position=pres,building_position=pb,outside=po,"
        "initial_distance=initial_distance,resource_reach=a.resource_reach_distance,chests=inv.get_item_count('wooden-chest'),"
        "tree_candidates=#trees,rock_candidates=#rocks,resource_candidates=#resources,created={tree1=t1~=nil,tree2=t2~=nil,rock=rock~=nil,resource=res~=nil,building=building~=nil,outside=outside~=nil},inserted=inserted}))",
        'construction area fixture',
    )
    require(fixture.get('setup_ok') is True, fixture)
    require(fixture['actor_id'] == actor_id and fixture['tree1'] != fixture['tree2'], fixture)
    require(fixture['chests'] >= 1, fixture)

    center = fixture['center']
    admission = json_command(
        "/silent-command "
        f"local clear={remote_call('autorio_operations', 'clear_construction_area', str(center['x']), str(center['y']), '8', '8')}; "
        f"local place={remote_call('autorio_operations', 'place_entity', repr('wooden-chest'), str(center['x']), str(center['y']))}; "
        "rcon.print(helpers.table_to_json({clear=clear,place=place}))",
        'clear then place admission',
    )
    require(admission.get('clear', [False])[0] is True, admission)
    require(admission.get('place') is True, admission)

    final = wait_until_idle(status, 'construction area clear then place', 30)
    receipt = final.get('last_completed_batch') or {}
    require(receipt.get('task_types') == ['clearing_area', 'placing'], final)

    verify = json_command(
        "/silent-command local s=game.surfaces[1]; "
        f"local p1={{x={fixture['inside1']['x']},y={fixture['inside1']['y']}}}; "
        f"local p2={{x={fixture['inside2']['x']},y={fixture['inside2']['y']}}}; "
        f"local pr={{x={fixture['rock_position']['x']},y={fixture['rock_position']['y']}}}; "
        f"local pres={{x={fixture['resource_position']['x']},y={fixture['resource_position']['y']}}}; "
        f"local pb={{x={fixture['building_position']['x']},y={fixture['building_position']['y']}}}; "
        f"local po={{x={fixture['outside']['x']},y={fixture['outside']['y']}}}; "
        f"local c={{x={center['x']},y={center['y']}}}; "
        f"local i1=#s.find_entities_filtered{{name={fixture['tree1']!r},position=p1,radius=0.3}}; "
        f"local i2=#s.find_entities_filtered{{name={fixture['tree2']!r},position=p2,radius=0.3}}; "
        f"local rock=#s.find_entities_filtered{{name={fixture['rock']!r},position=pr,radius=0.3}}; "
        f"local resource=#s.find_entities_filtered{{name={fixture['resource']!r},position=pres,radius=0.3}}; "
        "local building=#s.find_entities_filtered{name='wooden-chest',position=pb,radius=0.3}; "
        f"local o=#s.find_entities_filtered{{name={fixture['tree1']!r},position=po,radius=0.3}}; "
        "local chest=#s.find_entities_filtered{name='wooden-chest',position=c,radius=0.3}; "
        "rcon.print(helpers.table_to_json({inside1=i1,inside2=i2,rock=rock,resource=resource,building=building,outside=o,chest=chest}))",
        'construction area verification',
    )
    require(verify.get('inside1') == 0 and verify.get('inside2') == 0, verify)
    require(verify.get('rock') == 0, verify)
    require(verify.get('resource') == 1, verify)
    require(verify.get('building') == 1, verify)
    require(verify.get('outside') == 1, verify)
    require(verify.get('chest') == 1, verify)

    payload = {
        'status': 'pass',
        'fixture': fixture,
        'admission': admission,
        'final_status': final,
        'verification': verify,
    }
    (results / 'construction-area-clearing.json').write_text(json.dumps(payload, indent=2))
    print(
        'PASS: heterogeneous finite blockers were cleared only inside the bounded footprint; '
        'resource/building/outside entities remained and queued construction resumed automatically',
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
        (args.results / 'construction-area-clearing-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
