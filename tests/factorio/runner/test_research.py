import copy
import unittest

from research import assert_actor, assert_completed


def observation(**changes):
    value = {
        'runtime': {'tick': 100, 'tick_paused': False, 'speed': 1, 'connected_players': 0},
        'actor': {'valid': True, 'kind': 'standalone_character', 'actor_id': 42},
        'force_index': 1, 'walking': False, 'mining': False, 'shooting': False,
        'task_state': 'idle', 'queue_empty': True, 'queue_length': 0, 'lab_ids': [2, 3, 4, 5],
        'required_science': 10, 'science': 10, 'researched': False, 'unlocked': False,
    }
    value.update(changes)
    return value


class ResearchTests(unittest.TestCase):
    def setUp(self):
        self.before = observation()
        self.after = observation(science=0, researched=True, unlocked=True)
        self.after['runtime']['tick'] = 2000

    def test_native_completion_with_science_and_unlock_passes(self):
        assert_completed(self.before, self.after, 42)

    def test_accepted_request_and_idle_actor_are_not_research_completion(self):
        self.after['researched'] = False
        self.after['last_request_result'] = {'accepted': True, 'code': 'started'}
        with self.assertRaises(AssertionError):
            assert_completed(self.before, self.after, 42)

    def test_science_or_recipe_without_the_other_does_not_pass(self):
        for changes in [{'science': 1}, {'unlocked': False}]:
            with self.subTest(changes=changes):
                after = {**self.after, **changes}
                with self.assertRaises(AssertionError):
                    assert_completed(self.before, after, 42)

    def test_precompleted_or_preunlocked_fixture_does_not_pass(self):
        for changes in [{'researched': True}, {'unlocked': True}, {'required_science': 0}, {'lab_ids': []}]:
            with self.subTest(changes=changes):
                with self.assertRaises(AssertionError):
                    assert_completed({**self.before, **changes}, self.after, 42)

    def test_replaced_labs_actor_or_force_do_not_pass(self):
        for changes in [
            {'lab_ids': [2, 3, 4, 6]}, {'force_index': 2},
            {'actor': {'valid': True, 'kind': 'standalone_character', 'actor_id': 99}},
        ]:
            with self.subTest(changes=changes):
                with self.assertRaises(AssertionError):
                    assert_completed(self.before, {**self.after, **changes}, 42)

    def test_no_simulation_or_connected_player_do_not_pass(self):
        for change in [{'tick': 100}, {'tick_paused': True}, {'connected_players': 1}]:
            after = copy.deepcopy(self.after)
            after['runtime'].update(change)
            with self.subTest(change=change):
                with self.assertRaises(AssertionError):
                    assert_completed(self.before, after, 42)

    def test_active_controls_or_queued_work_do_not_pass(self):
        for change in [{'walking': True}, {'mining': True}, {'shooting': True}, {'queue_length': 1}, {'queue_empty': False}]:
            with self.subTest(change=change):
                with self.assertRaises(AssertionError):
                    assert_completed(self.before, {**self.after, **change}, 42)

    def test_missing_physical_state_does_not_default_to_stopped(self):
        value = observation()
        del value['shooting']
        with self.assertRaises(KeyError):
            assert_actor(value, 42)


if __name__ == '__main__':
    unittest.main()
