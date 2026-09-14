import copy
import unittest

from combat import assert_kill, assert_stopped


def observation(**changes):
    value = {
        'runtime': {'tick': 100, 'tick_paused': False, 'speed': 1, 'connected_players': 0},
        'actor': {'valid': True, 'kind': 'standalone_character', 'actor_id': 42},
        'task_state': 'idle', 'queue_empty': True, 'queue_length': 0,
        'walking': False, 'mining': False, 'shooting': False,
        'actor_health': 250, 'ammo': 20, 'target_alive': True,
        'target_health': 15, 'target_id': 88, 'position': {'x': 0, 'y': 0},
    }
    value.update(changes)
    return value


class CombatTests(unittest.TestCase):
    def setUp(self):
        self.before = observation()
        self.after = observation(ammo=19, target_alive=False, target_health=0)
        self.after['runtime']['tick'] = 250
        self.combat = {
            'last_result': {
                'accepted': True,
                'completed': True,
                'code': 'target_destroyed',
                'target_unit_number': 88,
            },
        }

    def test_real_destroyed_target_with_ammo_use_passes(self):
        assert_kill(self.before, self.after, self.combat, 42)

    def test_idle_or_result_without_destroyed_target_does_not_pass(self):
        for change in [
            {'target_alive': True, 'target_health': 1},
            {'ammo': 20},
            {'actor_health': 0},
        ]:
            with self.subTest(change=change):
                with self.assertRaises(AssertionError):
                    assert_kill(self.before, {**self.after, **change}, self.combat, 42)

    def test_wrong_or_incomplete_result_does_not_pass(self):
        for result in [
            {'last_result': {'completed': False, 'code': 'started', 'target_unit_number': 88}},
            {'last_result': {'completed': True, 'code': 'no_target', 'target_unit_number': 88}},
            {'last_result': {'completed': True, 'code': 'target_destroyed', 'target_unit_number': 99}},
            {},
        ]:
            with self.subTest(result=result):
                with self.assertRaises(AssertionError):
                    assert_kill(self.before, self.after, result, 42)

    def test_replaced_actor_connected_player_or_paused_clock_do_not_pass(self):
        variants = []
        replaced = copy.deepcopy(self.after)
        replaced['actor']['actor_id'] = 99
        variants.append(replaced)
        connected = copy.deepcopy(self.after)
        connected['runtime']['connected_players'] = 1
        variants.append(connected)
        paused = copy.deepcopy(self.after)
        paused['runtime']['tick_paused'] = True
        variants.append(paused)
        no_time = copy.deepcopy(self.after)
        no_time['runtime']['tick'] = 100
        variants.append(no_time)
        for value in variants:
            with self.assertRaises(AssertionError):
                assert_kill(self.before, value, self.combat, 42)

    def test_idle_label_cannot_hide_active_controls_or_queue(self):
        for change in [
            {'walking': True}, {'mining': True}, {'shooting': True},
            {'queue_empty': False}, {'queue_length': 1}, {'task_state': 'attacking'},
        ]:
            with self.subTest(change=change):
                with self.assertRaises(AssertionError):
                    assert_stopped({**self.after, **change}, 42)


if __name__ == '__main__':
    unittest.main()
