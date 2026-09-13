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


def run(client: Rcon, results: Path) -> None:
    transcript: list[dict[str, object]] = []
    results.mkdir(parents=True, exist_ok=True)
    transcript_path = results / 'runner-transcript.json'

    def command(value: str) -> str:
        response = client.command(value)
        transcript.append({'command': value, 'response': response})
        transcript_path.write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

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

    response = command(lua_json(remote_call('autorio_actor', 'status')))
    status = decode_json(response, 'autorio_actor.status')
    assert_true(status['mode'] == 'npc', f"expected npc mode, got {status!r}")
    assert_true(status['connected_players'] == 0, f"NPC test unexpectedly has players: {status!r}")
    assert_true(status['actor'] is not None, f"standalone actor was not created: {status!r}")
    assert_true(status['actor']['valid'] is True, f"standalone actor is invalid: {status!r}")
    assert_true(status['actor']['kind'] == 'standalone_character', f"wrong actor kind: {status!r}")
    assert_true(isinstance(status['actor']['actor_id'], int), f"NPC has no stable unit identity: {status!r}")

    first_actor_id = status['actor']['actor_id']
    response = command(lua_json(remote_call('autorio_actor', 'status')))
    second_status = decode_json(response, 'autorio_actor.status (repeat)')
    assert_true(second_status['actor']['actor_id'] == first_actor_id, 'actor resolution created or selected a different NPC')

    # Actor diagnostics must work without a LuaPlayer.
    response = command(lua_json(remote_call('autorio_operations', 'log_actor_info')))
    assert_true(decode_json(response, 'autorio_operations.log_actor_info') is True, f'actor diagnostics failed in zero-player mode: {response!r}')

    # Exercise the real control.ts on_tick dispatcher with the simplest bounded
    # task. If control.ts still resolved game.connected_players[0], this task
    # would remain stuck forever with zero connected players.
    response = command(lua_json(remote_call('autorio_operations', 'wait', '3')))
    wait_result = decode_json(response, 'autorio_operations.wait')
    assert_true(wait_result[0] is True, f'could not start wait task: {wait_result!r}')

    deadline = time.monotonic() + 5.0
    operation_status = None
    while time.monotonic() < deadline:
        response = command(lua_json(remote_call('autorio_operations', 'status')))
        operation_status = decode_json(response, 'autorio_operations.status')
        if operation_status['task_state'] == 'idle':
            break
        time.sleep(0.05)

    assert_true(operation_status is not None, 'operation status was never returned')
    assert_true(operation_status['task_state'] == 'idle', f'zero-player control loop did not complete wait task: {operation_status!r}')
    assert_true(operation_status['actor']['actor_id'] == first_actor_id, f'control loop switched actors: {operation_status!r}')

    response = command(lua_json(remote_call('autorio_actor', 'status')))
    final_status = decode_json(response, 'autorio_actor.status (final)')
    assert_true(final_status['connected_players'] == 0, f"a player appeared during NPC smoke test: {final_status!r}")

    (results / 'runner.json').write_text(json.dumps({'status': 'pass', 'transcript': transcript}, indent=2))
    print(f'PASS: zero-player NPC control loop completed a task with stable actor_id={first_actor_id}')


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
