#!/usr/bin/env python3
import argparse
import json
import sys
import time
from pathlib import Path

from run import assert_true, connect_with_retry, decode_json, lua_json, remote_call
from runtime import verify_free_running_ticks


def is_lua_sequence(value: object) -> bool:
    # Factorio serializes an empty Lua table as {}, while populated array-like
    # tables serialize as JSON arrays. Accept both representations here.
    return isinstance(value, list) or value == {}


def run(client, results: Path) -> None:
    transcript: list[dict[str, object]] = []
    results.mkdir(parents=True, exist_ok=True)
    transcript_path = results / 'swarm-map-remote-transcript.json'
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

    # The actor-scoped learning pipeline used to exist as a module without being
    # registered in control.ts. A real remote call makes that wiring part of the
    # live Factorio contract instead of only a unit-test assumption.
    learning = call('autorio_swarm_learning_pipeline', 'status')
    assert_true('policy' in learning, f'swarm learning pipeline remote is not live: {learning!r}')
    assert_true(is_lua_sequence(learning.get('opportunities')), f'learning status lacks opportunities: {learning!r}')
    assert_true(is_lua_sequence(learning.get('verification_queue')), f'learning status lacks verification queue: {learning!r}')

    swarm = call('autorio_swarm', 'status')
    actors = sorted(swarm.get('actors') or [], key=lambda entry: entry['actorId'])
    assert_true(len(actors) >= 2, f'map gate requires two live swarm actors: {swarm!r}')
    target = actors[0]
    actor_id = target['actorId']
    agent_id = target['agent']['id']
    runtime = target['runtime']
    actor = target['actor']
    before_revision = runtime['bodyRevision']
    before_physical = runtime['physical']['physicalActorId']
    position = actor['position']

    context = call('autorio_swarm_map', 'context', repr(actor_id))
    assert_true(context.get('ok') is True, f'swarm map context failed: {context!r}')
    observer = context.get('observer') or {}
    assert_true(observer.get('actor_id') == actor_id, f'map context crossed logical actor identity: {context!r}')
    assert_true(observer.get('agent_id') == agent_id, f'map context crossed agent identity: {context!r}')
    assert_true(observer.get('body_revision') == before_revision, f'map context has stale body revision: {context!r}')
    assert_true((context.get('policy') or {}).get('actor_scoped') is True, f'map context lacks actor-scoped policy: {context!r}')

    # A zero-player test save intentionally starts with no charted map. First
    # prove the production map service fails closed, then explicitly chart a
    # bounded test area using Factorio's own LuaForce.chart API. The product
    # interface itself never bypasses chart/visibility policy.
    prechart_query = call(
        'autorio_swarm_map',
        'query_area',
        repr(actor_id),
        '1',
        repr(position['x']),
        repr(position['y']),
        '4',
        '16',
    )
    assert_true(
        prechart_query.get('ok') is False and prechart_query.get('code') == 'area_uncharted',
        f'uncharted map query did not fail closed: {prechart_query!r}',
    )
    prechart_observer = prechart_query.get('observer') or {}
    assert_true(prechart_observer.get('actor_id') == actor_id, f'uncharted query lost actor provenance: {prechart_query!r}')
    assert_true(prechart_observer.get('body_revision') == before_revision, f'uncharted query lost body revision: {prechart_query!r}')

    chart_radius = 64
    left = position['x'] - chart_radius
    top = position['y'] - chart_radius
    right = position['x'] + chart_radius
    bottom = position['y'] + chart_radius
    chart_command = (
        '/silent-command '
        f'game.forces["player"].chart(game.surfaces[1], '
        f'{{{{x={left}, y={top}}}, {{x={right}, y={bottom}}}}})'
    )
    command(chart_command)

    query = call(
        'autorio_swarm_map',
        'query_area',
        repr(actor_id),
        '1',
        repr(position['x']),
        repr(position['y']),
        '4',
        '16',
    )
    assert_true(query.get('ok') is True, f'live actor-local map query failed after explicit charting: {query!r}')
    query_observer = query.get('observer') or {}
    assert_true(query_observer.get('actor_id') == actor_id, f'map query lost actor provenance: {query!r}')
    assert_true(query_observer.get('body_revision') == before_revision, f'map query lost body revision: {query!r}')

    destroyed = call('autorio_swarm', 'destroy_body', repr(actor_id))
    assert_true(destroyed.get('ok') is True, f'could not destroy body for map stale-body gate: {destroyed!r}')

    missing = call('autorio_swarm_map', 'context', repr(actor_id))
    assert_true(missing.get('ok') is False and missing.get('code') == 'no_body', f'map service accepted a missing/stale body: {missing!r}')

    replaced = call(
        'autorio_swarm',
        'replace_body',
        repr(actor_id),
        repr(position['x']),
        repr(position['y']),
        '1',
        repr('player'),
    )
    assert_true(replaced.get('ok') is True, f'could not replace body for map rebind gate: {replaced!r}')
    after_runtime = replaced['runtime']
    after_revision = after_runtime['bodyRevision']
    after_physical = after_runtime['physical']['physicalActorId']
    assert_true(after_revision > before_revision, f'body revision did not advance after replacement: before={before_revision}, after={after_runtime!r}')
    assert_true(after_physical != before_physical, f'physical body id did not change after replacement: before={before_physical}, after={after_physical}')

    rebound = call('autorio_swarm_map', 'context', repr(actor_id))
    assert_true(rebound.get('ok') is True, f'map service did not rebind replacement body: {rebound!r}')
    rebound_observer = rebound.get('observer') or {}
    assert_true(rebound_observer.get('actor_id') == actor_id, f'rebound map context changed logical actor: {rebound!r}')
    assert_true(rebound_observer.get('body_revision') == after_revision, f'rebound map context retained stale body revision: {rebound!r}')

    rebound_query = call(
        'autorio_swarm_map',
        'query_area',
        repr(actor_id),
        '1',
        repr(position['x']),
        repr(position['y']),
        '4',
        '16',
    )
    assert_true(rebound_query.get('ok') is True, f'map query failed after replacement: {rebound_query!r}')
    assert_true((rebound_query.get('observer') or {}).get('body_revision') == after_revision, f'post-replacement query used stale provenance: {rebound_query!r}')

    result = {
        'status': 'pass',
        'actor_id': actor_id,
        'agent_id': agent_id,
        'before_body_revision': before_revision,
        'after_body_revision': after_revision,
        'before_physical_actor_id': before_physical,
        'after_physical_actor_id': after_physical,
        'prechart_code': prechart_query.get('code'),
        'query_returned_count': query.get('returned_count'),
        'rebound_query_returned_count': rebound_query.get('returned_count'),
        'learning_policy': learning.get('policy'),
        'transcript': transcript,
    }
    (results / 'swarm-map-remote.json').write_text(json.dumps(result, indent=2))
    print(
        'PASS: actor-scoped map remote rejected uncharted access, preserved logical provenance, '
        f'rejected a missing body, and rebound {actor_id} from body revision {before_revision} to {after_revision}; '
        'swarm learning pipeline remote is live'
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
        (args.results / 'swarm-map-remote-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
