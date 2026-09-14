import copy
import unittest

from crafting import assert_busy_preserved, assert_cancelled, assert_completed, assert_rejected


ACTOR_ID = 18


def observation(tick: int = 100, *, output: int = 0, native_queue: int = 0, native_recipe: str | None = None) -> dict:
    return {
        'task_state': 'idle',
        'queue_empty': True,
        'queue_length': 0,
        'queued_task_types': [],
        'actor': {'valid': True, 'kind': 'standalone_character', 'actor_id': ACTOR_ID},
        'runtime': {'tick': tick, 'tick_paused': False, 'speed': 1, 'connected_players': 0},
        'output_count': output,
        'native_queue_length': native_queue,
        'native_queue_recipe': native_recipe,
        'native_queue_count': native_queue,
    }


def completed_status(count: int = 3) -> dict:
    return {
        'task_active': False,
        'last_result': {
            'accepted': True,
            'completed': True,
            'code': 'completed',
            'actor_id': ACTOR_ID,
            'item_name': 'iron-gear-wheel',
            'requested_count': count,
            'started_count': count,
            'output_count_before': 0,
            'output_count_after': count,
            'native_queue_remaining': 0,
        },
    }


def busy_status() -> dict:
    return {
        'task_active': False,
        'last_result': {
            'accepted': False,
            'completed': False,
            'code': 'native_queue_busy',
            'actor_id': ACTOR_ID,
        },
    }


def cancelled_status() -> dict:
    return {
        'task_active': False,
        'last_result': {
            'accepted': False,
            'completed': False,
            'code': 'cancelled',
            'actor_id': ACTOR_ID,
        },
    }


class CraftingTests(unittest.TestCase):
    def test_real_output_and_completed_receipt_pass(self):
        before = observation(90, output=0)
        after = observation(120, output=3)
        assert_completed(before, after, completed_status(), ACTOR_ID, 'iron-gear-wheel', 3)

    def test_empty_queue_without_real_output_or_exact_receipt_does_not_pass(self):
        before = observation(90, output=0)
        cases = []

        no_output = observation(120, output=0)
        cases.append(('no output', no_output, completed_status()))

        wrong_code = completed_status()
        wrong_code['last_result']['code'] = 'output_missing'
        wrong_code['last_result']['accepted'] = False
        wrong_code['last_result']['completed'] = False
        cases.append(('wrong code', observation(120, output=3), wrong_code))

        wrong_actor = completed_status()
        wrong_actor['last_result']['actor_id'] = 99
        cases.append(('wrong actor', observation(120, output=3), wrong_actor))

        queue_left = observation(120, output=3, native_queue=1, native_recipe='iron-gear-wheel')
        cases.append(('native queue remains', queue_left, completed_status()))

        for name, after, status in cases:
            with self.subTest(name=name), self.assertRaises(AssertionError):
                assert_completed(before, after, status, ACTOR_ID, 'iron-gear-wheel', 3)

    def test_connected_player_paused_clock_or_autorio_work_does_not_pass_completion(self):
        before = observation(90, output=0)
        variants = []
        connected = observation(120, output=3)
        connected['runtime']['connected_players'] = 1
        variants.append(connected)
        paused = observation(120, output=3)
        paused['runtime']['tick_paused'] = True
        variants.append(paused)
        active = observation(120, output=3)
        active['task_state'] = 'crafting'
        variants.append(active)
        queued = observation(120, output=3)
        queued['queue_empty'] = False
        queued['queue_length'] = 1
        variants.append(queued)

        for after in variants:
            with self.assertRaises(AssertionError):
                assert_completed(before, after, completed_status(), ACTOR_ID, 'iron-gear-wheel', 3)

    def test_busy_native_queue_is_preserved(self):
        before = observation(100, native_queue=500, native_recipe='copper-cable')
        after = observation(101, native_queue=499, native_recipe='copper-cable')
        assert_busy_preserved(before, after, busy_status(), ACTOR_ID)

    def test_busy_queue_disappearance_or_recipe_replacement_does_not_pass(self):
        before = observation(100, native_queue=500, native_recipe='copper-cable')
        for after in [
            observation(101, native_queue=0),
            observation(101, native_queue=499, native_recipe='iron-gear-wheel'),
        ]:
            with self.assertRaises(AssertionError):
                assert_busy_preserved(before, after, busy_status(), ACTOR_ID)

    def test_owned_queue_cancellation_passes_only_with_empty_native_and_autorio_queues(self):
        before = observation(100, output=1, native_queue=1, native_recipe='iron-gear-wheel')
        before['task_state'] = 'crafting'
        before['queue_empty'] = False
        before['queue_length'] = 1
        before['queued_task_types'] = ['waiting']
        after = observation(101, output=1)
        assert_cancelled(before, after, cancelled_status(), ACTOR_ID)

        for mutate in ('native', 'autorio', 'receipt'):
            bad_after = copy.deepcopy(after)
            bad_status = cancelled_status()
            if mutate == 'native':
                bad_after['native_queue_length'] = 1
            elif mutate == 'autorio':
                bad_after['queue_empty'] = False
                bad_after['queue_length'] = 1
            else:
                bad_status['last_result']['code'] = 'completed'
                bad_status['last_result']['accepted'] = True
                bad_status['last_result']['completed'] = True
            with self.subTest(mutate=mutate), self.assertRaises(AssertionError):
                assert_cancelled(before, bad_after, bad_status, ACTOR_ID)

    def test_rejections_require_exact_failure_code_and_actor(self):
        for code in ('not_enough_ingredients', 'recipe_unavailable', 'invalid_count'):
            status = {
                'task_active': False,
                'last_result': {
                    'accepted': False,
                    'completed': False,
                    'code': code,
                    'actor_id': ACTOR_ID,
                },
            }
            assert_rejected(status, ACTOR_ID, code)

            wrong = copy.deepcopy(status)
            wrong['last_result']['actor_id'] = 99
            with self.assertRaises(AssertionError):
                assert_rejected(wrong, ACTOR_ID, code)


if __name__ == '__main__':
    unittest.main()
