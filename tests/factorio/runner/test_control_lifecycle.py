"""Deterministic checks for the lifecycle runner's acceptance assertions."""
import copy
import unittest

from control_lifecycle import assert_quiet_pair


def snapshot(tick: int, state: str = 'idle') -> dict:
    return {
        'runtime': {'tick': tick, 'tick_paused': False, 'speed': 1, 'connected_players': 0},
        'actor': {'actor_id': 1, 'kind': 'standalone_character', 'valid': True,
                  'position': {'x': 10, 'y': 0.5}},
        'task_state': state,
        'queue_empty': True,
        'queue_length': 0,
        'physical': {'walking': False, 'mining': False, 'not_shooting': True},
    }


class ControlLifecycleTests(unittest.TestCase):
    def test_stationary_idle_actor_passes(self):
        assert_quiet_pair(snapshot(10), snapshot(130), 1)

    def test_stationary_queued_wait_passes(self):
        assert_quiet_pair(snapshot(10, 'waiting'), snapshot(130, 'waiting'), 1, 'waiting')

    def test_idle_label_does_not_hide_active_controls(self):
        for field, value in [('walking', True), ('mining', True), ('not_shooting', False)]:
            with self.subTest(field=field):
                after = snapshot(130)
                after['physical'][field] = value
                with self.assertRaisesRegex(AssertionError, 'controls are still active'):
                    assert_quiet_pair(snapshot(10), after, 1)

    def test_position_drift_fails_even_with_idle_controls(self):
        after = snapshot(130)
        after['actor']['position']['x'] += 1
        with self.assertRaisesRegex(AssertionError, 'drifted'):
            assert_quiet_pair(snapshot(10), after, 1)

    def test_replacement_actor_does_not_pass(self):
        after = snapshot(130)
        after['actor']['actor_id'] = 2
        with self.assertRaisesRegex(AssertionError, 'actor changed'):
            assert_quiet_pair(snapshot(10), after, 1)

    def test_stationary_paused_world_does_not_pass(self):
        with self.assertRaisesRegex(AssertionError, 'advance independently'):
            assert_quiet_pair(snapshot(10), snapshot(11), 1)

    def test_remaining_queue_does_not_pass(self):
        after = snapshot(130)
        after['queue_empty'] = False
        after['queue_length'] = 1
        with self.assertRaisesRegex(AssertionError, 'queued work'):
            assert_quiet_pair(snapshot(10), after, 1)

    def test_missing_physical_diagnostics_do_not_default_to_stopped(self):
        before = snapshot(10)
        after = copy.deepcopy(before)
        after['runtime']['tick'] = 130
        del after['physical']['walking']
        with self.assertRaisesRegex(AssertionError, 'controls are still active'):
            assert_quiet_pair(before, after, 1)

    def test_connected_human_is_rejected(self):
        after = snapshot(130)
        after['runtime']['connected_players'] = 1
        with self.assertRaisesRegex(AssertionError, 'connected players'):
            assert_quiet_pair(snapshot(10), after, 1)


if __name__ == '__main__':
    unittest.main()
