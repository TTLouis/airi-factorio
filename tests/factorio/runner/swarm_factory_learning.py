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
    transcript_path = results / 'swarm-factory-learning-transcript.json'
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

    verify_free_running_ticks(command, results)

    swarm = call('autorio_swarm', 'status')
    actors = sorted(swarm.get('actors') or [], key=lambda entry: entry['actorId'])
    assert_true(len(actors) >= 2, f'factory learning gate requires two swarm actors: {swarm!r}')
    first = actors[0]
    second = actors[1]
    first_id = first['actorId']
    second_id = second['actorId']
    first_agent = first['agent']['id']
    second_agent = second['agent']['id']
    first_physical = first['runtime']['physical']['physicalActorId']
    second_physical = second['runtime']['physical']['physicalActorId']

    fixture_command = (
        "/silent-command "
        "local s=game.surfaces[1]; local tiles={}; "
        "for x=24,36 do for y=-4,4 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "for _,e in pairs(s.find_entities_filtered{area={{24,-4},{36,4}}}) do if e.name~='character' then e.destroy() end end; "
        "local r=game.forces.player.recipes['iron-gear-wheel']; if r then r.enabled=true end; "
        "local m=s.create_entity{name='assembling-machine-1',position={30,0},force='player'}; "
        "local recipe_set=false; if m then m.set_recipe('iron-gear-wheel'); local rr=m.get_recipe(); recipe_set=rr~=nil and rr.name=='iron-gear-wheel' end; "
        "rcon.print(helpers.table_to_json({machine=m~=nil,recipe_set=recipe_set,unit=m and m.unit_number or 0}))"
    )
    fixture = decode_json(command(fixture_command), 'factory learning fixture')
    assert_true(fixture.get('machine') is True and fixture.get('recipe_set') is True, f'could not create deterministic factory fixture: {fixture!r}')

    request = "{surface_index=1,area={left_top={x=24,y=-4},right_bottom={x=36,y=4}}}"
    first_analysis = call('autorio_swarm_learning', 'analyze_area', repr(first_id), request)
    assert_true(first_analysis.get('ok') is True, f'first swarm factory analysis failed: {first_analysis!r}')
    assert_true(first_analysis['observer']['agent_id'] == first_agent, f'first analysis lost agent provenance: {first_analysis!r}')
    assert_true(first_analysis['observer']['actor_id'] == first_id, f'first analysis lost actor provenance: {first_analysis!r}')
    first_analysis_id = first_analysis['analysis_id']
    first_observation_id = first_analysis['observer']['observation_id']

    first_status = call('autorio_swarm_learning', 'status', repr(first_analysis_id))
    assert_true(first_status.get('found') is True, f'first analysis was not persisted: {first_status!r}')
    assert_true((first_status.get('provenance') or {}).get('agentId') == first_agent, f'persisted first provenance is wrong: {first_status!r}')
    blocks = call('autorio_swarm_learning', 'list_blocks', repr(first_analysis_id))
    target = next((block for block in blocks if 'iron-gear-wheel' in (block.get('outputs') or [])), None)
    assert_true(target is not None, f'factory analysis did not identify iron gear output block: {blocks!r}')

    first_candidate = call('autorio_swarm_learning', 'create_candidate_from_block', repr(first_analysis_id), repr(target['block_id']))
    assert_true(first_candidate.get('ok') is True, f'first shared skill candidate failed: {first_candidate!r}')
    skill_id = first_candidate['skill_id']
    first_revision = first_candidate['revision']
    first_skill = call('autorio_skills', 'get', repr(skill_id))
    assert_true(first_skill.get('status') == 'candidate', f'factory observation was incorrectly promoted to verified: {first_skill!r}')
    assert_true(f'swarm-observation:{first_observation_id}' in (first_skill.get('source') or {}).get('evidence_refs', []), f'first skill lacks swarm observation evidence: {first_skill!r}')
    assert_true(any(first_agent in text and first_id in text for text in (first_skill.get('confidence') or {}).get('basis', [])), f'first skill lacks logical observer provenance: {first_skill!r}')

    second_analysis = call('autorio_swarm_learning', 'analyze_area', repr(second_id), request)
    assert_true(second_analysis.get('ok') is True, f'second swarm factory analysis failed: {second_analysis!r}')
    assert_true(second_analysis['observer']['agent_id'] == second_agent, f'second analysis lost agent provenance: {second_analysis!r}')
    assert_true(second_analysis['observer']['actor_id'] == second_id, f'second analysis lost actor provenance: {second_analysis!r}')
    second_analysis_id = second_analysis['analysis_id']
    second_observation_id = second_analysis['observer']['observation_id']
    second_blocks = call('autorio_swarm_learning', 'list_blocks', repr(second_analysis_id))
    second_target = next((block for block in second_blocks if 'iron-gear-wheel' in (block.get('outputs') or [])), None)
    assert_true(second_target is not None, f'second analysis lost shared factory block: {second_blocks!r}')

    second_candidate = call('autorio_swarm_learning', 'create_candidate_from_block', repr(second_analysis_id), repr(second_target['block_id']))
    assert_true(second_candidate.get('ok') is True, f'second shared skill candidate failed: {second_candidate!r}')
    assert_true(second_candidate['skill_id'] == skill_id, f'equivalent learned block did not reuse shared skill identity: {second_candidate!r}')
    assert_true(second_candidate['revision'] == first_revision + 1, f'second observer overwrote instead of revising shared skill: first={first_candidate!r}, second={second_candidate!r}')
    second_skill = call('autorio_skills', 'get', repr(skill_id))
    assert_true(second_skill.get('revision') == first_revision + 1, f'shared skill registry did not retain newest revision: {second_skill!r}')
    assert_true(f'swarm-observation:{second_observation_id}' in (second_skill.get('source') or {}).get('evidence_refs', []), f'second revision lacks second observation evidence: {second_skill!r}')
    assert_true(any(second_agent in text and second_id in text for text in (second_skill.get('confidence') or {}).get('basis', [])), f'second revision lacks second observer provenance: {second_skill!r}')

    final = call('autorio_swarm', 'status')
    final_by_id = {entry['actorId']: entry for entry in final.get('actors') or []}
    assert_true(final_by_id[first_id]['runtime']['physical']['physicalActorId'] == first_physical, f'factory learning changed first physical actor identity: {final_by_id[first_id]!r}')
    assert_true(final_by_id[second_id]['runtime']['physical']['physicalActorId'] == second_physical, f'factory learning changed second physical actor identity: {final_by_id[second_id]!r}')

    result = {
        'status': 'pass',
        'first_actor_id': first_id,
        'second_actor_id': second_id,
        'first_agent_id': first_agent,
        'second_agent_id': second_agent,
        'first_analysis_id': first_analysis_id,
        'second_analysis_id': second_analysis_id,
        'skill_id': skill_id,
        'first_revision': first_revision,
        'second_revision': second_candidate['revision'],
        'transcript': transcript,
    }
    (results / 'swarm-factory-learning.json').write_text(json.dumps(result, indent=2))
    print(
        'PASS: two swarm agents independently observed one factory block, retained exact observer provenance, '
        f'and revised shared skill {skill_id} from r{first_revision} to r{second_candidate["revision"]}'
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
        (args.results / 'swarm-factory-learning-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
