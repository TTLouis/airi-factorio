import copy
import unittest

from navigation import assert_passive_belt_displacement, assert_reached, assert_unreachable


ACTOR_ID = 18
TARGET_ID = 44


def observation(tick: int = 100, *, target_alive: bool = True) -> dict:
    return {
        'task_state': 'idle',
        'queue_empty': True,
        'queue_length': 0,
        'queued_task_types': [],
        'actor': {
            'kind': 'standalone_character',
            'valid': True,
            'actor_id': ACTOR_ID,
        },
        'runtime': {
            'tick': tick,
            'tick_paused': False,
            'speed': 1,
            'connected_players': 0,
        },
        'walking': False,
        'mining': False,
        'shooting': False,
        'position': {'x': 8.0, 'y': 0.0},
        'target_id': TARGET_ID,
        'target_alive': target_alive,
        'target_position': {'x': 10.0, 'y': 0.0},
    }


def reached_result(*, attempts: int = 1) -> dict:
    return {
        'task_active': False,
        'last_result': {
            'accepted': True,
            'completed': True,
            'code': 'reached',
            'actor_id': ACTOR_ID,
            'target_unit_number': TARGET_ID,
            'path_attempts': attempts,
        },
    }


def unreachable_result() -> dict:
    return {
        'task_active': False,
        'last_result': {
            'accepted': False,
            'completed': False,
            'code': 'unreachable',
            'actor_id': ACTOR_ID,
            'target_unit_number': TARGET_ID,
            'path_attempts': 1,
        },
    }


class NavigationTests(unittest.TestCase):
    def test_real_reached_target_passes(self):
        before = observation(90)
        after = observation(120)
        assert_reached(before, after, reached_result(), ACTOR_ID, TARGET_ID)

    def test_repath_requirement_uses_attempt_count(self):
        before = observation(90)
        after = observation(120)
        with self.assertRaises(AssertionError):
            assert_reached(before, after, reached_result(attempts=1), ACTOR_ID, TARGET_ID, minimum_attempts=2)
        assert_reached(before, after, reached_result(attempts=2), ACTOR_ID, TARGET_ID, minimum_attempts=2)

    def test_idle_without_verified_reached_result_does_not_pass(self):
        before = observation(90)
        after = observation(120)
        for change in [
            {'task_active': True},
            {'last_result': {'accepted': True, 'completed': False, 'code': 'started', 'actor_id': ACTOR_ID, 'target_unit_number': TARGET_ID, 'path_attempts': 1}},
            {'last_result': {'accepted': False, 'completed': False, 'code': 'unreachable', 'actor_id': ACTOR_ID, 'target_unit_number': TARGET_ID, 'path_attempts': 1}},
        ]:
            bad = reached_result()
            bad.update(change)
            with self.subTest(change=change), self.assertRaises(AssertionError):
                assert_reached(before, after, bad, ACTOR_ID, TARGET_ID)

    def test_wrong_actor_target_or_distance_do_not_pass(self):
        before = observation(90)
        for mutate in ('actor', 'target', 'distance'):
            after = observation(120)
            result = reached_result()
            if mutate == 'actor':
                after['actor']['actor_id'] = 99
            elif mutate == 'target':
                result['last_result']['target_unit_number'] = 99
            else:
                after['position'] = {'x': 0.0, 'y': 0.0}
            with self.subTest(mutate=mutate), self.assertRaises(AssertionError):
                assert_reached(before, after, result, ACTOR_ID, TARGET_ID)

    def test_connected_player_paused_clock_or_active_controls_do_not_pass(self):
        before = observation(90)
        for key, value in [
            ('connected_players', 1),
            ('tick_paused', True),
        ]:
            after = observation(120)
            after['runtime'][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                assert_reached(before, after, reached_result(), ACTOR_ID, TARGET_ID)

        for key in ('walking', 'mining', 'shooting'):
            after = observation(120)
            after[key] = True
            with self.subTest(key=key), self.assertRaises(AssertionError):
                assert_reached(before, after, reached_result(), ACTOR_ID, TARGET_ID)

    def test_explicit_unreachable_with_live_target_passes(self):
        before = observation(90)
        after = observation(120)
        after['position'] = {'x': 0.0, 'y': 0.0}
        after['target_position'] = {'x': 20.0, 'y': 0.0}
        assert_unreachable(before, after, unreachable_result(), ACTOR_ID, TARGET_ID)

    def test_unreachable_requires_live_target_empty_queue_and_exact_code(self):
        before = observation(90)
        base = observation(120)
        base['position'] = {'x': 0.0, 'y': 0.0}
        base['target_position'] = {'x': 20.0, 'y': 0.0}

        cases = []
        dead = copy.deepcopy(base)
        dead['target_alive'] = False
        cases.append(('dead target', dead, unreachable_result()))
        queued = copy.deepcopy(base)
        queued['queue_empty'] = False
        queued['queue_length'] = 1
        cases.append(('queued dependency', queued, unreachable_result()))
        wrong = unreachable_result()
        wrong['last_result']['code'] = 'reached'
        wrong['last_result']['accepted'] = True
        wrong['last_result']['completed'] = True
        cases.append(('wrong result', copy.deepcopy(base), wrong))

        for name, after, result in cases:
            with self.subTest(name=name), self.assertRaises(AssertionError):
                assert_unreachable(before, after, result, ACTOR_ID, TARGET_ID)

    def test_stopped_npc_can_be_passively_displaced_by_transport_belt(self):
        before = observation(100)
        before['belt_count'] = 1
        after = observation(220)
        after['belt_count'] = 1
        after['position'] = {'x': 10.0, 'y': 0.0}

        assert_passive_belt_displacement(before, after, ACTOR_ID)

    def test_belt_displacement_requires_released_controls_and_real_motion(self):
        base = observation(100)
        base['belt_count'] = 1

        no_motion = observation(220)
        no_motion['belt_count'] = 1
        with self.assertRaises(AssertionError):
            assert_passive_belt_displacement(base, no_motion, ACTOR_ID)

        walking = observation(220)
        walking['belt_count'] = 1
        walking['position'] = {'x': 10.0, 'y': 0.0}
        walking['walking'] = True
        with self.assertRaises(AssertionError):
            assert_passive_belt_displacement(base, walking, ACTOR_ID)

        off_belt = observation(220)
        off_belt['belt_count'] = 0
        off_belt['position'] = {'x': 10.0, 'y': 0.0}
        with self.assertRaises(AssertionError):
            assert_passive_belt_displacement(base, off_belt, ACTOR_ID)


if __name__ == '__main__':
    unittest.main()
