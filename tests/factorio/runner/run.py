#!/usr/bin/env python3
import argparse
import json
import socket
import struct
import sys
import time
from pathlib import Path

SERVERDATA_RESPONSE_VALUE = 0
SERVERDATA_EXECCOMMAND = 2
SERVERDATA_AUTH_RESPONSE = 2
SERVERDATA_AUTH = 3


class Rcon:
    def __init__(self, host: str, port: int, password: str):
        self.host = host
        self.port = port
        self.password = password
        self.sock: socket.socket | None = None
        self.request_id = 0

    def connect(self) -> None:
        self.sock = socket.create_connection((self.host, self.port), timeout=5)
        self._send(SERVERDATA_AUTH, self.password)
        while True:
            request_id, packet_type, _ = self._recv()
            if packet_type == SERVERDATA_AUTH_RESPONSE:
                if request_id == -1:
                    raise RuntimeError('RCON authentication failed')
                return

    def close(self) -> None:
        if self.sock:
            self.sock.close()
            self.sock = None

    def command(self, command: str) -> str:
        request_id = self._send(SERVERDATA_EXECCOMMAND, command)
        while True:
            response_id, packet_type, body = self._recv()
            if response_id == request_id and packet_type == SERVERDATA_RESPONSE_VALUE:
                return body.strip()

    def _send(self, packet_type: int, body: str) -> int:
        if not self.sock:
            raise RuntimeError('RCON is not connected')
        self.request_id += 1
        payload = struct.pack('<ii', self.request_id, packet_type) + body.encode() + b'\x00\x00'
        self.sock.sendall(struct.pack('<i', len(payload)) + payload)
        return self.request_id

    def _recv(self) -> tuple[int, int, str]:
        if not self.sock:
            raise RuntimeError('RCON is not connected')
        size = struct.unpack('<i', self._read_exact(4))[0]
        payload = self._read_exact(size)
        request_id, packet_type = struct.unpack('<ii', payload[:8])
        body = payload[8:-2].decode(errors='replace')
        return request_id, packet_type, body

    def _read_exact(self, size: int) -> bytes:
        if not self.sock:
            raise RuntimeError('RCON is not connected')
        data = bytearray()
        while len(data) < size:
            chunk = self.sock.recv(size - len(data))
            if not chunk:
                raise ConnectionError('RCON socket closed')
            data.extend(chunk)
        return bytes(data)


def connect_with_retry(host: str, port: int, password: str, timeout: float = 30.0) -> Rcon:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        client = Rcon(host, port, password)
        try:
            client.connect()
            return client
        except Exception as exc:
            last_error = exc
            client.close()
            time.sleep(0.5)
    raise RuntimeError(f'Factorio RCON did not become ready: {last_error}')


def lua_json(expr: str) -> str:
    return f"/silent-command rcon.print(helpers.table_to_json({expr}))"


def lua_text(expr: str) -> str:
    return f"/silent-command rcon.print(tostring({expr}))"


def remote_call(interface: str, method: str, *args: str) -> str:
    rendered = ', '.join([repr(interface), repr(method), *args])
    return f'remote.call({rendered})'


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def decode_json(response: str, context: str):
    if not response:
        raise RuntimeError(f'{context} returned an empty RCON response')
    try:
        return json.loads(response)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f'{context} returned non-JSON RCON output: {response!r}') from exc


def squared_distance(a: dict[str, float], b: dict[str, float]) -> float:
    return (a['x'] - b['x']) ** 2 + (a['y'] - b['y']) ** 2


