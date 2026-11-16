"""Tests for what the node remembers between runs.

The state file is the reason a workflow does not have to carry the platform's
address and key forever, so it has to survive a round trip, and it has to
keep the values it already had when only some of them are new.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class StateFileTest(unittest.TestCase):
    """The state file is read back exactly as it was written."""

    def test_a_state_survives_a_round_trip(self):
        from dam_node.state import NodeState, load_state, save_state

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "state.json")
            save_state(
                NodeState(
                    platform_url="https://dam.example.com",
                    token="dam_key",
                    node_key="abc123",
                    node_id="node-7",
                ),
                path,
            )
            state = load_state(path)

        self.assertEqual(state.platform_url, "https://dam.example.com")
        self.assertEqual(state.token, "dam_key")
        self.assertEqual(state.node_key, "abc123")
        self.assertEqual(state.node_id, "node-7")

    def test_a_missing_file_is_an_empty_state_not_a_failure(self):
        """A node that has never run has nothing to remember — and that is
        a normal state, not an error."""
        from dam_node.state import load_state

        with tempfile.TemporaryDirectory() as directory:
            state = load_state(os.path.join(directory, "nothing-here.json"))

        self.assertEqual(state.platform_url, "")
        self.assertEqual(state.token, "")
        self.assertEqual(state.node_key, "")

    def test_merging_keeps_the_values_that_were_not_given(self):
        """The node key is known long before the platform id is — a later
        merge must not erase it."""
        from dam_node.state import NodeState

        state = NodeState(node_key="abc123", token="dam_key")
        merged = state.merged(node_id="node-7")

        self.assertEqual(merged.node_key, "abc123", "the identity must survive")
        self.assertEqual(merged.token, "dam_key", "the key must survive")
        self.assertEqual(merged.node_id, "node-7")

    def test_an_empty_value_does_not_overwrite(self):
        """The platform did not answer with an address — that is not a reason
        to forget the one that worked."""
        from dam_node.state import NodeState

        merged = NodeState(platform_url="https://dam.example.com").merged(
            platform_url=""
        )
        self.assertEqual(merged.platform_url, "https://dam.example.com")

    def test_the_file_is_written_for_its_owner_only(self):
        """The file holds a credential. On a POSIX system the mode is the
        only thing keeping another user on the machine out of it."""
        from dam_node.state import NodeState, save_state

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "state.json")
            save_state(NodeState(token="dam_key"), path)
            if os.name == "posix":
                mode = os.stat(path).st_mode & 0o777
                self.assertEqual(
                    mode, 0o600, f"the state file must not be readable by others (got {mode:o})"
                )

    def test_a_broken_file_is_reported_rather_than_ignored(self):
        """The user wrote that file. A typo in it is worth saying out loud."""
        from dam_node.state import load_state

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "state.json")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("{not json")
            with self.assertRaises(ValueError):
                load_state(path)


class EndpointResolutionTest(unittest.TestCase):
    """Where the address and the key come from, and in what order."""

    def test_the_workflow_wins_over_everything_else(self):
        from dam_node.config import DamConfig, resolve_endpoint
        from dam_node.state import NodeState

        url, key = resolve_endpoint(
            DamConfig(api_url="http://from-env", api_key="env-key"),
            NodeState(platform_url="http://from-state", token="state-key"),
            platform_url="http://from-workflow",
            token="workflow-key",
        )
        self.assertEqual(url, "http://from-workflow")
        self.assertEqual(key, "workflow-key")

    def test_the_remembered_values_beat_the_environment(self):
        """What the node proved to work beats what was configured once."""
        from dam_node.config import DamConfig, resolve_endpoint
        from dam_node.state import NodeState

        url, key = resolve_endpoint(
            DamConfig(api_url="http://from-env", api_key="env-key"),
            NodeState(platform_url="http://from-state", token="state-key"),
        )
        self.assertEqual(url, "http://from-state")
        self.assertEqual(key, "state-key")

    def test_the_environment_is_the_fallback(self):
        from dam_node.config import DamConfig, resolve_endpoint
        from dam_node.state import NodeState

        url, key = resolve_endpoint(
            DamConfig(api_url="http://from-env", api_key="env-key"), NodeState()
        )
        self.assertEqual(url, "http://from-env")
        self.assertEqual(key, "env-key")

    def test_the_trailing_slash_is_dropped(self):
        """A trailing slash would make the paths double up."""
        from dam_node.config import DamConfig, resolve_endpoint
        from dam_node.state import NodeState

        url, _ = resolve_endpoint(
            DamConfig(), NodeState(platform_url="https://dam.example.com/")
        )
        self.assertEqual(url, "https://dam.example.com")


class ConfigFileTest(unittest.TestCase):
    """The JSON file is the configuration for a node that never sees a shell."""

    def setUp(self):
        # The environment wins over the file, so a machine that has
        # `DAM_API_URL` exported would otherwise fail a test about the file.
        # The values are put back afterwards, so the rest of the run is not
        # affected.
        self.saved = {}
        for key in ("DAM_API_URL", "DAM_API_KEY", "DAM_TIMEOUT", "DAM_CONFIG"):
            self.saved[key] = os.environ.pop(key, None)
        self.addCleanup(self._restore)

    def _restore(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_config_falls_back_to_the_json_file(self):
        from dam_node.config import load_config

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "dam_config.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(
                    {"api_url": "http://127.0.0.1:9999", "api_key": "dam_from_file"},
                    handle,
                )
            config = load_config(path)

        self.assertEqual(config.api_url, "http://127.0.0.1:9999")
        self.assertEqual(config.api_key, "dam_from_file")

    def test_a_missing_address_is_not_an_error(self):
        """The node reports a missing address in words; it does not raise."""
        from dam_node.config import load_config

        with tempfile.TemporaryDirectory() as directory:
            config = load_config(os.path.join(directory, "nothing.json"))

        self.assertEqual(config.api_url, "")
        self.assertEqual(config.api_key, "")

    def test_a_broken_timeout_falls_back_instead_of_stopping_the_node(self):
        from dam_node.config import load_config

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "dam_config.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"timeout": "soon"}, handle)
            config = load_config(path)

        self.assertEqual(config.timeout, 30.0)


if __name__ == "__main__":
    unittest.main()
