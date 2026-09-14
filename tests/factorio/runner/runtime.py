"""Clock-aware waits for the zero-player Factorio integration runners."""
import json
import math
import os
import time
from collections.abc import Callable
from pathlib import Path


CLOCK_COMMAND = (
    '/silent-command rcon.print(helpers.table_to_json({'
    'tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,'
    'connected_players=#game.connected_players}))'
)


def operation_status_command() -> str:
    # Keep production status unchanged; add timing only to the test observation.
    return (
        "/silent-command local s=remote.call('autorio_operations','status'); "
        's.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,'
        'connected_players=#game.connected_players}; '
        'rcon.print(helpers.table_to_json(s))'
    )


def validate_clock(clock: dict) -> None:
    if type(clock.get('tick')) is not int or clock['tick'] < 0:
        raise AssertionError(f'missing or invalid simulation tick: {clock!r}')
    if clock.get('connected_players') != 0:
        raise AssertionError(f'zero-player test has connected players: {clock!r}')
    if clock.get('tick_paused') is not False:
        raise AssertionError(f'Factorio entity updates are paused: {clock!r}')
    speed = clock.get('speed')
    if not isinstance(speed, (int, float)) or not math.isfinite(speed) or speed <= 0:
        raise AssertionError(f'invalid Factorio simulation speed: {clock!r}')


def verify_free_running_ticks(command: Callable[[str], str], results: Path) -> dict:
    # A paused multiplayer server may still execute one update per RCON command.
    # tick_paused=false alone does NOT prove that server auto-pause is disabled.
    # Send only these two observations, leaving a quiet interval between them.
    before = json.loads(command(CLOCK_COMMAND))
    started = time.monotonic()
    time.sleep(2.0)
    after = json.loads(command(CLOCK_COMMAND))
    elapsed = time.monotonic() - started
    record = {
        'status': 'fail',
        'before': before,
        'after': after,
        'quiet_wall_seconds': elapsed,
    }
    results.mkdir(parents=True, exist_ok=True)
    path = results / 'simulation-clock.json'
    path.write_text(json.dumps(record, indent=2))
    validate_clock(before)
    validate_clock(after)
    advanced = after['tick'] - before['tick']
    record['advanced_ticks'] = advanced
    record['observed_ups'] = advanced / max(elapsed, 0.001)
    path.write_text(json.dumps(record, indent=2))
    if advanced < 3:
        raise AssertionError(
            'zero-player simulation did not advance independently of RCON: '
            f'{record!r}. Check --server-settings, auto_pause=false, and server load.'
        )
    record['status'] = 'pass'
    path.write_text(json.dumps(record, indent=2))
    print(
        'PASS: zero-player simulation advances without RCON polling '
        f'({advanced} ticks in {elapsed:.2f}s, observed UPS={record["observed_ups"]:.1f})',
        flush=True,
    )
    return record


def wait_until_idle(
    read_status: Callable[[str], dict],
    context: str,
    timeout: float = 10.0,
    *,
    wall_timeout: float | None = None,
) -> dict:
    """Use a fixed simulation budget plus a separate bounded wall-clock cap.

    timeout is nominal simulation seconds (60 ticks each), not host elapsed
    seconds. Neither budget resets when mining/crafting progress changes.
    """
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('simulation timeout must be a finite positive number')
    if wall_timeout is None:
        wall_timeout = float(os.environ.get('NPC_TEST_WALL_TIMEOUT', '120'))
    if not math.isfinite(wall_timeout) or wall_timeout <= 0:
        raise ValueError('NPC_TEST_WALL_TIMEOUT must be a finite positive number')

    tick_budget = math.ceil(timeout * 60)
    started = time.monotonic()
    first_tick: int | None = None
    previous_tick: int | None = None
    last_tick_change = started

    while True:
        status = read_status(context)
        now = time.monotonic()
        runtime = status.get('runtime', {})
        validate_clock(runtime)
        tick = runtime['tick']
        if first_tick is None:
            first_tick = tick
        if previous_tick is not None and tick < previous_tick:
            raise AssertionError(f'{context}: simulation tick went backwards: {status!r}')
        if tick != previous_tick:
            last_tick_change = now
        previous_tick = tick
        elapsed_ticks = tick - first_tick
        elapsed_wall = now - started
        timing = (
            f'ticks={elapsed_ticks}/{tick_budget}, wall={elapsed_wall:.2f}/{wall_timeout:.2f}s, '
            f'observed_ups={elapsed_ticks / max(elapsed_wall, 0.001):.1f}'
        )

        # Idle is not sufficient when another operation is still queued.
        if (status.get('task_state') == 'idle'
                and status.get('queue_empty') is True
                and status.get('queue_length') == 0):
            print(f'[npc-test] {context}: idle; {timing}', flush=True)
            return status
        if elapsed_ticks >= tick_budget:
            raise AssertionError(f'{context}: simulation tick budget exhausted; {timing}; last_status={status!r}')
        if elapsed_wall >= wall_timeout:
            raise AssertionError(f'{context}: wall-clock safety timeout; {timing}; last_status={status!r}')
        if now - last_tick_change >= 10.0:
            raise AssertionError(f'{context}: simulation clock stopped; {timing}; last_status={status!r}')
        time.sleep(0.1)
