"""Deterministic runner regressions; no Factorio or provider requests."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from runtime import CLOCK_COMMAND, operation_status_command, verify_free_running_ticks, wait_until_idle


def clock_snapshot(tick: int, *, paused: bool = False, players: int = 0) -> dict:
    return {'tick': tick, 'tick_paused': paused, 'speed': 1, 'connected_players': players}


def task_snapshot(tick: int, *, idle: bool = False, queued: int = 0) -> dict:
    return {
        'task_state': 'idle' if idle else 'mining',
        'queue_empty': queued == 0,
        'queue_length': queued,
        'runtime': clock_snapshot(tick),
    }


class RuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = 0.0
        monotonic = patch('runtime.time.monotonic', side_effect=lambda: self.now)
        sleep = patch('runtime.time.sleep', side_effect=self.advance)
        monotonic.start()
        sleep.start()
        self.addCleanup(monotonic.stop)
        self.addCleanup(sleep.stop)

    def advance(self, seconds: float) -> None:
        self.now += seconds

    def test_free_running_world_passes_with_only_two_rcon_observations(self) -> None:
        command = Mock(side_effect=[json.dumps(clock_snapshot(100)), json.dumps(clock_snapshot(220))])
        with tempfile.TemporaryDirectory() as directory:
            result = verify_free_running_ticks(command, Path(directory))
            self.assertEqual(result['status'], 'pass')
            self.assertEqual(result['advanced_ticks'], 120)
            self.assertEqual(result['observed_ups'], 60)
            self.assertTrue((Path(directory) / 'simulation-clock.json').exists())
        self.assertEqual(command.call_count, 2)
        self.assertEqual([call.args[0] for call in command.call_args_list], [CLOCK_COMMAND, CLOCK_COMMAND])

    def test_one_tick_per_rcon_fails_even_when_tick_paused_is_false(self) -> None:
        command = Mock(side_effect=[json.dumps(clock_snapshot(100)), json.dumps(clock_snapshot(101))])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(AssertionError, 'independently of RCON'):
                verify_free_running_ticks(command, Path(directory))
            saved = json.loads((Path(directory) / 'simulation-clock.json').read_text())
            self.assertEqual(saved['status'], 'fail')
            self.assertEqual(saved['advanced_ticks'], 1)

    def test_explicit_entity_pause_fails(self) -> None:
        command = Mock(side_effect=[
            json.dumps(clock_snapshot(100, paused=True)),
            json.dumps(clock_snapshot(100, paused=True)),
        ])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(AssertionError, 'entity updates are paused'):
                verify_free_running_ticks(command, Path(directory))

    def test_slow_wall_clock_does_not_exhaust_simulation_budget(self) -> None:
        samples = iter([(0, task_snapshot(100)), (20, task_snapshot(110)), (20, task_snapshot(120, idle=True))])

        def read_status(_context: str) -> dict:
            delay, snapshot = next(samples)
            self.advance(delay)
            return snapshot

        result = wait_until_idle(read_status, 'slow mining', timeout=1, wall_timeout=120)
        self.assertEqual(result['task_state'], 'idle')
        self.assertGreater(self.now, 40)

    def test_simulation_tick_budget_still_fails_a_stuck_task(self) -> None:
        reader = Mock(side_effect=[task_snapshot(100), task_snapshot(161)])
        with self.assertRaisesRegex(AssertionError, 'simulation tick budget exhausted'):
            wait_until_idle(reader, 'stuck mining', timeout=1, wall_timeout=120)

    def test_wall_safety_cap_is_not_reset_by_progress(self) -> None:
        samples = iter([task_snapshot(100), task_snapshot(101)])

        def read_status(_context: str) -> dict:
            self.advance(1)
            return next(samples)

        with self.assertRaisesRegex(AssertionError, 'wall-clock safety timeout'):
            wait_until_idle(read_status, 'slow mining', timeout=60, wall_timeout=1.5)

    def test_clock_that_stops_has_its_own_diagnostic(self) -> None:
        reader = Mock(return_value=task_snapshot(100))
        with self.assertRaisesRegex(AssertionError, 'simulation clock stopped'):
            wait_until_idle(reader, 'stopped server', timeout=60, wall_timeout=120)

    def test_idle_does_not_pass_with_queued_work(self) -> None:
        reader = Mock(side_effect=[task_snapshot(100, idle=True, queued=1), task_snapshot(101, idle=True)])
        result = wait_until_idle(reader, 'queue drain', wall_timeout=120)
        self.assertEqual(reader.call_count, 2)
        self.assertEqual(result['queue_length'], 0)

    def test_tick_rewind_is_not_treated_as_more_available_time(self) -> None:
        reader = Mock(side_effect=[task_snapshot(100), task_snapshot(99)])
        with self.assertRaisesRegex(AssertionError, 'tick went backwards'):
            wait_until_idle(reader, 'map changed', wall_timeout=120)

    def test_missing_clock_does_not_fall_back_to_wall_only_wait(self) -> None:
        reader = Mock(return_value={'task_state': 'idle', 'queue_empty': True, 'queue_length': 0})
        with self.assertRaisesRegex(AssertionError, 'invalid simulation tick'):
            wait_until_idle(reader, 'missing telemetry', wall_timeout=120)

    def test_connected_player_fails_even_if_task_is_idle(self) -> None:
        snapshot = task_snapshot(100, idle=True)
        snapshot['runtime']['connected_players'] = 1
        with self.assertRaisesRegex(AssertionError, 'connected players'):
            wait_until_idle(Mock(return_value=snapshot), 'human joined', wall_timeout=120)

    def test_invalid_wall_timeout_cannot_create_unbounded_wait(self) -> None:
        for value in ('nan', 'inf', '0', '-1'):
            with self.subTest(value=value), patch.dict('os.environ', {'NPC_TEST_WALL_TIMEOUT': value}):
                with self.assertRaises(ValueError):
                    wait_until_idle(Mock(), 'invalid timeout')

    def test_status_observation_adds_engine_clock(self) -> None:
        command = operation_status_command()
        self.assertIn("remote.call('autorio_operations','status')", command)
        self.assertIn('tick=game.tick', command)
        self.assertIn('tick_paused=game.tick_paused', command)
        self.assertIn('connected_players=#game.connected_players', command)

    def test_server_fixture_disables_auto_pause_and_public_discovery(self) -> None:
        root = Path(__file__).resolve().parents[1]
        settings = json.loads((root / 'fixtures/server-settings.json').read_text())
        self.assertIs(settings['auto_pause'], False)
        self.assertIs(settings['auto_pause_when_players_connect'], False)
        self.assertEqual(settings['visibility'], {'public': False, 'lan': False})
        self.assertIn('--server-settings "$SERVER_SETTINGS"', (root / 'run.sh').read_text())


if __name__ == '__main__':
    unittest.main()
