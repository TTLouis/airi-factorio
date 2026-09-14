import copy
import unittest

from persistence_verify import assert_navigation_reached, assert_restarted


def before_state():
    return {
        'actor_id': 42,
        'force_index': 1,
        'inventory': {'iron-plate': 17, 'copper-plate': 13},
        'target_id': 90,
        'target_position': {'x': 30, 'y': 0},
    }


def after_state(**changes):
    value = {
        'runtime': {'tick': 500, 'tick_paused': False, 'speed': 1, 'connected_players': 0},
        'actor': {'valid': True, 'kind': 'standalone_character', 'actor_id': 42},
        'force_index': 1,
        'iron': 17,
        'copper': 13,
        'task_state': 'idle',
        'queue_empty': True,
        'queue_length': 0,
        'walking': False,
        'mining': False,
        'shooting': False,
        'target_alive': True,
        'load_reconciliation': {
            'policy': 'discard_autorio_tasks_and_stop_npc_controls_on_load',
            'pending': False,
            'last_actor_id': 42,
            'last_tick': 450,
        },
    }
    value.update(changes)
    return value


def reached_navigation(**result_changes):
    result = {
        'accepted': True,
        'completed': True,
        'code': 'reached',
        'actor_id': 42,
        'target_unit_number': 90,
    }
    result.update(result_changes)
    return {'task_active': False, 'last_result': result}


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.before = before_state()
        self.after = after_state()

    def test_same_body_inventory_force_and_reconciled_idle_state_pass(self):
        assert_restarted(self.before, self.after)

    def test_replacement_actor_force_or_inventory_change_does_not_pass(self):
        variants = []
        replaced = copy.deepcopy(self.after)
        replaced['actor']['actor_id'] = 99
        variants.append(replaced)
        variants.append(after_state(force_index=2))
        variants.append(after_state(iron=16))
        variants.append(after_state(copper=12))
        for value in variants:
            with self.subTest(value=value):
                with self.assertRaises(AssertionError):
                    assert_restarted(self.before, value)

    def test_connected_player_or_paused_world_does_not_pass(self):
        connected = copy.deepcopy(self.after)
        connected['runtime']['connected_players'] = 1
        paused = copy.deepcopy(self.after)
        paused['runtime']['tick_paused'] = True
        for value in [connected, paused]:
            with self.assertRaises(AssertionError):
                assert_restarted(self.before, value)

    def test_stale_controls_or_logical_work_do_not_pass(self):
        for change in [
            {'walking': True},
            {'mining': True},
            {'shooting': True},
            {'task_state': 'walking_direct'},
            {'queue_empty': False},
            {'queue_length': 1},
        ]:
            with self.subTest(change=change):
                with self.assertRaises(AssertionError):
                    assert_restarted(self.before, after_state(**change))

    def test_missing_or_pending_load_reconciliation_does_not_pass(self):
        missing = after_state(load_reconciliation={})
        pending = copy.deepcopy(self.after)
        pending['load_reconciliation']['pending'] = True
        wrong_actor = copy.deepcopy(self.after)
        wrong_actor['load_reconciliation']['last_actor_id'] = 99
        for value in [missing, pending, wrong_actor]:
            with self.assertRaises(AssertionError):
                assert_restarted(self.before, value)

    def test_missing_persisted_target_does_not_pass(self):
        with self.assertRaises(AssertionError):
            assert_restarted(self.before, after_state(target_alive=False))

    def test_post_restart_movement_requires_exact_reached_receipt(self):
        assert_navigation_reached(reached_navigation(), 42, 90)

        variants = [
            {'task_active': True, 'last_result': reached_navigation()['last_result']},
            reached_navigation(completed=False),
            reached_navigation(code='stuck', accepted=False, completed=False),
            reached_navigation(actor_id=99),
            reached_navigation(target_unit_number=91),
        ]
        for navigation in variants:
            with self.subTest(navigation=navigation), self.assertRaises(AssertionError):
                assert_navigation_reached(navigation, 42, 90)


if __name__ == '__main__':
    unittest.main()
