import copy
import unittest

from basic_outcomes import assert_failed_batch, assert_receipt

ACTOR_ID = 18


def status(code='completed', *, completed=True, accepted=True, op_type='waiting', actor_id=ACTOR_ID, operation_id=7):
    return {
        'task_state': 'idle',
        'queue_empty': True,
        'queue_length': 0,
        'runtime': {'tick': 100, 'tick_paused': False, 'speed': 1, 'connected_players': 0},
        'basic_operation': {
            'last_result': {
                'operation_id': operation_id,
                'type': op_type,
                'accepted': accepted,
                'completed': completed,
                'code': code,
                'actor_id': actor_id,
            },
        },
    }


class BasicOutcomeTests(unittest.TestCase):
    def test_exact_completed_receipt_passes(self):
        result = assert_receipt(status(), actor_id=ACTOR_ID, code='completed', completed=True, op_type='waiting')
        self.assertEqual(result['operation_id'], 7)

    def test_wrong_actor_code_state_or_missing_operation_id_fails(self):
        variants = []
        wrong_actor = status(actor_id=99)
        variants.append(wrong_actor)
        wrong_code = status(code='cancelled', completed=False, accepted=False)
        variants.append(wrong_code)
        active = status()
        active['task_state'] = 'waiting'
        variants.append(active)
        missing_id = status()
        missing_id['basic_operation']['last_result']['operation_id'] = None
        variants.append(missing_id)
        connected = status()
        connected['runtime']['connected_players'] = 1
        variants.append(connected)

        for candidate in variants:
            with self.subTest(candidate=candidate), self.assertRaises(AssertionError):
                if candidate['task_state'] != 'idle':
                    assert_failed_batch(candidate, actor_id=ACTOR_ID, code='completed', op_type='waiting')
                else:
                    assert_receipt(candidate, actor_id=ACTOR_ID, code='completed', completed=True, op_type='waiting')

    def test_failed_batch_requires_failure_receipt_and_empty_dependent_queue(self):
        failed = status('no_target', completed=False, accepted=False, op_type='mining')
        assert_failed_batch(failed, actor_id=ACTOR_ID, code='no_target', op_type='mining')

        for mutation in ('queue', 'accepted', 'completed', 'type'):
            candidate = copy.deepcopy(failed)
            if mutation == 'queue':
                candidate['queue_empty'] = False
                candidate['queue_length'] = 1
            elif mutation == 'accepted':
                candidate['basic_operation']['last_result']['accepted'] = True
            elif mutation == 'completed':
                candidate['basic_operation']['last_result']['completed'] = True
            else:
                candidate['basic_operation']['last_result']['type'] = 'waiting'
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError):
                assert_failed_batch(candidate, actor_id=ACTOR_ID, code='no_target', op_type='mining')


if __name__ == '__main__':
    unittest.main()
