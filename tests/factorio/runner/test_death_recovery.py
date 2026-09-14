import copy
import unittest

from death_recovery import assert_navigation_reached, assert_recovered


def observation(**changes):
    value = {
        'runtime': {'tick': 200, 'tick_paused': False, 'speed': 1, 'connected_players': 0},
        'actor': {'valid': True, 'kind': 'standalone_character', 'actor_id': 99},
        'task_state': 'idle',
        'queue_empty': True,
        'queue_length': 0,
        'queued_task_types': [],
        'walking': False,
        'mining': False,
        'shooting': False,
        'force_index': 1,
        'character_count': 1,
        'old_actor_alive': False,
        'old_target_alive': True,
        'iron': 0,
        'copper': 0,
        'death_recovery': {
            'policy': 'discard_autorio_tasks_and_create_empty_replacement',
            'last_result': {
                'reason': 'missing_persisted_actor',
                'previous_actor_id': 42,
                'replacement_actor_id': 99,
                'force_index': 1,
                'tick': 150,
                'inventory_policy': 'no_transfer',
            },
        },
    }
    value.update(changes)
    return value


def before_observation():
    return {
        'runtime': {'tick': 100, 'tick_paused': False, 'speed': 1, 'connected_players': 0},
        'actor': {'valid': True, 'kind': 'standalone_character', 'actor_id': 42},
        'force_index': 1,
        'iron': 23,
        'copper': 11,
    }


def reached_navigation(**result_changes):
    result = {
        'accepted': True,
        'completed': True,
        'code': 'reached',
        'actor_id': 99,
        'target_unit_number': 123,
    }
    result.update(result_changes)
    return {'task_active': False, 'last_result': result}


class DeathRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.before = before_observation()
        self.after = observation()

    def test_replacement_with_discarded_work_and_no_inventory_transfer_passes(self):
        assert_recovered(self.before, self.after)

    def test_same_actor_or_copied_inventory_does_not_pass(self):
        for change in [
            {'actor': {'valid': True, 'kind': 'standalone_character', 'actor_id': 42}},
            {'iron': 23},
            {'copper': 11},
        ]:
            with self.subTest(change=change):
                with self.assertRaises(AssertionError):
                    assert_recovered(self.before, {**self.after, **change})

    def test_stale_task_queue_or_controls_do_not_pass(self):
        for change in [
            {'task_state': 'walking_to_entity'},
            {'queue_empty': False, 'queue_length': 1, 'queued_task_types': ['waiting']},
            {'walking': True},
            {'mining': True},
            {'shooting': True},
        ]:
            with self.subTest(change=change):
                with self.assertRaises(AssertionError):
                    assert_recovered(self.before, {**self.after, **change})

    def test_old_body_target_or_character_count_must_be_consistent(self):
        for change in [
            {'old_actor_alive': True},
            {'old_target_alive': False},
            {'character_count': 2},
        ]:
            with self.subTest(change=change):
                with self.assertRaises(AssertionError):
                    assert_recovered(self.before, {**self.after, **change})

    def test_recovery_receipt_must_bind_old_and_new_actor_identity(self):
        variants = []
        for field, value in [
            ('previous_actor_id', 41),
            ('replacement_actor_id', 100),
            ('force_index', 2),
            ('inventory_policy', 'copy'),
            ('reason', 'unknown'),
        ]:
            after = copy.deepcopy(self.after)
            after['death_recovery']['last_result'][field] = value
            variants.append(after)
        pending = copy.deepcopy(self.after)
        pending['death_recovery']['pending_from_actor_id'] = 42
        variants.append(pending)
        missing = copy.deepcopy(self.after)
        missing['death_recovery'] = {}
        variants.append(missing)

        for after in variants:
            with self.subTest(after=after):
                with self.assertRaises(AssertionError):
                    assert_recovered(self.before, after)

    def test_connected_human_replaced_force_or_stopped_clock_do_not_pass(self):
        variants = []
        connected = copy.deepcopy(self.after)
        connected['runtime']['connected_players'] = 1
        variants.append(connected)
        wrong_force = copy.deepcopy(self.after)
        wrong_force['force_index'] = 2
        variants.append(wrong_force)
        paused = copy.deepcopy(self.after)
        paused['runtime']['tick_paused'] = True
        variants.append(paused)
        no_time = copy.deepcopy(self.after)
        no_time['runtime']['tick'] = 100
        variants.append(no_time)

        for after in variants:
            with self.subTest(after=after):
                with self.assertRaises(AssertionError):
                    assert_recovered(self.before, after)

    def test_fresh_replacement_movement_requires_exact_reached_receipt(self):
        assert_navigation_reached(reached_navigation(), 99, 123)

        variants = [
            {'task_active': True, 'last_result': reached_navigation()['last_result']},
            reached_navigation(completed=False),
            reached_navigation(code='unreachable', accepted=False, completed=False),
            reached_navigation(actor_id=42),
            reached_navigation(target_unit_number=124),
        ]
        for navigation in variants:
            with self.subTest(navigation=navigation), self.assertRaises(AssertionError):
                assert_navigation_reached(navigation, 99, 123)


if __name__ == '__main__':
    unittest.main()