def run(client: Rcon, results: Path) -> None:
    transcript: list[dict[str, object]] = []
    results.mkdir(parents=True, exist_ok=True)
    transcript_path = results / 'runner-transcript.json'

    def command(value: str) -> str:
        response = client.command(value)
        transcript.append({'command': value, 'response': response})
        transcript_path.write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def operation_status(context: str) -> dict:
        response = command(lua_json(remote_call('autorio_operations', 'status')))
        return decode_json(response, context)

    def actor_status(context: str) -> dict:
        response = command(lua_json(remote_call('autorio_actor', 'status')))
        return decode_json(response, context)

    # Factorio 2.0 requires the first Lua console command to be repeated before
    # it disables achievements and actually executes Lua. RCON receives an empty
    # response for the rejected first attempt, which previously looked like a
    # JSON parsing failure. Use a harmless, identical probe twice and require the
    # expected marker before running any test commands.
    lua_probe = '/silent-command rcon.print("AIRI_RCON_READY")'
    probe_response = command(lua_probe)
    if probe_response != 'AIRI_RCON_READY':
        probe_response = command(lua_probe)
    assert_true(
        probe_response == 'AIRI_RCON_READY',
        f'Factorio Lua console handshake failed over RCON: {probe_response!r}',
    )

    response = command(lua_json(remote_call('autorio_actor', 'set_mode', repr('npc'))))
    set_mode = decode_json(response, 'autorio_actor.set_mode')
    assert_true(set_mode[0] is True, f'could not enable npc mode: {set_mode!r}')

    status = actor_status('autorio_actor.status')
    assert_true(status['mode'] == 'npc', f"expected npc mode, got {status!r}")
    assert_true(status['connected_players'] == 0, f"NPC test unexpectedly has players: {status!r}")
    assert_true(status['actor'] is not None, f"standalone actor was not created: {status!r}")
    assert_true(status['actor']['valid'] is True, f"standalone actor is invalid: {status!r}")
    assert_true(status['actor']['kind'] == 'standalone_character', f"wrong actor kind: {status!r}")
    assert_true(isinstance(status['actor']['actor_id'], int), f"NPC has no stable unit identity: {status!r}")

    first_actor_id = status['actor']['actor_id']
    initial_position = status['actor']['position']
    second_status = actor_status('autorio_actor.status (repeat)')
    assert_true(second_status['actor']['actor_id'] == first_actor_id, 'actor resolution created or selected a different NPC')

    # Actor diagnostics return a scalar boolean, not a table, so they must not
    # be passed through helpers.table_to_json(). The diagnostic call itself also
    # exercises character-safe actor inspection in zero-player NPC mode.
    response = command(lua_text(remote_call('autorio_operations', 'log_actor_info')))
    assert_true(response == 'true', f'actor diagnostics failed in zero-player mode: {response!r}')

    # Exercise the real control.ts on_tick dispatcher with the simplest bounded
    # task. If control.ts still resolved game.connected_players[0], this task
    # would remain stuck forever with zero connected players.
    response = command(lua_json(remote_call('autorio_operations', 'wait', '3')))
    wait_result = decode_json(response, 'autorio_operations.wait')
    assert_true(wait_result[0] is True, f'could not start wait task: {wait_result!r}')

    deadline = time.monotonic() + 5.0
    wait_status = None
    while time.monotonic() < deadline:
        wait_status = operation_status('autorio_operations.status (wait)')
        if wait_status['task_state'] == 'idle':
            break
        time.sleep(0.05)

    assert_true(wait_status is not None, 'operation status was never returned')
    assert_true(wait_status['task_state'] == 'idle', f'zero-player control loop did not complete wait task: {wait_status!r}')
    assert_true(wait_status['actor']['actor_id'] == first_actor_id, f'control loop switched actors: {wait_status!r}')
    assert_true(wait_status.get('queue_empty') is True, f'wait task left queued work behind: {wait_status!r}')
    assert_true(wait_status.get('queue_length') == 0, f'wait task status did not expose an empty bounded queue: {wait_status!r}')

    # Create a deterministic, obstacle-free movement corridor. The test harness
    # owns this setup directly; production/model code still uses only Autorio's
    # structured operation interface. A wooden chest is unique on the test map,
    # so walk_to_entity cannot accidentally select a generated resource patch.
    movement_fixture = (
        "/silent-command "
        "local s=game.surfaces[1]; "
        "local tiles={}; "
        "for x=-2,12 do for y=-2,2 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "for _,e in pairs(s.find_entities_filtered{area={{-2,-2},{12,2}}}) do "
        "if e.name~='character' then e.destroy() end end; "
        "local target=s.create_entity{name='wooden-chest',position={x=10,y=0},force=game.forces.player}; "
        "rcon.print(helpers.table_to_json({created=target~=nil,position=target and target.position or nil}))"
    )
    fixture = decode_json(command(movement_fixture), 'movement fixture setup')
    assert_true(fixture['created'] is True, f'could not create deterministic movement target: {fixture!r}')
    target_position = fixture['position']

    response = command(lua_text(remote_call('autorio_operations', 'walk_to_entity', repr('wooden-chest'), '50')))
    assert_true(response == 'true', f'could not start movement task: {response!r}')

    deadline = time.monotonic() + 10.0
    movement_status = None
    while time.monotonic() < deadline:
        movement_status = operation_status('autorio_operations.status (movement)')
        if movement_status['task_state'] == 'idle':
            break
        time.sleep(0.05)

    assert_true(movement_status is not None, 'movement operation status was never returned')
    assert_true(movement_status['task_state'] == 'idle', f'NPC movement task did not return to idle: {movement_status!r}')
    assert_true(movement_status['actor']['actor_id'] == first_actor_id, f'movement switched actors: {movement_status!r}')

    moved_position = movement_status['actor']['position']
    assert_true(
        squared_distance(initial_position, moved_position) >= 4.0,
        f'NPC did not move a meaningful distance: start={initial_position!r}, end={moved_position!r}',
    )
    assert_true(
        squared_distance(moved_position, target_position) <= 16.0,
        f'NPC stopped too far from deterministic target: actor={moved_position!r}, target={target_position!r}',
    )

    final_status = actor_status('autorio_actor.status (final)')
    assert_true(final_status['connected_players'] == 0, f"a player appeared during NPC smoke test: {final_status!r}")
    assert_true(final_status['actor']['actor_id'] == first_actor_id, f"final actor identity changed: {final_status!r}")

    (results / 'runner.json').write_text(json.dumps({
        'status': 'pass',
        'actor_id': first_actor_id,
        'initial_position': initial_position,
        'movement_target': target_position,
        'final_position': final_status['actor']['position'],
        'transcript': transcript,
    }, indent=2))
    print(
        'PASS: zero-player NPC completed wait + movement '
        f'with stable actor_id={first_actor_id}, final_position={final_status["actor"]["position"]}'
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', type=Path, required=True)
    args = parser.parse_args()

    client: Rcon | None = None
    try:
        client = connect_with_retry(args.host, args.port, args.password)
        run(client, args.results)
        return 0
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / 'runner-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
